import { VerifyView } from '../../../src/client/components/VerifyView';

export const metadata = {
  title: '공정성 검증 | 미로 베팅',
};

/** `/verify/<gameId>`: verify the record this browser kept of that game. */
export default async function VerifyGamePage({ params }: { params: Promise<{ gameId: string }> }) {
  const { gameId } = await params;
  return <VerifyView gameId={gameId} />;
}
