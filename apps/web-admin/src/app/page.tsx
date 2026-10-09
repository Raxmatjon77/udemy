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
    title: 'Moderation queue',
    description: 'Approve or reject submitted courses and manage the category tree.',
    phase: 'Phase 2',
  },
  {
    title: 'Users & instructors',
    description: 'Approve instructor applications, manage roles and handle bans.',
    phase: 'Phase 1',
  },
  {
    title: 'Orders & payouts',
    description: 'Inspect orders, issue refunds, run payouts and browse the audit log.',
    phase: 'Phase 6',
  },
] as const;

export default function HomePage() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-5xl flex-col gap-16 px-6 py-16">
      <header className="flex items-center justify-between">
        <span className="text-lg font-semibold tracking-tight">Udemy Admin</span>
        <Badge variant="secondary">Admin app</Badge>
      </header>

      <main className="flex flex-col gap-16">
        <section aria-labelledby="hero-title" className="flex flex-col gap-6">
          <Badge variant="outline">Moderation & operations</Badge>
          <h1
            id="hero-title"
            className="text-4xl font-bold tracking-tight text-balance sm:text-5xl"
          >
            Udemy Admin
          </h1>
          <p className="max-w-2xl text-lg text-pretty text-muted-foreground">
            Review courses before they go live, manage users and instructors, and keep orders,
            refunds and payouts in check.
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
