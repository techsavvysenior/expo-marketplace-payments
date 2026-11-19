import { PaymentDeclinedError, ProviderUnavailableError } from '../errors.ts';
import { Money } from '../money.ts';
import { decimalToCents, PayPalClient } from '../paypal/paypal-client.ts';

type Call = { url: string; init: RequestInit };

function fakePayPal(routes: Record<string, () => Response>) {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const route = Object.keys(routes).find((path) => url.endsWith(path));
    if (!route) throw new Error(`Unexpected request ${url}`);
    return routes[route]();
  }) as typeof fetch;
  return { calls, fetchFn };
}

const tokenResponse = () => Response.json({ access_token: 'A21', expires_in: 32400 });

describe('PayPalClient', () => {
  it('gets a token with Basic auth and caches it', async () => {
    const { calls, fetchFn } = fakePayPal({ '/v1/oauth2/token': tokenResponse });
    const client = new PayPalClient({ clientId: 'id', clientSecret: 'secret', environment: 'sandbox', fetch: fetchFn });

    await client.accessToken();
    await client.accessToken();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api-m.sandbox.paypal.com/v1/oauth2/token');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa('id:secret')}`);
    expect(calls[0].init.body).toBe('grant_type=client_credentials');
  });

  it('refreshes the token a minute before it expires', async () => {
    let now = 0;
    const { calls, fetchFn } = fakePayPal({ '/v1/oauth2/token': () => Response.json({ access_token: 'A21', expires_in: 120 }) });
    const client = new PayPalClient({ clientId: 'id', clientSecret: 's', environment: 'live', fetch: fetchFn, now: () => now });

    await client.accessToken();
    now = 61_000;
    await client.accessToken();

    expect(calls).toHaveLength(2);
    expect(calls[0].url.startsWith('https://api-m.paypal.com')).toBe(true);
  });

  it('creates a CAPTURE order tagged with our order id and returns the approval link', async () => {
    const { calls, fetchFn } = fakePayPal({
      '/v1/oauth2/token': tokenResponse,
      '/v2/checkout/orders': () =>
        Response.json({
          id: 'PP-1',
          status: 'PAYER_ACTION_REQUIRED',
          links: [{ href: 'https://www.sandbox.paypal.com/checkoutnow?token=PP-1', rel: 'payer-action' }],
        }),
    });
    const client = new PayPalClient({ clientId: 'id', clientSecret: 's', environment: 'sandbox', fetch: fetchFn });

    const created = await client.createOrder({
      ourOrderId: 'order-1',
      amount: Money.of(2500, 'USD'),
      returnUrl: 'marketplace://paypal/return',
      cancelUrl: 'marketplace://paypal/cancel',
      brandName: 'Marketplace',
    });

    expect(created).toEqual({ id: 'PP-1', approveUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=PP-1' });
    const body = JSON.parse(calls[1].init.body as string);
    expect(body.intent).toBe('CAPTURE');
    expect(body.purchase_units[0]).toEqual({
      reference_id: 'order-1',
      custom_id: 'order-1',
      amount: { currency_code: 'USD', value: '25.00' },
    });
    expect(body.payment_source.paypal.experience_context.return_url).toBe('marketplace://paypal/return');
    expect((calls[1].init.headers as Record<string, string>)['PayPal-Request-Id']).toBe('create-order-1');
  });

  it('captures and returns the amount PayPal actually took', async () => {
    const { fetchFn } = fakePayPal({
      '/v1/oauth2/token': tokenResponse,
      '/capture': () =>
        Response.json({
          id: 'PP-1',
          status: 'COMPLETED',
          purchase_units: [
            {
              reference_id: 'order-1',
              payments: { captures: [{ id: 'CAP-1', status: 'COMPLETED', custom_id: 'order-1', amount: { currency_code: 'USD', value: '25.00' } }] },
            },
          ],
        }),
    });
    const client = new PayPalClient({ clientId: 'id', clientSecret: 's', environment: 'sandbox', fetch: fetchFn });

    const captured = await client.captureOrder('PP-1');

    expect(captured.captureId).toBe('CAP-1');
    expect(captured.ourOrderId).toBe('order-1');
    expect(captured.amount.equals(Money.of(2500, 'USD'))).toBe(true);
  });

  it('turns a 422 into a decline with PayPal reason', async () => {
    const { fetchFn } = fakePayPal({
      '/v1/oauth2/token': tokenResponse,
      '/capture': () => Response.json({ details: [{ issue: 'INSTRUMENT_DECLINED', description: 'The instrument was declined.' }] }, { status: 422 }),
    });
    const client = new PayPalClient({ clientId: 'id', clientSecret: 's', environment: 'sandbox', fetch: fetchFn });
    await expect(client.captureOrder('PP-1')).rejects.toEqual(new PaymentDeclinedError('The instrument was declined.'));
  });

  it('turns a network failure or 5xx into provider unavailable', async () => {
    const offline = new PayPalClient({
      clientId: 'id',
      clientSecret: 's',
      environment: 'sandbox',
      fetch: (async () => { throw new TypeError('Network request failed'); }) as typeof fetch,
    });
    await expect(offline.accessToken()).rejects.toBeInstanceOf(ProviderUnavailableError);

    const { fetchFn } = fakePayPal({ '/v1/oauth2/token': () => new Response('oops', { status: 503 }) });
    const down = new PayPalClient({ clientId: 'id', clientSecret: 's', environment: 'sandbox', fetch: fetchFn });
    await expect(down.accessToken()).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

describe('decimalToCents', () => {
  it('converts without floating point', () => {
    expect(decimalToCents('25.00')).toBe(2500);
    expect(decimalToCents('0.1')).toBe(10);
    expect(decimalToCents('19.99')).toBe(1999);
    expect(decimalToCents('7')).toBe(700);
    expect(() => decimalToCents('1.234')).toThrow(RangeError);
  });
});
