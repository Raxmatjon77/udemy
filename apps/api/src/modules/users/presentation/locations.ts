/** Absolute path of an application resource (the `Location` of a 201), as the BFFs see it. */
export function applicationLocation(applicationId: string): string {
  return `/api/v1/instructor-applications/${applicationId}`;
}
