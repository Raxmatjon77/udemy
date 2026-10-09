/** Liveness/readiness probe for Kubernetes. Kept dependency-free so it only reflects this process. */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } });
}
