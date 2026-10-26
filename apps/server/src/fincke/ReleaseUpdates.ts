// apps/server/src/fincke/ReleaseUpdates.ts
// server self-update limited to the hosting desktop app's locally staged build
import { ServerSelfUpdateError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerSelfUpdate } from "../cloud/selfUpdate.ts";
import { DesktopAppUpdate } from "../desktopUpdate/DesktopAppUpdate.ts";

// upstream's npm runtime & background-service updates stay off: 456code has no published
// release, only the build the stager leaves next to the desktop app
export const disabled = () =>
  Effect.fail(
    new ServerSelfUpdateError({
      reason:
        "Updates are disabled for this 456code server; only the desktop app hosting it can update, from its locally staged build.",
    }),
  );

export const layer = Layer.effect(
  ServerSelfUpdate,
  Effect.gen(function* () {
    const desktopAppUpdate = yield* DesktopAppUpdate;
    return ServerSelfUpdate.of({
      update: (_input, reportProgress = () => Effect.void) =>
        desktopAppUpdate.available ? desktopAppUpdate.run(reportProgress) : disabled(),
      commitDesktopUpdate: (requestId, onHandoffAccepted) =>
        desktopAppUpdate.available
          ? desktopAppUpdate.commit(requestId, onHandoffAccepted)
          : disabled(),
    });
  }),
);
