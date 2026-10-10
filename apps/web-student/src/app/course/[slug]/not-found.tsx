import { Button } from '@udemy/ui/components/button';
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@udemy/ui/components/card';
import Link from 'next/link';

export default function CourseNotFound() {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle asChild>
            <h1>Course not found</h1>
          </CardTitle>
          <CardDescription>
            This course does not exist, is not published, or is no longer available.
          </CardDescription>
        </CardHeader>
        <CardFooter>
          <Button asChild>
            <Link href="/courses">Browse courses</Link>
          </Button>
        </CardFooter>
      </Card>
    </main>
  );
}
