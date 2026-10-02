// Next.js instrumentation hook: boots the game server when the Node.js server process starts.
//
// The boot guards (plan AC-S8) run here. When they fail, the reason has been logged as one JSON
// line and the process exits with a non-zero code, so `next start` with an uncalibrated or
// mismatched table does not come up.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // `next build` loads server modules but must not boot the server.
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  const { bootOrExit } = await import('./src/server/container');
  await bootOrExit();
}
