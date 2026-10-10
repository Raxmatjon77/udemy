// Public facade of the enrollment context: the only file other modules may import.
export { EnrollmentModule } from './enrollment.module';
export {
  type ActiveEnrollmentGrant,
  EnrollmentFacade,
  type GrantEnrollmentInput,
  type GrantEnrollmentResult,
  type RevokeEnrollmentInput,
  type RevokeEnrollmentResult,
} from './application/enrollment.facade';
export type { GrantOutcome, RevokeOutcome } from './domain/enrollment';
// For AppModule only: CourseEntitlementsModule.forRoot({ imports: [EnrollmentModule], useExisting: EnrollmentEntitlements }).
export { EnrollmentEntitlements } from './application/enrollment-entitlements';
