// apps/web/src/lib/runtime.ts
// composes the web client runtime and local tracing

import * as ManagedRuntime from "effect/ManagedRuntime";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";

import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import * as PrimaryEnvironmentHttpClient from "../environments/primary/httpClient";
import * as PrimaryEnvironmentHttpLayer from "../environments/primary/httpLayer";

import * as Dpop from "../cloud/dpop";
import * as ManagedRelayLayer from "../cloud/managedRelayLayer";
import * as ClientTracer from "../observability/clientTracer";

const layerHttpClient = layerRemoteHttpClient((input, init) => globalThis.fetch(input, init));

type RuntimeLayerSource =
  | typeof layerHttpClient
  | typeof Dpop.layer
  | typeof Socket.layerWebSocketConstructorGlobal
  | typeof ClientTracer.layer
  | ReturnType<typeof ManagedRelayLayer.layer>;

const primaryHttpRuntime = ManagedRuntime.make(
  PrimaryEnvironmentHttpClient.layer.pipe(Layer.provide(PrimaryEnvironmentHttpLayer.layer)),
);

export type PrimaryHttpEffectRunner = <A, E>(
  effect: Effect.Effect<A, E, PrimaryEnvironmentHttpClient.PrimaryEnvironmentHttpClient>,
) => Promise<A>;

const livePrimaryHttpRunner: PrimaryHttpEffectRunner = (effect) =>
  primaryHttpRuntime.runPromise(effect);

let primaryHttpRunner = livePrimaryHttpRunner;

export const runPrimaryHttp = <A, E>(
  effect: Effect.Effect<A, E, PrimaryEnvironmentHttpClient.PrimaryEnvironmentHttpClient>,
) => primaryHttpRunner(effect);

export function __setPrimaryHttpRunnerForTests(runner?: PrimaryHttpEffectRunner): void {
  primaryHttpRunner = runner ?? livePrimaryHttpRunner;
}

const layerRuntime = Layer.mergeAll(
  layerHttpClient,
  Dpop.layer,
  Socket.layerWebSocketConstructorGlobal,
  ClientTracer.layer,
  // the dormant DPoP authorizer still requires a relay client; an invalid origin yields a disabled one
  ManagedRelayLayer.layer("http://relay.invalid").pipe(
    Layer.provide(Layer.mergeAll(layerHttpClient, Dpop.layer)),
  ),
);

const runtime: ManagedRuntime.ManagedRuntime<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = ManagedRuntime.make(layerRuntime);

export const layer: Layer.Layer<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = Layer.effectContext(runtime.contextEffect);
