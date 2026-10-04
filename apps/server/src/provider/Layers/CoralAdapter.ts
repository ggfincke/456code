// apps/server/src/provider/Layers/CoralAdapter.ts
// adapts supervised coral sessions to upstream v2 orchestration
import {
  ProviderDriverKind,
  type CoralSettings,
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import type { ChildProcessSpawner } from "effect/unstable/process";

import * as ProviderAdapter from "../../orchestration-v2/ProviderAdapter.ts";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Options,
} from "../../orchestration-v2/Adapters/AcpAdapterV2.ts";
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
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
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

export function makeCoralAdapter(
  coralSettings: CoralSettings,
  options: CoralAdapterLiveOptions,
): ProviderAdapter.ProviderAdapterV2Shape {
  const adapter = makeAcpAdapterV2({
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
          childProcessSpawner: options.childProcessSpawner,
          environment: { ...options.environment, ...input.processEnvironment },
        }).pipe(
          Effect.provideService(Crypto.Crypto, options.crypto),
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
  return {
    ...adapter,
    openSession: (input) =>
      validatePolicy(input.runtimePolicy).pipe(
        Effect.andThen(adapter.openSession(input)),
        Effect.map((session) => ({
          ...session,
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
                  : session.startTurn(turn),
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
  };
}
