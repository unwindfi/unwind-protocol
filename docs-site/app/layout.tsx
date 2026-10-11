import { RootProvider } from 'fumadocs-ui/provider/next';
import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { Analytics } from '@vercel/analytics/next';
import { siteName, siteUrl } from '@/lib/shared';
import './global.css';

const geist = Geist({ subsets: ['latin'], variable: '--font-geist' });
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono' });

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: siteName, template: `%s · ${siteName}` },
  description: 'unwind is a perpetual futures venue on Solana. List any Solana token, with leverage.',
  icons: {
    icon: [
      { url: '/favicon-32.png?v=2', sizes: '32x32', type: 'image/png' },
      { url: '/favicon-64.png?v=2', sizes: '64x64', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png?v=2',
  },
  openGraph: {
    siteName,
    type: 'website',
    images: [{ url: '/og.jpg', width: 1200, height: 630 }],
  },
  twitter: { card: 'summary_large_image', site: '@unwindfi', images: ['/og.jpg'] },
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider theme={{ defaultTheme: 'dark', enableSystem: false }}>{children}</RootProvider>
        <Analytics />
      </body>
    </html>
  );
}
