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
    title: 'Catalog & search',
    description: 'Browse categories, filter courses and read SEO-friendly course landing pages.',
    phase: 'Phase 4',
  },
  {
    title: 'Cart & checkout',
    description: 'Add courses to a cart, apply coupons and pay securely with Stripe Checkout.',
    phase: 'Phase 4',
  },
  {
    title: 'My learning',
    description:
      'Stream lectures in the HLS player, resume where you left off and earn certificates.',
    phase: 'Phase 5',
  },
] as const;

export default function HomePage() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-5xl flex-col gap-16 px-6 py-16">
      <header className="flex items-center justify-between">
        <span className="text-lg font-semibold tracking-tight">Udemy</span>
        <Badge variant="secondary">Student app</Badge>
      </header>

      <main className="flex flex-col gap-16">
        <section aria-labelledby="hero-title" className="flex flex-col gap-6">
          <Badge variant="outline">Public catalog + learning</Badge>
          <h1
            id="hero-title"
            className="text-4xl font-bold tracking-tight text-balance sm:text-5xl"
          >
            Udemy
          </h1>
          <p className="max-w-2xl text-lg text-pretty text-muted-foreground">
            Discover courses, buy them, and learn at your own pace with progress tracking, notes,
            Q&A and certificates.
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
