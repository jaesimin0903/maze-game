import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Maze Bet',
  description: 'An on-chain betting game: find the exit of a maze in the fog. Every game can be verified.',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#14111f',
};

/** Pixel display face, terminal digits and the body face. The page stays usable without them. */
const FONTS =
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;700&family=Press+Start+2P&family=Space+Mono:wght@400;700&family=VT323&display=swap';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link rel="stylesheet" href={FONTS} />
      </head>
      <body>{children}</body>
    </html>
  );
}
