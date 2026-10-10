import type { PublicPrice } from '@udemy/contracts';
import { cn } from '@udemy/ui/lib/utils';

import { priceLabel } from '@/lib/commerce/format';

/** The prices of a set of courses, by course id (from `GET /commerce/prices`). */
export type PriceMap = Readonly<Record<string, PublicPrice>>;

export function toPriceMap(prices: readonly PublicPrice[]): PriceMap {
  return Object.fromEntries(prices.map((price) => [price.courseId, price]));
}

/**
 * A course's price: "$19.99", "Free" (D14), or "Not available yet" when the course has no price
 * (D16: not for sale). Server-renderable.
 */
export function PriceTag({
  price,
  size = 'sm',
  className,
}: {
  /** Null: the course has no price (not for sale). */
  price: PublicPrice | null;
  size?: 'sm' | 'lg';
  className?: string;
}) {
  if (price === null) {
    return (
      <p
        data-testid="price"
        className={cn('text-sm text-muted-foreground', size === 'lg' && 'text-base', className)}
      >
        Not available yet
      </p>
    );
  }
  return (
    <p
      data-testid="price"
      className={cn(
        'font-semibold tabular-nums',
        size === 'lg' ? 'text-3xl tracking-tight' : 'text-base',
        className,
      )}
    >
      {priceLabel(price.amount, price.currency)}
    </p>
  );
}
