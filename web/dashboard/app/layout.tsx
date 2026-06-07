import type { Metadata } from 'next';
import { Bricolage_Grotesque, Geist, Instrument_Serif, JetBrains_Mono } from 'next/font/google';
import { Providers } from './components/providers';
import './globals.css';

const bricolage = Bricolage_Grotesque({
  variable: '--font-bricolage',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  display: 'swap',
});

const instrument = Instrument_Serif({
  variable: '--font-instrument',
  subsets: ['latin'],
  weight: ['400'],
  style: ['normal', 'italic'],
  display: 'swap',
});

const geist = Geist({
  variable: '--font-geist',
  subsets: ['latin'],
  display: 'swap',
});

const jetbrains = JetBrains_Mono({
  variable: '--font-jetbrains',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Synapse Vault — Autonomous AI Treasury Management',
  description:
    'Hire an AI portfolio manager. Pay it in basis points. Revoke it in one click. Synapse Vault on Sui.',
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ?? 'https://synapse-kappa-sable.vercel.app',
  ),
  openGraph: {
    title: 'Synapse Vault — Autonomous AI treasury on Sui, powered by Walrus',
    description:
      'Hire an AI portfolio manager. Pay it in basis points. Revoke it in one click. Every decision remembered, audited, and provable — on Walrus.',
    siteName: 'Synapse Vault',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Synapse Vault — Autonomous AI treasury on Sui, powered by Walrus',
    description:
      'Hire an AI portfolio manager. Pay it in basis points. Revoke it in one click — every decision on Walrus.',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${bricolage.variable} ${instrument.variable} ${geist.variable} ${jetbrains.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-paper text-ink">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
