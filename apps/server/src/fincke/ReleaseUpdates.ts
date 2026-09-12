import { ServerSelfUpdateError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerSelfUpdate } from "../cloud/selfUpdate.ts";

const disabled = () =>
  Effect.fail(
    new ServerSelfUpdateError({
      reason:
        "Updates are disabled for the 456code replacement until a fork-specific release destination is configured.",
    }),
  );
export const layer = Layer.succeed(ServerSelfUpdate, {
  update: disabled,
  commitDesktopUpdate: disabled,
});
