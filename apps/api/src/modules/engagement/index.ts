// Public facade of the engagement context: the only file other modules may import.
// Engagement has no in-process consumers (design §3): only the module is exported.
export { EngagementModule } from './engagement.module';
