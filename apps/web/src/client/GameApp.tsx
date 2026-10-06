'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ONCHAIN_STATUS, type ConfigResponse } from '@maze/shared';
import { ApiError, ServerUnreachableError, apiMessage } from './api';
import { assertConfig, tableFromConfig } from './config';
import { defaultDeps, type ClientDeps } from './deps';
import { shortHex } from './format';
import { useChainClock } from './poll';
import { useGame } from './use-game';
import type { WalletApi } from './wallet';
import { BetPanel } from './components/BetPanel';
import { Board } from './components/Board';
import { GameChests } from './components/GameChests';
import { MovePad } from './components/MovePad';
import { PointsBalance } from './components/PointsBalance';
import { ReclaimPanel } from './components/ReclaimPanel';
import { RefundSchedule } from './components/RefundSchedule';
import { ResultPanel } from './components/ResultPanel';
import { StatusBar } from './components/StatusBar';
import { TestBeacon } from './components/TestBeacon';
import { WalletButton } from './components/WalletButton';

type ConfigFailure = { unreachable: true } | { unreachable: false; message: string };

/** The game page. Loads the runtime config first; nothing chain-related is known before it. */
export function GameApp({ deps = defaultDeps }: { deps?: ClientDeps }) {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [failure, setFailure] = useState<ConfigFailure | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setFailure(null);
    try {
      setConfig(assertConfig(await deps.api.config()));
    } catch (error) {
      if (error instanceof ServerUnreachableError) setFailure({ unreachable: true });
      else {
        const message = error instanceof ApiError ? apiMessage(error) : (error as Error).message;
        setFailure({ unreachable: false, message });
      }
    }
  }, [deps]);

  useEffect(() => {
    void load();
  }, [load]);

  if (config) return <Game config={config} deps={deps} />;

  return (
    <div className="app">
      <header className="masthead">
        <span className="brand">미로 베팅</span>
      </header>
      {failure === null && <p className="loading">게임 설정을 불러오는 중입니다</p>}
      {failure?.unreachable === true && (
        <p className="banner banner-down" role="alert" data-testid="server-unreachable">
          게임 서버에 연결할 수 없습니다.
          <button type="button" className="quiet" onClick={() => void load()}>
            다시 시도
          </button>
        </p>
      )}
      {failure?.unreachable === false && (
        <p className="banner banner-error" role="alert" data-testid="config-error">
          {failure.message}
          <button type="button" className="quiet" onClick={() => void load()}>
            다시 시도
          </button>
        </p>
      )}
    </div>
  );
}

function Game({ config, deps }: { config: ConfigResponse; deps: ClientDeps }) {
  const chain = useMemo(() => deps.chain(config), [deps, config]);
  const table = useMemo(() => tableFromConfig(config), [config]);
  const clock = useChainClock(chain, deps.timing.clockMs, config.chainNowSec);

  const [wallet, setWallet] = useState<WalletApi | null>(null);
  const [previousBet, setPreviousBet] = useState<{ tier: number; betWei: bigint } | null>(null);
  const game = useGame({ config, deps, chain, wallet, clock });
  const { state, result } = game;
  const { phase, record, view } = state;

  const inLobby = phase === 'lobby' || phase === 'betting' || record === null;
  const betWei =
    view !== null ? BigInt(view.betWei) : record?.betWei !== undefined ? BigInt(record.betWei) : null;
  const settledOnChain = state.onchain?.status === ONCHAIN_STATUS.Settled;
  const confirmed = settledOnChain || state.onchain?.status === ONCHAIN_STATUS.Reclaimed;

  return (
    <div className="app" data-phase={phase}>
      <header className="masthead">
        <span className="brand">미로 베팅</span>
        <span className="chain-info" data-testid="chain-info" data-chain-id={config.chainId}>
          체인 {config.chainId}, 컨트랙트 {shortHex(config.contract)}
        </span>
        <WalletButton
          config={config}
          deps={deps}
          chain={chain}
          wallet={wallet}
          onWallet={setWallet}
          refreshKey={`${phase}:${state.onchain?.status ?? ''}:${record?.gameId ?? ''}`}
        />
        {config.chest !== undefined && (
          <PointsBalance
            api={deps.api}
            address={wallet?.address ?? null}
            // A path chest adds points during play: every chest found asks again.
            refreshKey={`${phase}:${state.onchain?.status ?? ''}:${record?.gameId ?? ''}:${record?.chests?.length ?? 0}`}
          />
        )}
      </header>

      {config.testHooks && (
        <p className="banner banner-hooks" role="alert" data-testid="test-hooks-banner">
          <strong>테스트 훅이 켜진 서버입니다.</strong> 시험용 장치가 미로의 시드를 게임 번호에서
          계산할 수 있어 미로를 미리 알아낼 수 있습니다. 공정한 판이 아니므로 실제 가치가 있는 돈을
          걸지 마세요.
        </p>
      )}
      {config.fixture && (
        <p className="banner banner-fixture" data-testid="fixture-banner">
          테스트 표로 실행 중입니다. 배당과 환불 수치는 인증되지 않은 시험용 값입니다.
        </p>
      )}
      {state.serverUnreachable && (
        <p className="banner banner-down" role="alert" data-testid="server-unreachable">
          게임 서버에 연결할 수 없습니다. 계속 다시 시도하고 있습니다.
        </p>
      )}
      {clock.rpcDown && (
        <p className="banner banner-down" role="alert" data-testid="rpc-unreachable">
          체인 RPC({config.rpcUrl})에 연결할 수 없습니다.
        </p>
      )}
      {state.error !== null && (
        <p className="banner banner-error" role="alert" data-testid="error-message">
          {state.error}
          <button type="button" className="quiet" onClick={game.dismissError}>
            닫기
          </button>
        </p>
      )}

      {inLobby ? (
        <BetPanel
          config={config}
          table={table}
          walletConnected={wallet !== null}
          walletKind={wallet?.kind ?? null}
          betStep={state.betStep}
          busy={phase === 'betting'}
          previous={previousBet}
          onBet={(bet) => {
            setPreviousBet({ tier: bet.tier, betWei: bet.betWei });
            void game.placeBet(bet);
          }}
        />
      ) : (
        <main className="table">
          <div className="table-board">
            <Board
              n={record.n}
              gameId={record.gameId}
              observations={record.observations}
              legal={game.legal}
              onMove={(dir) => void game.move(dir)}
              ended={phase === 'ended' ? (result?.outcome ?? null) : null}
              waiting={phase === 'playing' && record.observations.length === 0}
              chest={phase === 'ended' && result?.chest ? result.chest.cell : null}
              found={record.chests}
            />
          </div>

          <div className="table-rail">
            {phase === 'playing' && view !== null && (
              <>
                <StatusBar
                  view={view}
                  table={table}
                  now={clock.now}
                  busy={state.busy}
                  onCashOut={() => void game.cashOut()}
                />
                <MovePad
                  legal={game.legal}
                  onMove={(dir) => void game.move(dir)}
                  active={view.status === 'active'}
                />
                {config.chest !== undefined && view.chests !== undefined && (
                  <GameChests chests={view.chests} step={view.step} />
                )}
              </>
            )}
            {phase === 'playing' && settledOnChain && (
              <p className="banner banner-fixture" data-testid="settled-notice">
                이 게임은 체인에서 이미 정산되었습니다. 서버가 응답하면 결과가 표시됩니다.
              </p>
            )}
            {phase === 'ended' && (
              <ResultPanel
                gameId={record.gameId}
                result={result}
                betWei={betWei}
                confirmed={confirmed}
                canSelfSettle={game.canSelfSettle}
                walletConnected={wallet !== null}
                busy={state.busy}
                onSettleSelf={() => void game.settleSelf()}
                onNewGame={game.newGame}
              />
            )}
            {game.reclaim !== null && (
              <ReclaimPanel
                info={game.reclaim}
                now={clock.now}
                betWei={betWei}
                walletConnected={wallet !== null}
                busy={state.busy}
                onReclaim={() => void game.reclaimBet()}
              />
            )}
            {phase === 'playing' && table.tiers[record.tier] !== undefined && (
              <RefundSchedule
                table={table}
                tier={record.tier}
                betWei={betWei}
                currentStep={Math.max(0, record.observations.length - 1)}
              />
            )}
          </div>
        </main>
      )}

      {config.testHooks && <TestBeacon api={deps.api} chainNowSec={clock.now} />}
    </div>
  );
}
