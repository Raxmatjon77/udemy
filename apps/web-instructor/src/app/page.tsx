import type { Metadata } from 'next';
import { Badge } from '@udemy/ui/components/badge';
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@udemy/ui/components/card';

import { Welcome } from './welcome';

export const metadata: Metadata = { title: 'Dashboard' };

const featureAreas = [
  {
    title: 'Course builder',
    description:
      'Organize sections and lectures with drag and drop, then submit the course for review.',
    phase: 'Phase 2',
  },
  {
    title: 'Video uploads',
    description: 'Resumable chunked uploads to object storage with live transcoding status.',
    phase: 'Phase 2',
  },
  {
    title: 'Revenue & analytics',
    description: 'Track enrollments, ratings, revenue and payouts for every course you run.',
    phase: 'Phase 6',
  },
] as const;

/** Placeholder dashboard (Phase 1): proves the instructor session end to end. */
export default function DashboardPage() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-6 py-10">
      <Welcome />
      <section aria-labelledby="coming-soon" className="grid gap-4">
        <h2 id="coming-soon" className="text-lg font-semibold tracking-tight">
          Coming soon
        </h2>
        <ul className="grid gap-6 md:grid-cols-3">
          {featureAreas.map((area) => (
            <li key={area.title} className="flex">
              <Card className="w-full">
                <CardHeader>
                  <CardTitle asChild>
                    <h3>{area.title}</h3>
                  </CardTitle>
                  <CardDescription>{area.description}</CardDescription>
                </CardHeader>
                <CardFooter className="mt-auto">
                  <Badge variant="outline">Planned for {area.phase}</Badge>
                </CardFooter>
              </Card>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
