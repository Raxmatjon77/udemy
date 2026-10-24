/** Links into the course player (learning experience design §10 `/learn/[courseId]/[[...lectureId]]`). */

/** The player of a course (it opens the resume lecture). */
export function learnCourseHref(courseId: string): string {
  return `/learn/${encodeURIComponent(courseId)}`;
}

/** One lecture in the player, optionally at a video position (`?t=` seconds, a note's timestamp). */
export function lectureHref(courseId: string, lectureId: string, atSeconds?: number): string {
  const base = `${learnCourseHref(courseId)}/${encodeURIComponent(lectureId)}`;
  return atSeconds === undefined ? base : `${base}?t=${Math.max(0, Math.floor(atSeconds))}`;
}

/** The public verification page of a certificate. */
export function certificateHref(code: string): string {
  return `/certificates/${encodeURIComponent(code)}`;
}
