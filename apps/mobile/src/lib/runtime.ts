// apps/mobile/src/lib/runtime.ts
// composes mobile connections and protected persistence

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Socket from "effect/socket/Socket";

import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import { RelayMobileClientId } from "@t3tools/contracts/relay";

import * as Persistence from "../persistence/layer";
import * as ExpoCrypto from "./expoCrypto";
import { disposeOnFoundationReplace, type FoundationHotModule } from "./foundation-fast-refresh";
import { whenProtectedDataAvailable } from "./protectedData";

declare const module: { readonly hot?: FoundationHotModule } | undefined;

const layerHttpClient = layerRemoteHttpClient(fetch);

// client-runtime's relay connection path still requires these services; relay environments are unsupported
const layerRelayUnavailable = ManagedRelay.layer({
  relayUrl: "",
  clientId: RelayMobileClientId,
}).pipe(
  Layer.provideMerge(
    Layer.succeed(
      ManagedRelay.ManagedRelayDpopSigner,
      ManagedRelay.ManagedRelayDpopSigner.of({
        thumbprint: Effect.fail(
          new ManagedRelay.ManagedRelayDpopKeyLoadError({
            keyStore: "expo-secure-store",
            cause: "Relay environments are not supported.",
          }),
        ),
        createProof: (input) =>
          Effect.fail(
            new ManagedRelay.ManagedRelayDpopProofCreationError({
              method: input.method,
              url: input.url,
              cause: "Relay environments are not supported.",
            }),
          ),
      }),
    ),
  ),
);

type RuntimeLayerSource =
  | typeof layerRelayUnavailable
  | typeof Socket.layerWebSocketConstructorGlobal
  | typeof ExpoCrypto.layer
  | typeof layerHttpClient
  | typeof Persistence.layer;

const layerRuntime = Layer.merge(
  layerRelayUnavailable,
  Socket.layerWebSocketConstructorGlobal,
).pipe(
  Layer.provideMerge(ExpoCrypto.layer),
  Layer.provideMerge(layerHttpClient),
  Layer.provideMerge(Persistence.layer),
  // These layers read the keychain and the database while they build, and a
  // failed build is kept for the life of the process.
  Layer.provide(Layer.effectDiscard(Effect.promise(whenProtectedDataAvailable))),
);

export const runtime: ManagedRuntime.ManagedRuntime<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = ManagedRuntime.make(layerRuntime);

export const layer: Layer.Layer<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = Layer.effectContext(runtime.contextEffect);

disposeOnFoundationReplace(typeof module === "undefined" ? undefined : module.hot, () =>
  runtime.dispose(),
);
