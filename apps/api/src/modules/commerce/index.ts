// Public facade of the commerce context: the only file other modules may import. No other
// module calls commerce in Phase 4 (design §3); Phase 6 analytics consumes its events.
export { CommerceModule } from './commerce.module';
