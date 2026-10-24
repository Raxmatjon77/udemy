import { type OwnershipResolver, OwnershipResolverFor } from '../../../shared/auth';
import { isUuid } from './learner-access';
import { CertificateRepository } from './ports/certificates.repository';
import { NotesRepository } from './ports/notes.repository';
import { QuizAttemptRepository } from './ports/quiz-attempts.repository';

/*
 * Ownership of the learner's own resources for `@CheckPolicy` (design §3, §9 IDOR): the owner
 * is the row's `user_id`. A foreign or unknown id answers 404 (never 403, ids cannot be
 * probed). The guard runs before the param pipes, so a malformed id is "does not exist".
 * The use cases scope every read and write to the principal again (defence in depth).
 */

/** `note:manage:own` (`PATCH` / `DELETE /me/notes/:noteId`). */
@OwnershipResolverFor('note')
export class NoteOwnership implements OwnershipResolver {
  constructor(private readonly notes: NotesRepository) {}

  async ownerOf(resourceId: string): Promise<string | null> {
    return isUuid(resourceId) ? this.notes.ownerOf(resourceId) : null;
  }
}

/** `quiz_attempt:read:own` / `quiz_attempt:submit:own` (`/me/quiz-attempts/:attemptId`). */
@OwnershipResolverFor('quiz_attempt')
export class QuizAttemptOwnership implements OwnershipResolver {
  constructor(private readonly attempts: QuizAttemptRepository) {}

  async ownerOf(resourceId: string): Promise<string | null> {
    return isUuid(resourceId) ? this.attempts.ownerOf(resourceId) : null;
  }
}

/** `certificate:read:own` (`/me/certificates/:certificateId[/pdf]`). */
@OwnershipResolverFor('certificate')
export class CertificateOwnership implements OwnershipResolver {
  constructor(private readonly certificates: CertificateRepository) {}

  async ownerOf(resourceId: string): Promise<string | null> {
    return isUuid(resourceId) ? this.certificates.ownerOf(resourceId) : null;
  }
}
