'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@udemy/ui/lib/utils';

const LINKS = [
  { href: '/course-reviews', label: 'Course reviews' },
  { href: '/courses', label: 'Courses' },
  { href: '/categories', label: 'Categories' },
  { href: '/instructor-applications', label: 'Instructor applications' },
  { href: '/users', label: 'Users' },
  { href: '/orders', label: 'Orders' },
  { href: '/refunds', label: 'Refunds' },
  { href: '/coupons', label: 'Coupons' },
] as const;

export function MainNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main">
      <ul className="flex flex-wrap gap-1">
        {LINKS.map((link) => {
          const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
                  active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground',
                )}
              >
                {link.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
