// packages/shared/src/fincke-effort-scale.ts
// the effort chip's level bars, shared by the web picker and the native composer

const ULTRA_LEVEL_IDS: ReadonlySet<string> = new Set(["ultra", "ultracode", "ultrathink"]);
// a scale that starts at off shows that level as no bars lit
const OFF_LEVEL_IDS: ReadonlySet<string> = new Set(["off", "none"]);

/** Ultra levels sit above the ordinary scale and get their own treatment instead of bars. */
export function isFinckeUltraEffort(levelId: string): boolean {
  return ULTRA_LEVEL_IDS.has(levelId);
}

/** One bar per ordinary level, lit up to the current one; an unknown level lights none. */
export function finckeEffortBars(
  levelIds: ReadonlyArray<string>,
  currentId: string | null | undefined,
): { readonly count: number; readonly filled: number } {
  const ordinary = levelIds.filter((id) => !ULTRA_LEVEL_IDS.has(id));
  const startsOff = OFF_LEVEL_IDS.has(ordinary[0] ?? "");
  const index = currentId ? ordinary.indexOf(currentId) : -1;
  return {
    count: ordinary.length - (startsOff ? 1 : 0),
    filled: Math.max(0, index + (startsOff ? 0 : 1)),
  };
}

/** Bar heights rising by one whole step, from about half height up to `maxBar`. */
export function finckeEffortBarHeights(count: number, maxBar: number): number[] {
  // rounding each bar separately mixes step sizes, so round the step once
  const step = Math.max(1, Math.round(maxBar / 2 / Math.max(count - 1, 1)));
  return Array.from({ length: count }, (_, index) => maxBar - (count - 1 - index) * step);
}
