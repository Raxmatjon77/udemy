/**
 * Starts a browser download of a presigned `attachment` URL (from a `SignedUrl` response) without
 * leaving the page and without a `Referer` to the media host. The URL is a bearer capability:
 * it is never logged or stored.
 */
export function startDownload(url: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.rel = 'noreferrer noopener';
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
}
