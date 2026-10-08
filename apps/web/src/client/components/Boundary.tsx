'use client';

import { Component, type ReactNode } from 'react';

interface Props {
  /** Names the part in the console message. */
  name: string;
  /** Shown in place of the part once it has thrown. */
  fallback: ReactNode;
  onError?(): void;
  children: ReactNode;
}

/**
 * Keeps the rest of the page working when one part of it throws while rendering: the part gives
 * way to `fallback` and the error goes to the console. A new `key` mounts the part again.
 */
export class Boundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    console.error(`${this.props.name} failed`, error);
    this.props.onError?.();
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
