// Structured logs: one JSON object per line (plan AC-S7).
//
// Every line carries the same six keys (`chainSec`, `gameId`, `event`, `step`, `outcome`,
// `txHash`), `null` where a key does not apply, so a reader can rebuild the transitions of one
// game by filtering on `gameId`. A line never contains a server seed.

import type { Hex } from '@maze/shared';

export type LogLevel = 'info' | 'warn' | 'error' | 'alert';

export interface LogFields {
  event: string;
  level?: LogLevel;
  chainSec?: number | null;
  gameId?: Hex | null;
  step?: number | null;
  outcome?: number | null;
  txHash?: Hex | null;
  /** Free-form extra context. `bigint` values are written as decimal strings. */
  detail?: Record<string, unknown>;
}

export type LogSink = (line: string) => void;

export interface Logger {
  event(fields: LogFields): void;
}

function stdoutSink(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function createLogger(sink: LogSink = stdoutSink): Logger {
  return {
    event(fields) {
      const line = JSON.stringify(
        {
          level: fields.level ?? 'info',
          event: fields.event,
          chainSec: fields.chainSec ?? null,
          gameId: fields.gameId ?? null,
          step: fields.step ?? null,
          outcome: fields.outcome ?? null,
          txHash: fields.txHash ?? null,
          ...(fields.detail === undefined ? {} : { detail: fields.detail }),
        },
        (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
      );
      sink(line);
    },
  };
}

/** A short description of an unknown thrown value, for `detail.error`. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const short = (error as { shortMessage?: unknown }).shortMessage;
  const message = typeof short === 'string' ? short : error.message;
  return error.cause === undefined ? message : `${message} (${describeError(error.cause)})`;
}
