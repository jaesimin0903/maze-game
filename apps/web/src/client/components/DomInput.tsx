'use client';

import { useEffect, useRef, type InputHTMLAttributes } from 'react';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'defaultValue' | 'onChange'> & {
  value: string;
  onValue(value: string): void;
};

/**
 * A text input whose DOM value is the source of truth. It reports through native `input` and
 * `change` listeners, so a value set by script (browser automation) is seen the same way as one
 * typed by hand; React's own change tracking drops those.
 */
export function DomInput({ value, onValue, ...rest }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const report = useRef(onValue);
  useEffect(() => {
    report.current = onValue;
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const listener = (): void => report.current(el.value);
    el.addEventListener('input', listener);
    el.addEventListener('change', listener);
    return () => {
      el.removeEventListener('input', listener);
      el.removeEventListener('change', listener);
    };
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (el && el.value !== value) el.value = value;
  }, [value]);

  return <input ref={ref} defaultValue={value} {...rest} />;
}
