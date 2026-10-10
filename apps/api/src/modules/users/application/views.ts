import type {
  AdminUserRow,
  AdminUserSummary,
  ApplicantSummary,
  BanRecord as BanRecordView,
  InstructorApplication as InstructorApplicationView,
  InstructorApplicationDetail,
  Profile as ProfileView,
  PublicProfile,
  Role,
} from '@udemy/contracts';
import type { BanRecord, UserSummary } from '../../identity';
import type { InstructorApplicationState } from '../domain/instructor-application';
import type { ProfileState } from '../domain/profile';

/*
 * Application state -> HTTP contract shapes (@udemy/contracts). Timestamps become ISO 8601
 * strings here, so the controllers and the facade return contract types unchanged.
 */

export function toApplicationView(app: InstructorApplicationState): InstructorApplicationView {
  return {
    id: app.id,
    applicantId: app.applicantId,
    status: app.status,
    motivation: app.motivation,
    expertise: app.expertise,
    experienceLevel: app.experienceLevel,
    portfolioUrl: app.portfolioUrl,
    submittedAt: app.submittedAt.toISOString(),
    version: app.version,
    transitions: app.transitions.map((t) => ({
      fromStatus: t.fromStatus,
      toStatus: t.toStatus,
      actorId: t.actorId,
      reason: t.reason,
      occurredAt: t.occurredAt.toISOString(),
    })),
  };
}

export function toApplicantSummary(user: UserSummary): ApplicantSummary {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    emailVerified: user.emailVerified,
    status: user.status,
  };
}

export function toApplicationDetail(
  app: InstructorApplicationState,
  applicant: UserSummary,
): InstructorApplicationDetail {
  return { ...toApplicationView(app), applicant: toApplicantSummary(applicant) };
}

/** Avatar URLs need the Phase 2 media module; until then always null. */
const NO_AVATAR = null;

export function toProfileView(profile: ProfileState, displayName: string): ProfileView {
  return {
    userId: profile.userId,
    displayName,
    headline: profile.headline,
    bio: profile.bio,
    avatarUrl: NO_AVATAR,
  };
}

export function toPublicProfile(
  user: UserSummary,
  profile: ProfileState,
  isInstructor: boolean,
): PublicProfile {
  return {
    id: user.id,
    displayName: user.displayName,
    headline: profile.headline,
    bio: profile.bio,
    avatarUrl: NO_AVATAR,
    isInstructor,
  };
}

export function toBanView(ban: BanRecord): BanRecordView {
  return {
    id: ban.id,
    userId: ban.userId,
    reason: ban.reason,
    bannedBy: ban.bannedBy,
    bannedAt: ban.bannedAt.toISOString(),
    liftedAt: ban.liftedAt?.toISOString() ?? null,
    liftedBy: ban.liftedBy,
    liftReason: ban.liftReason,
  };
}

export function toAdminUserSummary(user: UserSummary): AdminUserSummary {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    emailVerified: user.emailVerified,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
  };
}

export function toAdminUserRow(user: UserSummary, roles: readonly Role[]): AdminUserRow {
  return { ...toAdminUserSummary(user), roles: [...roles] };
}
