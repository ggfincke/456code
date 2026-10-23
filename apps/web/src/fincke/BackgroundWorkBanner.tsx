// apps/web/src/fincke/BackgroundWorkBanner.tsx
// fincke ocean's background work banner: a kind icon & plain label instead of the dot & "Running:" prefix
import "./backgroundWorkBanner.css";

import type { PendingBackgroundWorkPresentation } from "@t3tools/client-runtime/state/thread-execution";
import { ActivityIcon, BotIcon, SquareIcon, TerminalIcon } from "lucide-react";

import { useFinckeOcean } from "./useFinckeOcean";

type BackgroundWorkKind = PendingBackgroundWorkPresentation["items"][number]["kind"];

const KIND_ICONS = {
  command: TerminalIcon,
  background_task: TerminalIcon,
  subagent: BotIcon,
  monitor: ActivityIcon,
} satisfies Record<BackgroundWorkKind, typeof TerminalIcon>;

// rendered beside the upstream dot; css shows exactly one of them per theme.
// items arrive sorted by kind, so a mixed set takes its first kind's icon
export function FinckeBackgroundWorkIcon({
  presentation,
}: {
  presentation: PendingBackgroundWorkPresentation;
}) {
  const kind = presentation.items[0]?.kind ?? "background_task";
  const Icon = KIND_ICONS[kind];
  return (
    <Icon data-fincke-work-icon={presentation.waiting ? "waiting" : "running"} aria-hidden="true" />
  );
}

// the icon already names the kind, so the title keeps only a single task's label plus a
// dim tag for counts & waiting. unnamed tasks keep the upstream sentence
export function FinckeBackgroundWorkTitle({
  presentation,
}: {
  presentation: PendingBackgroundWorkPresentation;
}) {
  const fincke = useFinckeOcean();
  if (!fincke) return presentation.title;
  const { items, waiting } = presentation;
  const [only] = items;
  // an unnamed task's label falls back to its kind noun ("background task" for background_task)
  const named =
    items.length === 1 && only !== undefined && only.label !== only.kind.replace("_", " ");
  if (items.length === 1 && !named) return presentation.title;
  const tag = [waiting ? "waiting" : null, items.length > 1 ? `${items.length} tasks` : null]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <>
      {tag.length > 0 ? <span data-fincke-work-tag="">{tag}</span> : null}
      {named ? only.label : null}
    </>
  );
}

export function FinckeBackgroundWorkStopIcon() {
  return <SquareIcon data-fincke-work-stop-icon="" aria-hidden="true" />;
}
