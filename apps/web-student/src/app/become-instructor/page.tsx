import type { Metadata } from 'next';

import { BecomeInstructor } from './become-instructor';

export const metadata: Metadata = { title: 'Become an instructor' };

export default function BecomeInstructorPage() {
  return (
    <main className="mx-auto grid w-full max-w-3xl gap-8 px-6 py-10">
      <div className="grid gap-2">
        <h1 className="text-3xl font-bold tracking-tight">Teach on Udemy</h1>
        <p className="text-muted-foreground">
          Share what you know with millions of learners. Tell us about yourself and our team will
          review your application, usually within a few days.
        </p>
      </div>
      <BecomeInstructor />
    </main>
  );
}
