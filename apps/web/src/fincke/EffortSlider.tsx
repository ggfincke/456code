// apps/web/src/fincke/EffortSlider.tsx
// snapping effort track: drag previews the nearest level, release springs to it, ultra levels sparkle once
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useRef,
  useState,
} from "react";

import "./effortSlider.css";

export interface EffortLevel {
  readonly id: string;
  readonly label: string;
  readonly description?: string | undefined;
  readonly isDefault?: boolean | undefined;
  readonly ultra: boolean;
}

// stops sit inside 6%..94% so the thumb never overhangs the rounded ends
function stopPosition(index: number, count: number): number {
  return count < 2 ? 50 : 6 + (index / (count - 1)) * 88;
}

function nearestStop(pct: number, count: number): number {
  let best = 0;
  for (let index = 1; index < count; index += 1) {
    const distance = Math.abs(stopPosition(index, count) - pct);
    if (distance < Math.abs(stopPosition(best, count) - pct)) best = index;
  }
  return best;
}

// static sparkle field painted over the ultra gradient, [left%, top%]
const SPARKS: ReadonlyArray<readonly [number, number]> = [
  [8, 30],
  [14, 62],
  [22, 40],
  [31, 70],
  [38, 28],
  [46, 55],
  [53, 35],
  [61, 68],
  [69, 42],
  [76, 25],
  [84, 60],
  [90, 38],
];

// ten dots thrown outward from the thumb; fixed angles keep render pure
const BURST = Array.from({ length: 10 }, (_, index) => {
  const angle = (index / 10) * Math.PI * 2 + (index % 3) * 0.13;
  const distance = 18 + ((index * 7) % 5) * 3;
  return {
    id: `burst-${index}`,
    dx: Math.cos(angle) * distance,
    dy: Math.sin(angle) * distance * 0.7,
    purple: index % 2 === 1,
  };
});

export function EffortSlider(props: {
  levels: ReadonlyArray<EffortLevel>;
  index: number;
  label: string;
  disabled?: boolean;
  // the popover focuses the track on open, so the caller owns this ref
  trackRef: RefObject<HTMLDivElement | null>;
  onCommit: (index: number) => void;
  onPreviewChange: (index: number | null) => void;
}) {
  const { levels, index, disabled = false } = props;
  const count = levels.length;
  const { trackRef } = props;
  const pressRef = useRef<{ x: number; moved: boolean } | null>(null);
  const [dragPct, setDragPct] = useState<number | null>(null);
  // a committed move from a normal level into an ultra level plays the entry effect once
  const [committedIndex, setCommittedIndex] = useState(index);
  const [effectKey, setEffectKey] = useState(0);
  if (committedIndex !== index) {
    setCommittedIndex(index);
    if (!levels[committedIndex]?.ultra && levels[index]?.ultra) setEffectKey((key) => key + 1);
  }

  const pct = dragPct ?? stopPosition(index, count);
  const live = dragPct === null ? index : nearestStop(dragPct, count);
  const ultra = levels[live]?.ultra === true;

  const pctFromClientX = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return stopPosition(index, count);
    const raw = ((clientX - rect.left) / rect.width) * 100;
    return Math.max(stopPosition(0, count), Math.min(stopPosition(count - 1, count), raw));
  };

  const commit = (next: number) => {
    const clamped = Math.max(0, Math.min(count - 1, next));
    if (clamped !== index) props.onCommit(clamped);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    pressRef.current = { x: event.clientX, moved: false };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const press = pressRef.current;
    if (!press) return;
    // a few pixels of jitter still counts as a click on the track
    if (!press.moved && Math.abs(event.clientX - press.x) < 3) return;
    press.moved = true;
    const next = pctFromClientX(event.clientX);
    const previous = dragPct === null ? index : nearestStop(dragPct, count);
    const nearest = nearestStop(next, count);
    if (nearest !== previous || dragPct === null) props.onPreviewChange(nearest);
    setDragPct(next);
  };

  const endPress = (event: PointerEvent<HTMLDivElement>) => {
    const press = pressRef.current;
    if (!press) return;
    pressRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const target = nearestStop(
      press.moved && dragPct !== null ? dragPct : pctFromClientX(event.clientX),
      count,
    );
    // dropping the drag state re-enables the snap transition in the same commit
    setDragPct(null);
    props.onPreviewChange(null);
    if (event.type !== "pointercancel") commit(target);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const next =
      event.key === "ArrowRight" || event.key === "ArrowUp"
        ? index + 1
        : event.key === "ArrowLeft" || event.key === "ArrowDown"
          ? index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? count - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    commit(next);
  };

  return (
    <div
      ref={trackRef}
      data-slot="effort-track"
      data-dragging={dragPct !== null ? "" : undefined}
      data-ultra={ultra ? "" : undefined}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={props.label}
      aria-disabled={disabled || undefined}
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={Math.max(0, count - 1)}
      aria-valuenow={live}
      aria-valuetext={levels[live]?.label}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPress}
      onPointerCancel={endPress}
      onKeyDown={onKeyDown}
    >
      <div data-slot="effort-clip">
        <div data-slot="effort-fill" style={{ width: `calc(${pct}% + 13px)` }}>
          <div data-slot="effort-ultra" aria-hidden="true">
            {SPARKS.map(([left, top]) => (
              <span
                key={`${left}:${top}`}
                data-slot="effort-spark"
                style={{ left: `${left}%`, top: `${top}%`, opacity: 0.45 + ((left * 7) % 5) / 10 }}
              />
            ))}
          </div>
          {effectKey > 0 ? <span key={effectKey} data-slot="effort-sheen" /> : null}
        </div>
      </div>
      {levels.map((level, stopIndex) => (
        <span
          key={level.id}
          aria-hidden="true"
          data-slot="effort-stop"
          data-ultra={level.ultra ? "" : undefined}
          data-default={level.isDefault ? "" : undefined}
          data-filled={stopPosition(stopIndex, count) <= pct + 0.01 ? "" : undefined}
          style={{ left: `${stopPosition(stopIndex, count)}%` }}
        />
      ))}
      <span aria-hidden="true" data-slot="effort-thumb" style={{ left: `${pct}%` }} />
      {effectKey > 0 ? (
        <span
          key={effectKey}
          aria-hidden="true"
          data-slot="effort-burst"
          style={{ left: `${stopPosition(index, count)}%` }}
        >
          {BURST.map((dot) => (
            <span
              key={dot.id}
              data-purple={dot.purple ? "" : undefined}
              style={{ "--dx": `${dot.dx}px`, "--dy": `${dot.dy}px` } as CSSProperties}
            />
          ))}
        </span>
      ) : null}
    </div>
  );
}
