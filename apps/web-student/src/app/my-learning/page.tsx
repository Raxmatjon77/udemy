import type { Metadata } from 'next';

import { MyLearning } from '@/components/commerce/my-learning';

export const metadata: Metadata = { title: 'My learning', robots: { index: false } };

/** `/my-learning` (session required): the courses the student is enrolled in. */
export default function MyLearningPage() {
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-10 sm:px-6">
      <h1 className="text-3xl font-bold tracking-tight">My learning</h1>
      <MyLearning />
    </main>
  );
}
