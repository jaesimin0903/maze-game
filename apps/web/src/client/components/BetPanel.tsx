'use client';

import { useRef, useState } from 'react';
import { formatEther, parseEther } from 'viem';
import { exitPayoutWei, type ConfigResponse, type Hex, type TuningTable } from '@maze/shared';
import { tierLabel } from '../config';
import { formatEth, formatMultiplier, formatPercent, parseEthInput } from '../format';
import { isHex32, randomHex32 } from '../seed';
import type { BetStep } from '../use-game';
import { DomInput } from './DomInput';
import { RefundSchedule } from './RefundSchedule';

interface Props {
  config: ConfigResponse;
  table: TuningTable;
  walletConnected: boolean;
  /** Non-null while a bet is being placed. */
  betStep: BetStep | null;
  busy: boolean;
  /** The size and amount of the previous bet on this page, to start from. */
  previous: { tier: number; betWei: bigint } | null;
  onBet(bet: { tier: number; betWei: bigint; clientSeed: Hex }): void;
}

const STEP_TEXT: Record<BetStep, string> = {
  ticket: '서버가 미로의 시드를 정하고 커밋을 보내는 중입니다',
  tx: '지갑에서 베팅 트랜잭션을 승인하세요',
  confirm: '베팅 트랜잭션이 블록에 담기기를 기다리는 중입니다',
};

/** The bet in wei, or the reason the typed amount cannot be bet. */
function readAmount(text: string, min: bigint, max: bigint): { betWei: bigint } | { reason: string } {
  const wei = parseEthInput(text);
  if (wei === null) return { reason: '금액을 ETH 숫자로 입력하세요 (예: 0.01)' };
  if (wei < min) return { reason: `최소 베팅은 ${formatEth(min)} ETH입니다` };
  if (wei > max) return { reason: `최대 베팅은 ${formatEth(max)} ETH입니다` };
  return { betWei: wei };
}

export function BetPanel({ config, table, walletConnected, betStep, busy, previous, onBet }: Props) {
  const min = BigInt(config.minBetWei);
  const max = BigInt(config.maxBetWei);
  const [tier, setTier] = useState(previous?.tier ?? 0);
  const [amountText, setAmountText] = useState(() => {
    const preferred = previous?.betWei ?? parseEther('0.01');
    return formatEther(preferred < min ? min : preferred > max ? max : preferred);
  });
  const [seedText, setSeedText] = useState<string>(() => randomHex32());
  const form = useRef<HTMLFormElement>(null);

  const amount = readAmount(amountText, min, max);
  const betWei = 'betWei' in amount ? amount.betWei : null;
  const seedOk = isHex32(seedText.trim());
  const blocked = !walletConnected
    ? '지갑을 먼저 연결하세요'
    : 'reason' in amount
      ? amount.reason
      : !seedOk
        ? '클라이언트 시드는 0x로 시작하는 64자리 16진수여야 합니다'
        : null;

  const submit = (): void => {
    // Read the fields from the DOM, so values set by script without events are still honoured.
    const field = (name: string): string | undefined =>
      (form.current?.elements.namedItem(name) as HTMLInputElement | null)?.value;
    const nowAmount = readAmount(field('bet-amount') ?? amountText, min, max);
    const nowSeed = (field('client-seed') ?? seedText).trim();
    if (!walletConnected || 'reason' in nowAmount || !isHex32(nowSeed)) return;
    onBet({ tier, betWei: nowAmount.betWei, clientSeed: nowSeed });
  };

  const { refundBps } = config.tiers[tier];

  return (
    <main className="lobby">
      <form className="bet" ref={form} onSubmit={(event) => event.preventDefault()}>
        <h1 className="bet-title">안개 속 미로에서 출구를 찾으세요</h1>
        <p className="bet-lede">
          왼쪽 위에서 출발해 오른쪽 아래 출구까지 한 칸씩 갑니다. 지나온 칸으로는 돌아갈 수 없고,
          더 갈 곳이 없는 칸에 들어서면 베팅액을 모두 잃습니다. 그 전에는 언제든 남은 환불액을
          받고 그만둘 수 있습니다.
        </p>

        <fieldset className="bet-field">
          <legend>미로 크기</legend>
          <div className="tiers">
            {config.tiers.map((t, index) => {
              const payout = betWei === null ? null : exitPayoutWei(table, betWei, index);
              return (
                <button
                  key={index}
                  type="button"
                  className="tier"
                  data-testid={`tier-${index}`}
                  data-selected={tier === index}
                  data-n={t.n}
                  data-multiplier-bps={t.multiplierBps}
                  aria-pressed={tier === index}
                  disabled={busy}
                  onClick={() => setTier(index)}
                >
                  <span className="tier-name">{tierLabel(index, config.tiers.length)}</span>
                  <span className="tier-size">
                    {t.n}×{t.n}칸
                  </span>
                  <span className="tier-mult">{formatMultiplier(t.multiplierBps)}</span>
                  <span
                    className="tier-payout"
                    data-testid={`tier-payout-${index}`}
                    data-wei={payout?.toString() ?? ''}
                  >
                    출구 도착 시 {payout === null ? '—' : `${formatEth(payout)} ETH`}
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>

        <div className="bet-field">
          <label htmlFor="bet-amount">베팅 금액 (ETH)</label>
          <div className="bet-amount-row">
            <DomInput
              id="bet-amount"
              name="bet-amount"
              data-testid="bet-amount"
              inputMode="decimal"
              autoComplete="off"
              disabled={busy}
              value={amountText}
              onValue={setAmountText}
              aria-invalid={'reason' in amount}
            />
            <button
              type="button"
              className="quiet"
              disabled={busy}
              onClick={() => setAmountText(formatEther(min))}
            >
              최소 {formatEth(min)}
            </button>
            <button
              type="button"
              className="quiet"
              disabled={busy}
              onClick={() => setAmountText(formatEther(max))}
            >
              최대 {formatEth(max)}
            </button>
          </div>
        </div>

        <div className="bet-field">
          <label htmlFor="client-seed">클라이언트 시드</label>
          <div className="bet-seed-row">
            <DomInput
              id="client-seed"
              name="client-seed"
              className="mono"
              data-testid="client-seed-input"
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
              value={seedText}
              onValue={setSeedText}
              aria-invalid={!seedOk}
            />
            <button
              type="button"
              className="quiet"
              disabled={busy}
              onClick={() => setSeedText(randomHex32())}
            >
              새로 뽑기
            </button>
          </div>
          <p className="bet-hint">
            서버는 베팅 전에 자기 시드의 해시를 먼저 확정하고, 미로는 그 시드와 이 값을 섞어
            만들어집니다. 게임이 끝나면 서버 시드가 공개되어 미로를 직접 다시 만들어 볼 수 있습니다.
          </p>
        </div>

        <button
          type="button"
          className="primary"
          data-testid="bet-submit"
          disabled={busy || blocked !== null}
          onClick={submit}
        >
          {betWei === null ? '베팅하고 시작' : `${formatEth(betWei)} ETH 베팅하고 시작`}
        </button>
        <p className="bet-status" data-testid="bet-status" data-step={betStep ?? ''} aria-live="polite">
          {betStep !== null ? STEP_TEXT[betStep] : (blocked ?? '')}
        </p>

        <ul className="bet-rules">
          <li>
            베팅 직후에 그만둬도 {formatPercent(refundBps[0])}만 돌려받고, 첫 걸음 뒤에는{' '}
            {formatPercent(refundBps[1])}로 떨어집니다.
          </li>
          <li>
            {config.idleTimeoutSec}초 동안 움직이지 않으면 그때의 환불액으로 자동 캐시아웃됩니다.
          </li>
          <li>시작하고 {config.maxGameSec}초가 지나면 그때의 환불액으로 강제 정산됩니다.</li>
          <li>지갑 하나로는 한 번에 한 판만 할 수 있습니다.</li>
        </ul>
      </form>

      <RefundSchedule table={table} tier={tier} betWei={betWei} />
    </main>
  );
}
