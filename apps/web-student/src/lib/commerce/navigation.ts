/**
 * Full-page navigations. In their own module so specs can replace them (`vi.mock`): jsdom
 * cannot navigate, and a spec wants to see where the app would have gone.
 */
export function assignLocation(url: string): void {
  window.location.assign(url);
}
