import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import type { ReactNode } from 'react';

import '@udemy/ui/globals.css';

import { Providers } from './providers';

// The CSS variables are consumed by the --font-sans / --font-mono tokens in @udemy/ui.
const fontSans = Geist({ subsets: ['latin'], variable: '--font-sans-app' });
const fontMono = Geist_Mono({ subsets: ['latin'], variable: '--font-mono-app' });

export const metadata: Metadata = {
  title: {
    default: 'Udemy',
    template: '%s | Udemy',
  },
  description:
    'Discover courses, buy them, and learn at your own pace with progress tracking, notes, Q&A and certificates.',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${fontSans.variable} ${fontMono.variable}`}>
      <body className="min-h-dvh">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
