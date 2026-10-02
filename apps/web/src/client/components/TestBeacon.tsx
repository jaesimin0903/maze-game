'use client';

import { useEffect, useRef } from 'react';
import type { UiSnapshotInput } from '@maze/shared';
import type { ApiClient } from '../api';

const FORM_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** Every `data-testid` element under `root`: its real DOM text (or form value) and attributes. */
export function collectSnapshot(root: ParentNode): UiSnapshotInput['items'] {
  const items: UiSnapshotInput['items'] = {};
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-testid]'))) {
    const attrs: Record<string, string> = {};
    for (const attr of Array.from(el.attributes)) {
      if (attr.name === 'data-testid' || attr.name === 'class' || attr.name === 'style') continue;
      attrs[attr.name] = attr.value;
    }
    const text = FORM_TAGS.has(el.tagName)
      ? (el as HTMLInputElement).value
      : (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    items[el.getAttribute('data-testid') as string] = { text, attrs };
  }
  return items;
}

interface Props {
  api: Pick<ApiClient, 'postSnapshot'>;
  /** Chain seconds, as the page currently knows them. */
  chainNowSec: number;
  /** Period of the unconditional send, so `seq` keeps rising while nothing changes. */
  heartbeatMs?: number;
}

/**
 * Test-only read path (plan §7.6, §9.1 path B). Mounted only when `/api/config` reports
 * `testHooks`. It sends what the DOM actually shows to `POST /api/test/ui-snapshot` after every
 * DOM change and on a heartbeat. Sends are serialised, so snapshots arrive in order.
 */
export function TestBeacon({ api, chainNowSec, heartbeatMs = 1000 }: Props) {
  const now = useRef(chainNowSec);
  useEffect(() => {
    now.current = chainNowSec;
  });

  useEffect(() => {
    let live = true;
    let sending = false;
    let dirty = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;

    const send = async (): Promise<void> => {
      if (sending) {
        dirty = true;
        return;
      }
      sending = true;
      do {
        dirty = false;
        try {
          await api.postSnapshot({
            url: window.location.href,
            chainNowSec: now.current,
            items: collectSnapshot(document),
          });
        } catch {
          // The server may be down (scenario 05). The heartbeat tries again.
        }
      } while (dirty && live);
      sending = false;
    };

    const observer = new MutationObserver(() => {
      if (debounce !== null) return;
      debounce = setTimeout(() => {
        debounce = null;
        void send();
      }, 50);
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    const heartbeat = setInterval(() => void send(), heartbeatMs);
    void send();

    return () => {
      live = false;
      observer.disconnect();
      clearInterval(heartbeat);
      if (debounce !== null) clearTimeout(debounce);
    };
  }, [api, heartbeatMs]);

  return <span data-testid="test-beacon" hidden />;
}
