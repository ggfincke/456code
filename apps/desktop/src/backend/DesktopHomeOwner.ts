// @effect-diagnostics nodeBuiltinImport:off - Probes the server's native SQLite ownership lock.
import * as NodeSqlite from "node:sqlite";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { msg } from "gt-i18n";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { DESKTOP_APP_NAME } from "../fincke/build.ts";
import { m } from "../i18n/messages.ts";
import { BACKEND_QUIT_STOP_TIMEOUT } from "./DesktopBackendManager.ts";

// The fields of the server's `server-runtime.json` that identify the owner of a data directory.
const HomeOwnerRuntimeState = Schema.Struct({
  pid: Schema.Int,
  port: Schema.Int,
  serverVersion: Schema.optional(Schema.String),
});
export type HomeOwner = typeof HomeOwnerRuntimeState.Type;

const decodeHomeOwner = Schema.decodeUnknownOption(Schema.fromJsonString(HomeOwnerRuntimeState));

/** Signal 0 only probes existence; EPERM still means alive. */
const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

/**
 * Whether a server holds the T3 home's ownership lock (an exclusive transaction on
 * `server-owner.sqlite`). A read-only read is refused with SQLITE_BUSY only while it is held.
 */
const isHomeOwnershipLocked = Effect.fn("DesktopHomeOwner.isHomeOwnershipLocked")(function* () {
  const path = yield* Path.Path;
  const { stateDir } = yield* DesktopEnvironment.DesktopEnvironment;
  const lockPath = path.join(stateDir, "server-owner.sqlite");
  return yield* Effect.sync(() => {
    try {
      const db = new NodeSqlite.DatabaseSync(lockPath, { readOnly: true });
      try {
        db.exec("PRAGMA busy_timeout = 0");
        db.prepare("SELECT count(*) FROM sqlite_master").get();
        return false;
      } finally {
        db.close();
      }
    } catch (cause) {
      // Anything but SQLITE_BUSY (a missing file included) leaves the decision to the backend.
      return cause instanceof Error && "errcode" in cause && cause.errcode === 5;
    }
  });
});

// A quitting app's backend holds the lock until it exits, which can outlast the relaunch of an update.
const HOME_OWNERSHIP_RELEASE_GRACE = Duration.sum(BACKEND_QUIT_STOP_TIMEOUT, Duration.seconds(3));
const HOME_OWNERSHIP_RELEASE_POLL_INTERVAL = Duration.millis(250);

/** Whether the ownership lock is free, or frees within the grace a shutting-down server needs. */
export const awaitHomeOwnershipRelease = Effect.fn("DesktopHomeOwner.awaitHomeOwnershipRelease")(
  function* () {
    while (yield* isHomeOwnershipLocked()) {
      yield* Effect.sleep(HOME_OWNERSHIP_RELEASE_POLL_INTERVAL);
    }
    return true;
  },
  Effect.timeoutOrElse({
    duration: HOME_OWNERSHIP_RELEASE_GRACE,
    orElse: () => Effect.succeed(false),
  }),
);

/** The live server recorded as owning the desktop's T3 home. Only call once the ownership lock is known held: a live PID alone may be reused. */
export const readLiveHomeOwner = Effect.fn("DesktopHomeOwner.readLiveHomeOwner")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* DesktopEnvironment.DesktopEnvironment;
  const raw = yield* fs
    .readFileString(path.join(stateDir, "server-runtime.json"))
    .pipe(Effect.option);
  return Option.flatMap(raw, decodeHomeOwner).pipe(
    Option.filter((owner) => isProcessAlive(owner.pid)),
  );
});

export const homeOwnedMessage = (owner: Option.Option<HomeOwner>): string =>
  Option.match(owner, {
    onNone: () =>
      m(
        msg(
          "Another {app} server is using this data directory. Stop that server, then reopen {app}. You can also set a separate T3CODE_HOME and pair with the running server.",
        ),
        { app: DESKTOP_APP_NAME },
      ),
    onSome: (owner) => {
      const variables = {
        app: DESKTOP_APP_NAME,
        pid: String(owner.pid),
        port: String(owner.port),
        version: owner.serverVersion ?? "",
      };
      return owner.serverVersion
        ? m(
            msg(
              "Another {app} server is using this data directory (PID {pid}, port {port}, version {version}). Stop that server, then reopen {app}. You can also set a separate T3CODE_HOME and pair with the running server.",
            ),
            variables,
          )
        : m(
            msg(
              "Another {app} server is using this data directory (PID {pid}, port {port}). Stop that server, then reopen {app}. You can also set a separate T3CODE_HOME and pair with the running server.",
            ),
            variables,
          );
    },
  });
