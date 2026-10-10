import { parseText } from './text';

/** Bounds of `profiles_headline_ck` / `profiles_bio_ck`. */
export const PROFILE_RULES = {
  headline: { field: 'headline', min: 1, max: 60, multiline: false },
  bio: { field: 'bio', min: 1, max: 4000, multiline: true },
} as const;

/** Entity `Profile` (design §4). Created lazily on the first PATCH; defaults until then. */
export interface ProfileState {
  readonly userId: string;
  readonly headline: string | null;
  readonly bio: string | null;
  /** Stub until the Phase 2 media module. */
  readonly avatarMediaId: string | null;
}

/**
 * A validated partial update: `undefined` = keep, `null` = clear, string = set.
 * (An empty string after trimming also clears, so "unset" has one representation.)
 */
export interface ProfileChanges {
  readonly headline?: string | null;
  readonly bio?: string | null;
}

export const Profile = {
  /** What GET returns before the first PATCH. */
  defaults(userId: string): ProfileState {
    return { userId, headline: null, bio: null, avatarMediaId: null };
  },

  /**
   * Validates the profile part of a PATCH.
   * @throws InvalidUsersField (422)
   */
  parseChanges(input: { headline?: string | null; bio?: string | null }): ProfileChanges {
    return {
      ...(input.headline === undefined
        ? {}
        : { headline: optionalText(input.headline, PROFILE_RULES.headline) }),
      ...(input.bio === undefined ? {} : { bio: optionalText(input.bio, PROFILE_RULES.bio) }),
    };
  },

  hasChanges(changes: ProfileChanges): boolean {
    return changes.headline !== undefined || changes.bio !== undefined;
  },
} as const;

function optionalText(
  value: string | null,
  rule: (typeof PROFILE_RULES)[keyof typeof PROFILE_RULES],
): string | null {
  if (value === null || value.trim() === '') return null;
  return parseText(value, rule);
}
