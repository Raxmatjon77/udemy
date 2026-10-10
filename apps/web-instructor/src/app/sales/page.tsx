import type { Metadata } from 'next';

import { SalesDashboard } from './sales-dashboard';

export const metadata: Metadata = { title: 'Sales' };

export default function SalesPage() {
  return (
    <main className="mx-auto grid w-full max-w-6xl gap-8 px-6 py-10">
      <SalesDashboard />
    </main>
  );
}
