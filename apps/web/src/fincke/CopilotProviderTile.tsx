// apps/web/src/fincke/CopilotProviderTile.tsx
// featured add-provider tile that opens github copilot's acp registry entry
import {
  ProviderDriverKind,
  type AcpRegistrySearchAgent,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";

import { ProviderInstanceIcon } from "../components/chat/ProviderInstanceIcon";
import type { AcpRegistrySearch } from "../components/settings/AcpRegistrySearchStep";
import { isConfiguredAcpRegistryAgent } from "../components/settings/AddProviderInstanceDialog.logic";

// copilot is a priority provider w/o its own driver (docs/principles.md section 5), so the tile
// runs the same prepare flow as picking it from registry search
const COPILOT_ACP_REGISTRY_AGENT_ID = "github-copilot-cli";
const ACP_REGISTRY_DRIVER_KIND = ProviderDriverKind.make("acpRegistry");

// mirrors the ProviderOptionGrid tile in AddProviderInstanceDialog, minus the checked states
const TILE_CLASS_NAME =
  "relative flex cursor-pointer items-center gap-3 rounded-lg bg-card px-3 py-3 text-left text-muted-foreground outline-none ring-1 ring-black/5 hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-64 dark:bg-white/3 dark:ring-white/5 dark:hover:bg-white/5";

export function CopilotProviderTile({
  registry,
  providerInstances,
  onPrepared,
  onShowRegistry,
}: {
  readonly registry: AcpRegistrySearch;
  readonly providerInstances: Readonly<Record<string, ProviderInstanceConfig>>;
  readonly onPrepared: (agent: AcpRegistrySearchAgent) => void;
  readonly onShowRegistry: () => void;
}) {
  const agent = registry.search.data?.agents.find(
    (candidate) => candidate.id === COPILOT_ACP_REGISTRY_AGENT_ID,
  );
  const alreadyAdded = isConfiguredAcpRegistryAgent(
    providerInstances,
    COPILOT_ACP_REGISTRY_AGENT_ID,
  );
  const isPreparing = registry.preparingId === COPILOT_ACP_REGISTRY_AGENT_ID;

  const handleClick = async () => {
    // the registry list is fetched at runtime; until it has copilot, fall back to a prefilled search
    if (!agent) {
      registry.type("copilot");
      onShowRegistry();
      return;
    }
    let prepared = false;
    await registry.prepare(agent, (next) => {
      prepared = true;
      onPrepared(next);
    });
    // prepare errors only render inside the registry fold
    if (!prepared) onShowRegistry();
  };

  return (
    <button
      type="button"
      className={TILE_CLASS_NAME}
      disabled={alreadyAdded || registry.preparingId !== null}
      onClick={() => void handleClick()}
      // the tile sits inside the provider RadioGroup; keep its arrow-key roving from picking a
      // radio while this plain button has focus
      onKeyDown={(event) => {
        if (event.key.startsWith("Arrow")) event.stopPropagation();
      }}
    >
      <ProviderInstanceIcon
        driverKind={ACP_REGISTRY_DRIVER_KIND}
        displayName="GitHub Copilot"
        acpRegistryAgentId={COPILOT_ACP_REGISTRY_AGENT_ID}
        acpRegistryIconUrl={agent?.icon ?? undefined}
        iconClassName="size-4"
      />
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
        GitHub Copilot
      </span>
      {alreadyAdded || isPreparing ? (
        <span className="shrink-0 text-xs">{alreadyAdded ? "Added" : "Preparing"}</span>
      ) : null}
    </button>
  );
}
