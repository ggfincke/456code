import type {
  CoralSettings,
  ModelCapabilities,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  buildCoralAcpEnvironment,
  coralModelsFromSessionSetup,
  DEFAULT_CORAL_MODEL,
  makeCoralAcpRuntime,
  normalizeCoralOllamaHost,
} from "../acp/CoralAcpSupport.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { HttpClient, HttpClientResponse, HttpIncomingMessage } from "effect/unstable/http";

const CORAL_PRESENTATION = {
  displayName: "Coral",
  supportsConversationRollback: false,
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const CORAL_PROBE_TIMEOUT_MS = 4_000;

const CORAL_FALLBACK_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: DEFAULT_CORAL_MODEL,
    name: DEFAULT_CORAL_MODEL,
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function coralProviderModelsFromSessionSetup(
  sessionSetupResult: Parameters<typeof coralModelsFromSessionSetup>[0],
): ReadonlyArray<ServerProviderModel> {
  return coralModelsFromSessionSetup(sessionSetupResult).map((model) => ({
    slug: model.slug,
    name: model.name,
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  }));
}

// empty keeps the pre-session fallback so a resume without inventory does not wipe the picker
export function overlayCoralSessionModels<
  Snapshot extends { readonly models: ReadonlyArray<ServerProviderModel> },
>(snapshot: Snapshot, sessionModels: ReadonlyArray<ServerProviderModel>): Snapshot {
  if (sessionModels.length === 0) return snapshot;
  return { ...snapshot, models: sessionModels };
}

export function buildInitialCoralProviderSnapshot(
  coralSettings: CoralSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    if (!coralSettings.enabled) {
      return buildServerProvider({
        presentation: CORAL_PRESENTATION,
        enabled: false,
        checkedAt,
        models: CORAL_FALLBACK_MODELS,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown", label: "No authentication required" },
          message: "Coral is disabled in 456code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: CORAL_PRESENTATION,
      enabled: true,
      checkedAt,
      models: CORAL_FALLBACK_MODELS,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown", label: "No authentication required" },
        message: "Checking Coral CLI availability...",
      },
    });
  });
}

const OllamaModels = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({ name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)) }),
  ).check(Schema.isMaxLength(512)),
});

export const checkCoralProviderStatus = Effect.fn("checkCoralProviderStatus")(function* (
  coralSettings: CoralSettings,
  environment: NodeJS.ProcessEnv = process.env,
  lastKnownModels: ReadonlyArray<ServerProviderModel> = [],
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | HttpClient.HttpClient
> {
  if (!coralSettings.enabled) return yield* buildInitialCoralProviderSnapshot(coralSettings);
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const runtimeEnvironment = buildCoralAcpEnvironment(coralSettings, environment);
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const initialized = yield* Effect.gen(function* () {
    const runtime = yield* makeCoralAcpRuntime({
      coralSettings,
      environment: runtimeEnvironment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    return yield* runtime.initialize();
  }).pipe(Effect.scoped, Effect.timeoutOption(CORAL_PROBE_TIMEOUT_MS), Effect.result);
  const snapshot = (input: {
    installed?: boolean;
    version?: string | null;
    message?: string;
    models?: ReadonlyArray<ServerProviderModel>;
  }) =>
    buildServerProvider({
      presentation: CORAL_PRESENTATION,
      enabled: true,
      checkedAt,
      models: input.models ?? lastKnownModels,
      probe: {
        installed: input.installed ?? true,
        version: input.version ?? null,
        status: input.message ? "error" : "ready",
        auth: { status: "unknown", label: "No authentication required" },
        ...(input.message ? { message: input.message } : {}),
      },
    });
  if (Result.isFailure(initialized))
    return snapshot({
      installed: !isCommandMissingCause(initialized.failure),
      message:
        "Cannot initialize Coral ACP. Configure a Coral build supporting `coral acp` and check its executable path.",
    });
  if (Option.isNone(initialized.success))
    return snapshot({
      message: "Coral ACP initialization timed out. Check the executable path and launcher.",
    });
  const init = initialized.success.value;
  const version = init.agentInfo?.version ?? null;
  if (init.protocolVersion !== 1 || !init.agentCapabilities?.sessionCapabilities?.resume)
    return snapshot({
      version,
      message:
        "This Coral build does not support the required ACP protocol and native session resume.",
    });
  if ((init.authMethods?.length ?? 0) > 0)
    return snapshot({
      version,
      message:
        "This Coral agent requires authentication, which the Coral integration does not support.",
    });
  const inventory = yield* Effect.gen(function* () {
    const host = yield* Effect.try(() => normalizeCoralOllamaHost(coralSettings.ollamaHost));
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .get(`${host}/api/tags`)
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
    return yield* HttpClientResponse.schemaBodyJson(OllamaModels)(response);
  }).pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, FileSystem.Size(1_048_576)),
    Effect.timeoutOption(CORAL_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(inventory) || Option.isNone(inventory.success))
    return snapshot({
      version,
      message:
        "Cannot read models from the configured Ollama endpoint. Check Ollama and refresh; the last known model list is retained.",
    });
  const names = [...new Set(inventory.success.value.models.map((model) => model.name))];
  if (names.length === 0)
    return snapshot({
      version,
      models: [],
      message: "No models are installed on the configured Ollama server.",
    });
  return snapshot({
    version,
    models: names.map((name) => ({
      slug: name,
      name,
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    })),
  });
});

export const enrichCoralSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> =>
  enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap(input.publishSnapshot),
    Effect.catchCause((cause) =>
      Effect.logWarning("Coral version advisory enrichment failed.", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
