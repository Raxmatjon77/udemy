import type { Metadata } from 'next';

import { ProfileForm } from './profile-form';

export const metadata: Metadata = { title: 'Profile' };

export default function ProfilePage() {
  return (
    <section aria-labelledby="profile-title" className="grid gap-6">
      <div className="grid gap-1">
        <h1 id="profile-title" className="text-2xl font-semibold tracking-tight">
          Profile
        </h1>
        <p className="text-sm text-muted-foreground">
          How you appear to instructors and other learners.
        </p>
      </div>
      <ProfileForm />
    </section>
  );
}
