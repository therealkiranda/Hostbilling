import type { CSSProperties } from 'react';

const SEGMENTS = 20;

interface MeterProps {
  /** Fraction of the meter to fill, from 0 to 1. */
  ratio: number;
  /** Position of the plan, used to stagger the one-time fill animation. */
  column: number;
}

/**
 * A level meter made of small segments, like the indicator lights on a server. It shows
 * how one plan compares with the largest plan for the same resource. The value itself is
 * always written out next to it, so the meter is decoration for assistive technology.
 */
export function Meter({ ratio, column }: MeterProps) {
  const filled = ratio > 0 ? Math.max(1, Math.round(ratio * SEGMENTS)) : 0;

  return (
    <span className="meter" aria-hidden="true" style={{ '--column': column } as CSSProperties}>
      {Array.from({ length: SEGMENTS }, (_, index) => (
        <span
          key={index}
          className={index < filled ? 'meter__segment meter__segment--on' : 'meter__segment'}
          style={{ '--index': index } as CSSProperties}
        />
      ))}
    </span>
  );
}
