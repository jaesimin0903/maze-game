'use client';

import { useEffect } from 'react';
import type { Dir } from '@maze/shared';
import { DIRS, DIR_NAMES } from '../board-view';

interface Props {
  /** Directions the player may move in right now. */
  legal: Dir[];
  onMove(dir: Dir): void;
  /** A game is in progress, so arrow keys belong to the board rather than to page scrolling. */
  active: boolean;
}

const ARROWS = ['▲', '▶', '▼', '◀'] as const;
const LABELS = ['위로 이동', '오른쪽으로 이동', '아래로 이동', '왼쪽으로 이동'] as const;

/** Physical keys, so that WASD works under a Korean input method too. */
const KEY_DIR: Record<string, Dir> = {
  ArrowUp: 0,
  ArrowRight: 1,
  ArrowDown: 2,
  ArrowLeft: 3,
  KeyW: 0,
  KeyD: 1,
  KeyS: 2,
  KeyA: 3,
};

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** The four move buttons, plus arrow-key and WASD movement while a game is in progress. */
export function MovePad({ legal, onMove, active }: Props) {
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (TYPING_TAGS.has(target.tagName) || target.isContentEditable)) return;
      const dir = KEY_DIR[event.code];
      if (dir === undefined) return;
      event.preventDefault();
      if (legal.includes(dir)) onMove(dir);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, legal, onMove]);

  return (
    <div className="pad" role="group" aria-label="이동">
      {DIRS.map((dir) => {
        const allowed = legal.includes(dir);
        return (
          <button
            key={dir}
            type="button"
            className={`pad-key pad-${DIR_NAMES[dir].toLowerCase()}`}
            data-testid={`move-${DIR_NAMES[dir]}`}
            data-legal={allowed}
            aria-label={LABELS[dir]}
            disabled={!allowed}
            onClick={() => onMove(dir)}
          >
            {ARROWS[dir]}
          </button>
        );
      })}
      <p className="pad-hint">방향키나 WASD로도 움직입니다</p>
    </div>
  );
}
