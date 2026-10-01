import type { ReactNode } from 'react';

export const metadata = {
  title: 'Maze Bet',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
