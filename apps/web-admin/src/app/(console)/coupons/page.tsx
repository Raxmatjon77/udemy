import type { Metadata } from 'next';

import { CouponsManager } from './coupons-manager';

export const metadata: Metadata = { title: 'Coupons' };

export default function CouponsPage() {
  return (
    <>
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Platform coupons</h1>
        <p className="text-sm text-muted-foreground">
          Coupons that apply to every course. When a course coupon with the same code gives a better
          or equal price, the course coupon wins; coupons never stack.
        </p>
      </div>
      <CouponsManager />
    </>
  );
}
