/**
 * The one-click unsubscribe token format (design D14, §14) lives in `@udemy/nest-common/unsubscribe`,
 * shared with the worker that signs the tokens into notification e-mails, so the two can never
 * drift. Re-exported here for the notifications module's port, use case and test fakes.
 */
export {
  formatUnsubscribeToken,
  type ParsedUnsubscribeToken,
  parseUnsubscribeToken,
  UNSUBSCRIBE_TOKEN_VERSION,
  type UnsubscribeTokenClaims,
  unsubscribeMacInput,
} from '@udemy/nest-common/unsubscribe';
