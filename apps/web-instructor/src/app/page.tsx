import { Badge } from '@udemy/ui/components/badge';
import { Button } from '@udemy/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@udemy/ui/components/card';

import { env } from '@/lib/env';

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

export default function HomePage() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-5xl flex-col gap-16 px-6 py-16">
      <header className="flex items-center justify-between">
        <span className="text-lg font-semibold tracking-tight">Udemy Instructor</span>
        <Badge variant="secondary">Instructor app</Badge>
      </header>

      <main className="flex flex-col gap-16">
        <section aria-labelledby="hero-title" className="flex flex-col gap-6">
          <Badge variant="outline">Course builder & analytics</Badge>
          <h1
            id="hero-title"
            className="text-4xl font-bold tracking-tight text-balance sm:text-5xl"
          >
            Udemy Instructor
          </h1>
          <p className="max-w-2xl text-lg text-pretty text-muted-foreground">
            Build and publish courses, upload lecture videos, engage with students and follow your
            revenue.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button asChild size="lg">
              <a href="#feature-areas">See what is coming</a>
            </Button>
            <Button asChild size="lg" variant="outline">
              <a href="/api/health">Health check</a>
            </Button>
          </div>
        </section>

        <section aria-labelledby="feature-areas" className="flex flex-col gap-6">
          <h2 id="feature-areas" className="text-2xl font-semibold tracking-tight">
            Feature areas
          </h2>
          <ul className="grid gap-6 md:grid-cols-3">
            {featureAreas.map((area) => (
              <li key={area.title} className="flex">
                <Card className="w-full">
                  <CardHeader>
                    <CardTitle>{area.title}</CardTitle>
                    <CardDescription>{area.description}</CardDescription>
                  </CardHeader>
                  <CardContent className="mt-auto" />
                  <CardFooter>
                    <Badge variant="outline">Planned for {area.phase}</Badge>
                  </CardFooter>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="mt-auto border-t pt-6 text-sm text-muted-foreground">
        API endpoint: <code className="font-mono">{env.NEXT_PUBLIC_API_URL}</code>
      </footer>
    </div>
  );
}
