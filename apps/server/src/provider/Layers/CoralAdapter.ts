// apps/server/src/provider/Layers/CoralAdapter.ts
// adapts coral sessions and their permission modes to upstream v2 orchestration
import {
  ProviderDriverKind,
  type CoralSettings,
  type ModelSelection,
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { ChildProcessSpawner } from "effect/process";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Options,
} from "@t3tools/provider-acp/server/adapter";
import {
  applyCoralAcpModelSelection,
  applyCoralAcpRuntimeMode,
  coralModelsFromSessionSetup,
  currentCoralModelFromSessionSetup,
  isCoralRuntimeMode,
  makeCoralAcpRuntime,
  type CoralRuntimeMode,
} from "../acp/CoralAcpSupport.ts";

const DRIVER = ProviderDriverKind.make("coral");
const CAPABILITIES = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
    // applyRuntimePolicy pushes the mode before each prompt, so a switch keeps the session
    supportsRuntimeModeSwitchInSession: true,
  },
  threads: {
    ...AcpProviderCapabilitiesV2.threads,
    canRollbackThread: false,
  },
  turns: {
    ...AcpProviderCapabilitiesV2.turns,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
  },
  planning: {
    ...AcpProviderCapabilitiesV2.planning,
    supportsStructuredQuestions: false,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface CoralAdapterLiveOptions extends Omit<AcpAdapterV2Options, "flavor"> {
  readonly environment: NodeJS.ProcessEnv;
  readonly onSessionSetup?: (
    sessionSetupResult: Parameters<typeof coralModelsFromSessionSetup>[0],
  ) => Effect.Effect<void>;
}

// runtime policy resolution coerces auto to approval-required via the snapshot's supported modes
const validatePolicy = (policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy) =>
  isCoralRuntimeMode(policy.runtimeMode) && policy.interactionMode === "default"
    ? Effect.void
    : Effect.fail(
        new ProviderAdapter.ProviderAdapterProtocolError({
          driver: DRIVER,
          detail:
            "Coral supports Supervised, Auto-accept edits and Full access in default interaction mode.",
        }),
      );

// validatePolicy rejects other modes first; supervised is only the type-level fallback
const coralRuntimeMode = (
  policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
): CoralRuntimeMode =>
  isCoralRuntimeMode(policy.runtimeMode) ? policy.runtimeMode : "approval-required";

// coral only supports selecting a model; its permission mode comes from the runtime policy
const nativeCoralModelSelection = ({ instanceId, model }: ModelSelection): ModelSelection => ({
  instanceId,
  model,
});

export const makeCoralAdapter = Effect.fn("makeCoralAdapter")(function* (
  coralSettings: CoralSettings,
  options: CoralAdapterLiveOptions,
) {
  const crypto = yield* SecureRandom.SecureRandom;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const adapter = yield* makeAcpAdapterV2({
    ...options,
    flavor: {
      driver: DRIVER,
      runtimeHarness: "Coral",
      reportsPerTurnPromptUsage: true,
      capabilities: CAPABILITIES,
      sessionModeForPolicy: () => "default",
      makeRuntime: (input) =>
        makeCoralAcpRuntime({
          ...input,
          coralSettings,
          childProcessSpawner,
          environment: { ...options.environment, ...input.processEnvironment },
        }).pipe(
          Effect.provideService(SecureRandom.SecureRandom, crypto),
          Effect.map((runtime) => ({
            ...runtime,
            start: () =>
              runtime.start().pipe(
                Effect.tap(() =>
                  applyCoralAcpRuntimeMode({
                    runtime,
                    runtimeMode: coralRuntimeMode(input.runtimePolicy),
                    mapError: (cause) => cause,
                  }),
                ),
                Effect.tap(
                  (started) => options.onSessionSetup?.(started.sessionSetupResult) ?? Effect.void,
                ),
              ),
          })),
        ),
      applyRuntimePolicy: ({ runtime, runtimePolicy }) =>
        applyCoralAcpRuntimeMode({
          runtime,
          runtimeMode: coralRuntimeMode(runtimePolicy),
          mapError: (cause) => cause,
        }),
      applyModelSelection: ({ runtime, startResult, modelSelection }) =>
        applyCoralAcpModelSelection({
          runtime,
          currentModel: currentCoralModelFromSessionSetup(startResult.sessionSetupResult),
          requestedModel: modelSelection.model,
          mapError: (cause) => cause,
        }),
      onSessionConfigurationUpdate: (configOptions) =>
        options.onSessionSetup?.({ configOptions }) ?? Effect.void,
    },
  });
  return ProviderAdapter.ProviderAdapterV2.of({
    ...adapter,
    openSession: Effect.fn("CoralAdapterV2.openSession")((input) =>
      validatePolicy(input.runtimePolicy).pipe(
        Effect.andThen(
          adapter.openSession({
            ...input,
            modelSelection: nativeCoralModelSelection(input.modelSelection),
          }),
        ),
        Effect.map((session) => ({
          ...session,
          ensureThread: (thread) =>
            session.ensureThread({
              ...thread,
              modelSelection: nativeCoralModelSelection(thread.modelSelection),
            }),
          resumeThread: (thread) =>
            session.resumeThread({
              ...thread,
              ...(thread.modelSelection === undefined
                ? {}
                : { modelSelection: nativeCoralModelSelection(thread.modelSelection) }),
            }),
          startTurn: (turn) =>
            validatePolicy(turn.runtimePolicy).pipe(
              Effect.andThen(
                turn.message.attachments.length > 0
                  ? Effect.fail(
                      new ProviderAdapter.ProviderAdapterProtocolError({
                        driver: DRIVER,
                        detail: "Coral does not support attachments yet.",
                      }),
                    )
                  : session.startTurn({
                      ...turn,
                      modelSelection: nativeCoralModelSelection(turn.modelSelection),
                    }),
              ),
            ),
          respondToRuntimeRequest: (request) =>
            request.answers !== undefined
              ? Effect.fail(
                  new ProviderAdapter.ProviderAdapterProtocolError({
                    driver: DRIVER,
                    detail: "Coral does not support structured user input yet.",
                  }),
                )
              : session.respondToRuntimeRequest(request),
          rollbackThread: () =>
            Effect.fail(
              new ProviderAdapter.ProviderAdapterProtocolError({
                driver: DRIVER,
                detail: "Coral does not support conversation rollback.",
              }),
            ),
        })),
      ),
    ),
  });
});
