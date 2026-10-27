// apps/server/src/provider/Layers/CoralAdapter.ts
// adapts supervised coral sessions to upstream v2 orchestration
import {
  ProviderDriverKind,
  type CoralSettings,
  type ModelSelection,
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
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
  makeCoralAcpRuntime,
} from "../acp/CoralAcpSupport.ts";

const DRIVER = ProviderDriverKind.make("coral");
const CAPABILITIES = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
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

const validatePolicy = (policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy) =>
  policy.runtimeMode === "approval-required" && policy.interactionMode === "default"
    ? Effect.void
    : Effect.fail(
        new ProviderAdapter.ProviderAdapterProtocolError({
          driver: DRIVER,
          detail:
            "Coral supports supervised approval-required sessions in default interaction mode.",
        }),
      );

// coral only supports selecting a model; native acp options cannot override its fixed modes
const nativeCoralModelSelection = ({ instanceId, model }: ModelSelection): ModelSelection => ({
  instanceId,
  model,
});

export const makeCoralAdapter = Effect.fn("makeCoralAdapter")(function* (
  coralSettings: CoralSettings,
  options: CoralAdapterLiveOptions,
) {
  const crypto = yield* Crypto.Crypto;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const adapter = yield* makeAcpAdapterV2({
    ...options,
    flavor: {
      driver: DRIVER,
      runtimeHarness: "Coral",
      capabilities: CAPABILITIES,
      preferResumeSession: true,
      sessionModeForPolicy: () => "default",
      makeRuntime: (input) =>
        makeCoralAcpRuntime({
          ...input,
          coralSettings,
          childProcessSpawner,
          environment: { ...options.environment, ...input.processEnvironment },
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.map((runtime) => ({
            ...runtime,
            start: () =>
              runtime.start().pipe(
                Effect.tap(() =>
                  applyCoralAcpRuntimeMode({
                    runtime,
                    runtimeMode: "approval-required",
                    mapError: (cause) => cause,
                  }),
                ),
                Effect.tap(
                  (started) => options.onSessionSetup?.(started.sessionSetupResult) ?? Effect.void,
                ),
              ),
          })),
        ),
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
