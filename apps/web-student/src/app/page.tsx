import Link from 'next/link';
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

import { getSession } from '@/lib/auth/session';

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

export default async function HomePage() {
  const session = await getSession();

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-16 px-6 py-16">
      <section aria-labelledby="hero-title" className="flex flex-col gap-6">
        <Badge variant="outline">Public catalog + learning</Badge>
        <h1 id="hero-title" className="text-4xl font-bold tracking-tight text-balance sm:text-5xl">
          Learn without limits
        </h1>
        <p className="max-w-2xl text-lg text-pretty text-muted-foreground">
          Discover courses, buy them, and learn at your own pace with progress tracking, notes, Q&A
          and certificates.
        </p>
        <div className="flex flex-wrap gap-3">
          {session ? (
            <>
              <Button asChild size="lg">
                <Link href="/account/profile">Go to my account</Link>
              </Button>
              {!session.roles.includes('INSTRUCTOR') ? (
                <Button asChild size="lg" variant="outline">
                  <Link href="/become-instructor">Become an instructor</Link>
                </Button>
              ) : null}
            </>
          ) : (
            <>
              <Button asChild size="lg">
                <Link href="/signup">Join for free</Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link href="/login">Log in</Link>
              </Button>
            </>
          )}
        </div>
      </section>

      <section aria-labelledby="feature-areas" className="flex flex-col gap-6">
        <h2 id="feature-areas" className="text-2xl font-semibold tracking-tight">
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
  );
}
