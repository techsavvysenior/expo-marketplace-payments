import { PaymentDeclinedError, ProviderUnavailableError } from '../errors.ts';
import { Money } from '../money.ts';

/**
 * Minimal PayPal Orders v2 client, server-side only (it holds the secret).
 *
 * Endpoints (checked Nov 2026):
 *  - POST /v1/oauth2/token          client_credentials, Basic auth
 *  - POST /v2/checkout/orders       create, returns a "payer-action" link
 *  - POST /v2/checkout/orders/{id}/capture
 * https://developer.paypal.com/api/rest/integration/orders-api/api-use-cases/standard/
 */

export type PayPalEnvironment = 'sandbox' | 'live';

const BASE_URL: Record<PayPalEnvironment, string> = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
};

export type CreatedPayPalOrder = { id: string; approveUrl: string };

export type CapturedPayPalOrder = {
  paypalOrderId: string;
  status: string;
  captureId: string;
  amount: Money;
  /** Our order id, echoed back from custom_id. */
  ourOrderId: string;
};

type PayPalLink = { href: string; rel: string };

export class PayPalClient {
  private token?: { value: string; expiresAt: number };

  constructor(
    private readonly config: {
      clientId: string;
      clientSecret: string;
      environment: PayPalEnvironment;
      fetch?: typeof fetch;
      now?: () => number;
    },
  ) {}

  private get baseUrl(): string {
    return BASE_URL[this.config.environment];
  }

  private get now(): number {
    return (this.config.now ?? Date.now)();
  }

  /** Cached until a minute before it expires. */
  async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now) return this.token.value;

    const credentials = btoa(`${this.config.clientId}:${this.config.clientSecret}`);
    const response = await this.request('/v1/oauth2/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const json = (await response.json()) as { access_token: string; expires_in: number };
    this.token = { value: json.access_token, expiresAt: this.now + (json.expires_in - 60) * 1000 };
    return json.access_token;
  }

  async createOrder(input: {
    ourOrderId: string;
    amount: Money;
    returnUrl: string;
    cancelUrl: string;
    brandName: string;
  }): Promise<CreatedPayPalOrder> {
    const response = await this.authorized('/v2/checkout/orders', {
      method: 'POST',
      // Same order id, same PayPal order: safe to retry.
      headers: { 'PayPal-Request-Id': `create-${input.ourOrderId}` },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: input.ourOrderId,
            custom_id: input.ourOrderId,
            amount: { currency_code: input.amount.currency, value: input.amount.toDecimalString() },
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: input.brandName,
              user_action: 'PAY_NOW',
              shipping_preference: 'GET_FROM_FILE',
              return_url: input.returnUrl,
              cancel_url: input.cancelUrl,
            },
          },
        },
      }),
    });
    const json = (await response.json()) as { id: string; links: PayPalLink[] };
    const approve = json.links.find((link) => link.rel === 'payer-action' || link.rel === 'approve');
    if (!approve) throw new ProviderUnavailableError('PayPal');
    return { id: json.id, approveUrl: approve.href };
  }

  async captureOrder(paypalOrderId: string): Promise<CapturedPayPalOrder> {
    const response = await this.authorized(`/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {
      method: 'POST',
      headers: { 'PayPal-Request-Id': `capture-${paypalOrderId}` },
      body: '{}',
    });
    const json = (await response.json()) as {
      id: string;
      status: string;
      purchase_units: {
        reference_id?: string;
        payments?: {
          captures?: {
            id: string;
            status: string;
            custom_id?: string;
            amount: { currency_code: string; value: string };
          }[];
        };
      }[];
    };

    const capture = json.purchase_units[0]?.payments?.captures?.[0];
    if (!capture || capture.status === 'DECLINED' || capture.status === 'FAILED') {
      throw new PaymentDeclinedError('PayPal declined the payment.');
    }
    return {
      paypalOrderId: json.id,
      status: capture.status,
      captureId: capture.id,
      amount: Money.of(decimalToCents(capture.amount.value), capture.amount.currency_code),
      ourOrderId: capture.custom_id ?? json.purchase_units[0]?.reference_id ?? '',
    };
  }

  private async authorized(path: string, init: RequestInit & { headers?: Record<string, string> }): Promise<Response> {
    const token = await this.accessToken();
    return this.request(path, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await (this.config.fetch ?? fetch)(`${this.baseUrl}${path}`, init);
    } catch (error) {
      throw new ProviderUnavailableError('PayPal', { cause: error });
    }
    if (response.status === 422) {
      const body = (await response.json().catch(() => ({}))) as { details?: { issue?: string; description?: string }[] };
      throw new PaymentDeclinedError(body.details?.[0]?.description ?? body.details?.[0]?.issue);
    }
    if (!response.ok) {
      throw new ProviderUnavailableError('PayPal', { cause: new Error(`${response.status} ${await response.text()}`) });
    }
    return response;
  }
}

/** "12.50" -> 1250, without floating point. */
export function decimalToCents(value: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new RangeError(`Not a money amount: ${value}`);
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}
