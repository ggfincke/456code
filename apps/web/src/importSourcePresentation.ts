// apps/web/src/importSourcePresentation.ts
// maps imported session sources to provider drivers and display labels
import {
  ProviderDriverKind,
  type ProviderDriverKind as ProviderDriverKindType,
  type ThreadImportSource,
} from "@t3tools/contracts";

interface ImportSourcePresentation {
  readonly displayName: string;
  readonly driverKind: ProviderDriverKindType;
}

const IMPORT_SOURCE_PRESENTATION = {
  "codex-cli": {
    displayName: "Codex CLI",
    driverKind: ProviderDriverKind.make("codex"),
  },
  "claude-code": {
    displayName: "Claude Code",
    driverKind: ProviderDriverKind.make("claudeAgent"),
  },
  opencode: {
    displayName: "OpenCode",
    driverKind: ProviderDriverKind.make("opencode"),
  },
  cursor: {
    displayName: "Cursor Agent",
    driverKind: ProviderDriverKind.make("cursor"),
  },
  grok: {
    displayName: "Grok",
    driverKind: ProviderDriverKind.make("grok"),
  },
} satisfies Readonly<Record<ThreadImportSource, ImportSourcePresentation>>;

export function importSourceDisplayName(source: ThreadImportSource): string {
  return IMPORT_SOURCE_PRESENTATION[source].displayName;
}

export function importSourceDriverKind(source: ThreadImportSource): ProviderDriverKindType {
  return IMPORT_SOURCE_PRESENTATION[source].driverKind;
}
