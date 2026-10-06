'use client';

import { DIR_BIT, type Dir, type FoundChest, type Hex, type Observation } from '@maze/shared';
import { DIRS, DIR_NAMES, boardCells } from '../board-view';
import { formatPoints } from '../format';
import type { ResultOutcome } from '../use-game';

interface Props {
  n: number;
  gameId: Hex;
  observations: Observation[];
  /** Directions the player may move in right now. */
  legal: Dir[];
  onMove(dir: Dir): void;
  /** Set once the game is over. */
  ended: ResultOutcome | null;
  /** The server has not shown the first cell yet. */
  waiting: boolean;
  /** The chest the player found in the dead end that ended the game, once the server said so. */
  chest?: { x: number; y: number } | null;
  /** The chests found so far, as the server listed them: cells already entered only. */
  found?: FoundChest[];
}

const WALL_CLASS = ['wall-n', 'wall-e', 'wall-s', 'wall-w'] as const;

const STATE_TEXT = { current: '현재 칸', visited: '지나온 칸', hidden: '가 보지 않은 칸' } as const;

/**
 * The fog board. Walls are drawn only for cells the server has shown; a hidden cell carries no
 * wall data at all (`data-open` is empty).
 */
export function Board({ n, gameId, observations, legal, onMove, ended, waiting, chest = null, found = [] }: Props) {
  const cells = boardCells(n, observations);
  const step = Math.max(0, observations.length - 1);
  // Path chests by cell. The dead-end chest is drawn from `chest`, as before.
  const pathChests = new Map(
    found.filter((entry) => entry.kind === 'path').map((entry) => [entry.cell.y * n + entry.cell.x, entry]),
  );
  return (
    <div className="board-frame" data-ended={ended ?? undefined}>
      <div
        className="board"
        role="list"
        aria-label={`${n}×${n} 미로`}
        data-testid="board"
        data-game-id={gameId}
        data-n={n}
        data-step={Math.max(0, observations.length - 1)}
        style={{ gridTemplateColumns: `repeat(${n}, 1fr)` }}
      >
        {cells.map((cell) => {
          const enter = cell.via !== null && legal.includes(cell.via) ? cell.via : null;
          const walls =
            cell.open === null
              ? []
              : DIRS.filter((dir) => (cell.open! & DIR_BIT[dir]) === 0).map((dir) => WALL_CLASS[dir]);
          // Only a cell the player stands in at the end can show a chest, and only once the
          // server has ended the game and said what the dead end held.
          const hasChest = chest !== null && chest.x === cell.x && chest.y === cell.y && cell.state !== 'hidden';
          // A path chest shows on its cell from the move that entered it; the move that just did
          // shows the points it earned on the cell as well.
          const pathChest = cell.state === 'hidden' ? undefined : pathChests.get(cell.cell);
          const fresh = pathChest !== undefined && pathChest.step === step && ended === null;
          const marked = hasChest || pathChest !== undefined;
          return (
            <div
              key={cell.cell}
              role="listitem"
              className={['cell', `is-${cell.state}`, ...walls, ...(marked ? ['has-chest'] : [])].join(' ')}
              data-testid={`cell-${cell.x}-${cell.y}`}
              data-state={cell.state}
              data-open={cell.open === null ? '' : String(cell.open)}
              data-start={cell.start}
              data-exit={cell.exit}
              data-enter={enter === null ? undefined : DIR_NAMES[enter]}
              data-chest={marked ? 'true' : undefined}
              data-chest-kind={hasChest ? 'dead-end' : pathChest !== undefined ? 'path' : undefined}
              aria-label={`${cell.x + 1}열 ${cell.y + 1}행, ${STATE_TEXT[cell.state]}${
                cell.start ? ', 출발' : ''
              }${cell.exit ? ', 출구' : ''}${marked ? ', 보물상자' : ''}`}
              onClick={enter === null ? undefined : () => onMove(enter)}
            >
              {cell.start && <span className="mark mark-start">출발</span>}
              {cell.exit && <span className="mark mark-exit">출구</span>}
              {cell.state === 'current' && <span className="lamp" aria-hidden="true" />}
              {hasChest && (
                <span className="mark mark-chest" data-testid="chest-reveal" data-x={cell.x} data-y={cell.y}>
                  보물상자
                </span>
              )}
              {!hasChest && pathChest !== undefined && (
                <span
                  className="mark mark-chest"
                  data-testid={`chest-cell-${cell.x}-${cell.y}`}
                  data-kind="path"
                  data-points={pathChest.points}
                  data-step={pathChest.step}
                >
                  상자
                </span>
              )}
              {fresh && (
                <span
                  className="chest-pop"
                  data-testid="chest-pop"
                  data-x={cell.x}
                  data-y={cell.y}
                  data-points={pathChest.points}
                >
                  +{formatPoints(pathChest.points)}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {waiting && (
        <p className="board-waiting" data-testid="board-waiting" aria-live="polite">
          서버가 체인에서 베팅을 확인하고 있습니다
        </p>
      )}
    </div>
  );
}
