import { redirect } from 'next/navigation';

/** `/verify/<gameId>`: the fairness check now opens as a dialog over the game, for that game. */
export default async function VerifyGamePage({ params }: { params: Promise<{ gameId: string }> }) {
  const { gameId } = await params;
  redirect(`/?verify=${encodeURIComponent(gameId)}`);
}
