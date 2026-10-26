// apps/web/src/fincke/hostAppUpdateTargets.ts
// limits desktop-hosted update targets to hosts that announced a newer staged build
import type { HostAppUpdate } from "@t3tools/contracts";

import type { ServerUpdateTarget } from "~/components/ServerUpdateAction";
import type { UpdateEverythingMachine } from "~/components/sidebar/updateEverything.logic";
import {
  resolveServerSelfUpdateCapability,
  supportsDesktopAppUpdate,
  supportsServerUpdateThreadContinuation,
} from "~/versionSkew";

export type HostAppUpdateMachine = UpdateEverythingMachine & {
  readonly hostAppUpdate: HostAppUpdate | null | undefined;
};

// a desktop-hosted server installs only what its own stager built, so being behind this
// client is not enough: until the host announces that build the update would just report
// "already up to date". Other servers keep upstream's version-skew targeting.
export function withoutUnstagedDesktopTargets(
  targets: ReadonlyArray<ServerUpdateTarget>,
  machines: ReadonlyArray<HostAppUpdateMachine>,
): ReadonlyArray<ServerUpdateTarget> {
  const staged = new Set(
    machines.filter((machine) => machine.hostAppUpdate).map((machine) => machine.environmentId),
  );
  return targets.filter(
    (target) => target.selfUpdate !== "desktop-managed" || staged.has(target.environmentId),
  );
}

// upstream only offers a host update when this client is newer than the server. 456code's
// builds are staged on each host instead, so a host announcing one is also a target, even
// when this client is the older side. Machines this app hosts use its own update pill.
export function withHostAppUpdateTargets(
  targets: ReadonlyArray<ServerUpdateTarget>,
  machines: ReadonlyArray<HostAppUpdateMachine>,
): ReadonlyArray<ServerUpdateTarget> {
  const targeted = new Set(targets.map((target) => target.environmentId));
  const added = machines.flatMap((machine): Array<ServerUpdateTarget> => {
    const config = machine.serverConfig;
    if (
      !machine.hostAppUpdate ||
      config === null ||
      targeted.has(machine.environmentId) ||
      machine.hostedByThisApp ||
      !machine.connected ||
      !machine.canMaintain ||
      machine.updateState.status === "running" ||
      resolveServerSelfUpdateCapability(config) !== "desktop-managed" ||
      !supportsDesktopAppUpdate(config)
    ) {
      return [];
    }
    return [
      {
        environmentId: machine.environmentId,
        serverLabel: machine.label,
        selfUpdate: "desktop-managed",
        desktopAppUpdate: true,
        threadContinuation: supportsServerUpdateThreadContinuation(config),
        continueThreadsAfterServerUpdate: config.settings.continueThreadsAfterServerUpdate ?? false,
        targetVersion: machine.hostAppUpdate.availableVersion,
      },
    ];
  });
  return added.length === 0 ? targets : [...targets, ...added];
}
