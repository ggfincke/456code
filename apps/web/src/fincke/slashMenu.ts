// apps/web/src/fincke/slashMenu.ts
// sorts the / menu into commands, skills & plugins and trims descriptions to one sentence

import { resolveProviderSkillSourceKind } from "@t3tools/client-runtime/providerSkills";

import type { ComposerCommandItem } from "../components/chat/ComposerCommandMenu";

export type SlashMenuKind = "command" | "skill" | "plugin";

type SlashMenuItem = Extract<
  ComposerCommandItem,
  { type: "slash-command" | "provider-slash-command" | "skill" }
>;

const SLASH_MENU_KIND_ORDER: ReadonlyArray<SlashMenuKind> = ["command", "skill", "plugin"];

export const SLASH_MENU_SECTION_LABEL: Record<SlashMenuKind, string> = {
  command: "Commands",
  skill: "Skills",
  plugin: "Plugins",
};

// purple / blue / yellow under fincke ocean; other themes keep the inherited text color
export const SLASH_MENU_KIND_NAME_CLASS: Record<SlashMenuKind, string> = {
  command: "text-[color:var(--fincke-purple,currentColor)]",
  skill: "text-[color:var(--fincke-blue,currentColor)]",
  plugin: "text-[color:var(--fincke-yellow,currentColor)]",
};

function isSlashMenuItem(item: ComposerCommandItem): item is SlashMenuItem {
  return (
    item.type === "slash-command" || item.type === "provider-slash-command" || item.type === "skill"
  );
}

function slashMenuItemName(item: SlashMenuItem): string {
  if (item.type === "slash-command") return item.command;
  if (item.type === "provider-slash-command") return item.command.name;
  return item.skill.name;
}

// claude names plugin commands & skills `plugin:name`
function pluginPrefixOf(name: string): string | null {
  return /^([^\s:]+):\S/u.exec(name)?.[1] ?? null;
}

export function slashMenuKind(item: ComposerCommandItem): SlashMenuKind | null {
  if (!isSlashMenuItem(item)) return null;
  if (pluginPrefixOf(slashMenuItemName(item)) !== null) return "plugin";
  if (item.type !== "skill") return "command";
  // codex plugin skills keep plain names but live under a plugins directory
  return resolveProviderSkillSourceKind(item.skill) === "app" ? "plugin" : "skill";
}

// an empty query browses the whole menu; anything typed switches to one ranked list
export function isSlashMenuBrowse(query: string): boolean {
  return query.trim().replace(/^\/+/u, "") === "";
}

// stable, so built-ins stay ahead of provider commands and each kind keeps its incoming order
export function groupSlashMenuItems<T extends ComposerCommandItem>(items: ReadonlyArray<T>): T[] {
  const rank = (item: T) => {
    const kind = slashMenuKind(item);
    return kind === null ? SLASH_MENU_KIND_ORDER.length : SLASH_MENU_KIND_ORDER.indexOf(kind);
  };
  return items.toSorted((left, right) => rank(left) - rank(right));
}

export function slashMenuSections<T extends ComposerCommandItem>(
  items: ReadonlyArray<T>,
): Array<{ kind: SlashMenuKind | null; items: T[] }> {
  const sections: Array<{ kind: SlashMenuKind | null; items: T[] }> = [];
  for (const item of items) {
    const kind = slashMenuKind(item);
    const last = sections.at(-1);
    if (last && last.kind === kind) last.items.push(item);
    else sections.push({ kind, items: [item] });
  }
  return sections;
}

const CLAUSE_DASH = /\s+(?:\u2014|\u2013|--?)\s+/uy;
const ABBREVIATION_END = /(?:^|[\s(])(?:e\.g|i\.e|vs)\.$/iu;

// cut at the first sentence end or spaced dash outside brackets, so "(e.g. /loop 5m)" survives
function firstSentence(text: string): string {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (char === "(" || char === "[") {
      depth += 1;
      continue;
    }
    if ((char === ")" || char === "]") && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth > 0) continue;

    if (/\s/u.test(char)) {
      CLAUSE_DASH.lastIndex = index;
      const clause = CLAUSE_DASH.test(text) ? text.slice(0, index).trim() : "";
      if (clause) return clause;
      continue;
    }

    const next = text.charAt(index + 1);
    const endsSentence = (char === "." || char === "!" || char === "?") && !/\S/u.test(next);
    if (endsSentence && !(char === "." && ABBREVIATION_END.test(text.slice(0, index + 1)))) {
      const sentence = text.slice(0, char === "." ? index : index + 1).trim();
      if (sentence) return sentence;
    }
  }
  return text.trim();
}

// the provider repeats the plugin as a "(plugin) " lead-in when the name already carries it
export function slashMenuDescription(item: ComposerCommandItem): string {
  if (!isSlashMenuItem(item)) return item.description;
  const prefix = pluginPrefixOf(slashMenuItemName(item));
  const label = prefix ? `(${prefix})` : null;
  const description =
    label && item.description.startsWith(label)
      ? item.description.slice(label.length).trim()
      : item.description;
  return firstSentence(description);
}
