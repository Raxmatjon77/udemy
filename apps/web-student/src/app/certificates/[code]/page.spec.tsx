import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createLearningHandlers,
  createLearningMockStore,
  FIXTURE_IDS,
  type LearningMockStore,
} from '@udemy/contracts/testing';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { API, setupMswServer } from '@/test/msw';

import CertificatePage, { generateMetadata } from './page';

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'user-agent': 'Vitest' }),
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false }),
}));

const server = setupMswServer();

/** A student who completed "Complete TypeScript": the mock worker issued the certificate. */
function certified(): { store: LearningMockStore; code: string } {
  const store = createLearningMockStore();
  server.use(...createLearningHandlers({ baseUrl: API, store }).handlers);
  store.commerce.seedEnrollment(FIXTURE_IDS.student, FIXTURE_IDS.course);
  store.seedCompletion(FIXTURE_IDS.student, FIXTURE_IDS.course);
  const [certificate] = store.myCertificates();
  return { store, code: certificate!.code };
}

const props = (code: string) => ({
  params: Promise.resolve({ code }),
  searchParams: Promise.resolve({}),
});

async function render(code: string): Promise<string> {
  const element = (await CertificatePage(props(code))) as ReactElement;
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>{element}</QueryClientProvider>,
  );
}

describe('/certificates/[code]', () => {
  it('verifies a valid certificate (server-rendered, noindex)', async () => {
    const { code } = certified();
    const html = await render(code);
    expect(html).toContain('data-status="ACTIVE"');
    expect(html).toContain('Complete TypeScript');
    expect(html).toContain('This certificate is valid.');
    expect(html).toContain(`Certificate ID: ${code}`);
    expect(html).toContain('Download PDF');
    expect(html).toContain('href="/course/complete-typescript"');

    const metadata = await generateMetadata(props(code));
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.title).toBe('Certificate of completion: Complete TypeScript');
    expect(metadata.openGraph).toMatchObject({ title: metadata.title });
  });

  it('shows a revoked certificate as no longer valid, without the PDF', async () => {
    const { store, code } = certified();
    store.commerce.revokeEnrollmentOf(FIXTURE_IDS.student, FIXTURE_IDS.course);
    const html = await render(code);
    expect(html).toContain('data-status="REVOKED"');
    expect(html).toMatch(/This certificate was revoked on .* and is no longer valid\./);
    expect(html).not.toContain('Download PDF');
  });

  it('is a 404 for an unknown or malformed code (malformed: without asking the API)', async () => {
    certified();
    await expect(render('0123456789ABCDEFGHJKMNPQRS')).rejects.toThrow(
      /NEXT_HTTP_ERROR_FALLBACK;404/,
    );
    await expect(render('not-a-code')).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/);
    expect(await generateMetadata(props('not-a-code'))).toEqual({
      title: 'Certificate not found',
      robots: { index: false },
    });
  });
});
