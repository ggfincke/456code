// apps/server/src/fincke/HostAppUpdates.ts
// the hosting desktop app's newer staged build, read from its updater reports
import type { DesktopUpdateState, HostAppUpdate } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";

/**
 * Remote clients cannot see the desktop app's own update pill, so the server republishes
 * whether its host has a newer build ready. The install itself goes through the existing
 * desktop-managed `server.updateServer` flow.
 */
export class HostAppUpdates extends Context.Service<
  HostAppUpdates,
  {
    readonly available: boolean;
    /** Emits the current value on subscribe, then each change. */
    readonly streamChanges: Stream.Stream<HostAppUpdate | null>;
  }
>()("t3/fincke/HostAppUpdates") {}

export function resolveHostAppUpdate(state: DesktopUpdateState): HostAppUpdate | null {
  if (!state.enabled) return null;
  const availableVersion = state.downloadedVersion ?? state.availableVersion;
  if (availableVersion === null || availableVersion === state.currentVersion) return null;
  return { currentVersion: state.currentVersion, availableVersion };
}

const sameUpdate = (left: HostAppUpdate | null, right: HostAppUpdate | null) =>
  left?.availableVersion === right?.availableVersion &&
  left?.currentVersion === right?.currentVersion;

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const receiver = yield* DesktopTelemetryReceiver.DesktopTelemetryReceiver;
  // same condition DesktopAppUpdate uses: only a desktop-hosted server hears its app's updater
  const available = config.mode === "desktop" && config.desktopTelemetryControlFd !== undefined;

  const streamChanges: Stream.Stream<HostAppUpdate | null> = available
    ? Stream.unwrap(
        Effect.map(receiver.desktopUpdates, ({ latest, changes }) =>
          Stream.concat(
            Stream.make(Option.getOrNull(Option.map(latest, (report) => report.state))),
            changes.pipe(Stream.map((report) => report.state)),
          ).pipe(
            Stream.map((state) => (state === null ? null : resolveHostAppUpdate(state))),
            Stream.changesWith(sameUpdate),
          ),
        ),
      )
    : Stream.make(null);

  return HostAppUpdates.of({ available, streamChanges });
});

export const layer = Layer.effect(HostAppUpdates, make);
