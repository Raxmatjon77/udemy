/** What catalog shows about a person (owner, actor of a transition). */
export interface CoursePerson {
  readonly displayName: string;
  /** An active ban (design §13 Q4: the admin course list flags banned owners). */
  readonly banned: boolean;
}

/**
 * Display names and ban flags of users (design §5 history, review queue, admin list). Unlike
 * `UsersFacade.getPublicProfiles`, banned users are included: moderators must still see who
 * owns a course. Unknown ids are absent from the map.
 */
export abstract class CoursePeopleDirectory {
  abstract findPeople(userIds: readonly string[]): Promise<ReadonlyMap<string, CoursePerson>>;
}
