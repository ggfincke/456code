// packages/shared/src/fincke-draft-headline.ts
// rotating new-thread headlines shared by web and native, one stable pick per draft

/** A project headline split so the project name can sit inline or on its own line. */
export interface ProjectHeadline {
  // the question w/o its mark; reads alone as "<lead>?" when the name wraps below
  readonly lead: string;
  // joins the lead to the project name when they share a line
  readonly joiner: string;
}

// the first entry is the original line & the fallback for a draft w/o an id
const PROJECT_HEADLINES: ReadonlyArray<ProjectHeadline> = [
  { lead: "What should we build", joiner: "in" },
  { lead: "What are we shipping", joiner: "in" },
  { lead: "What's next", joiner: "for" },
  { lead: "Where were we", joiner: "in" },
  { lead: "What needs fixing", joiner: "in" },
  { lead: "What's the plan", joiner: "for" },
  { lead: "What are we breaking", joiner: "in" },
  { lead: "What could go wrong", joiner: "in" },
];

const SCRATCH_HEADLINES: ReadonlyArray<string> = [
  "What should we work on?",
  "What's on your mind?",
  "Where should we start?",
  "What are we figuring out?",
  "What are we poking at?",
  "Got a half-baked idea?",
];

// fnv-1a keeps a draft's line stable across rerenders, reloads & clients
function pick<T>(lines: ReadonlyArray<T>, draftId: string | null | undefined): T {
  if (!draftId) return lines[0]!;
  let hash = 0x811c9dc5;
  for (let index = 0; index < draftId.length; index += 1) {
    hash ^= draftId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return lines[(hash >>> 0) % lines.length]!;
}

export function finckeProjectHeadline(draftId: string | null | undefined): ProjectHeadline {
  return pick(PROJECT_HEADLINES, draftId);
}

export function finckeScratchHeadline(draftId: string | null | undefined): string {
  return pick(SCRATCH_HEADLINES, draftId);
}
