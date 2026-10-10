import { redirect } from 'next/navigation';

/** The admin home is the instructor application queue. */
export default function HomePage() {
  redirect('/instructor-applications');
}
