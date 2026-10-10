/**
 * Payment/event providers that may call the API directly (public ingress, no BFF, no user):
 * each one gets a `@WebhookIngress(provider)` route and a guard tagged
 * `@VerifiesWebhookSignature(provider)` (commerce & enrollment design §9).
 */
export const WEBHOOK_PROVIDERS = ['stripe'] as const;

export type WebhookProvider = (typeof WEBHOOK_PROVIDERS)[number];

const PROVIDER_SET: ReadonlySet<string> = new Set(WEBHOOK_PROVIDERS);

export function isWebhookProvider(value: unknown): value is WebhookProvider {
  return typeof value === 'string' && PROVIDER_SET.has(value);
}
