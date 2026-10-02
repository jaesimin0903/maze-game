import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: '미로 베팅',
  description: '안개 속 미로에서 출구를 찾는 온체인 베팅 게임. 모든 판은 직접 검증할 수 있습니다.',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
