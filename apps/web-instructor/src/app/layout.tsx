import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { connection } from 'next/server';
import type { ReactNode } from 'react';

import '@udemy/ui/globals.css';

import { SiteHeader } from '@/components/site-header';

import { Providers } from './providers';

// The CSS variables are consumed by the --font-sans / --font-mono tokens in @udemy/ui.
const fontSans = Geist({ subsets: ['latin'], variable: '--font-sans-app' });
const fontMono = Geist_Mono({ subsets: ['latin'], variable: '--font-mono-app' });

export const metadata: Metadata = {
  title: {
    default: 'Udemy Instructor',
    template: '%s | Udemy Instructor',
  },
  description:
    'Build and publish courses, upload lecture videos, engage with students and follow your revenue.',
  // Internal tool: keep it out of search engines.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
};

/**
 * Every page renders per request: src/proxy.ts sends a Content-Security-Policy with a fresh
 * nonce, and Next can only stamp that nonce on its scripts while rendering. A prerendered
 * (static/ISR) page would carry no nonce and its scripts would be blocked.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  return (
    <html lang="en" className={`${fontSans.variable} ${fontMono.variable}`}>
      <body className="flex min-h-dvh flex-col">
        <Providers>
          <SiteHeader />
          <div className="flex flex-1 flex-col">{children}</div>
        </Providers>
      </body>
    </html>
  );
}
