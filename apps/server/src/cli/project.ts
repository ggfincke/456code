// apps/server/src/cli/project.ts
// executes project mutations against live or exclusively offline state
import {
  CommandId,
  EnvironmentHttpApi,
  EnvironmentHttpCommonError,
  type EnvironmentProjectCommandV1,
  EnvironmentStorageOwnerTokenHeaderName,
  type OrchestrationShellSnapshot,
  ProjectId,
} from '@t3tools/contracts'
import * as Console from 'effect/Console'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as References from 'effect/References'
import * as Schema from 'effect/Schema'
import { Argument, Command, Flag, GlobalFlag } from 'effect/unstable/cli'
import { FetchHttpClient, HttpClient, HttpClientError } from 'effect/unstable/http'
import * as HttpApiClient from 'effect/unstable/httpapi/HttpApiClient'

import * as ServerConfig from '../config.ts'
import * as OrchestrationEngine from '../orchestration/Services/OrchestrationEngine.ts'
import * as ProjectionSnapshotQuery from '../orchestration/Services/ProjectionSnapshotQuery.ts'
import { OrchestrationLayerLive } from '../orchestration/runtimeLayer.ts'
import { layerConfig as SqlitePersistenceLayerLive } from '../persistence/Layers/Sqlite.ts'
import * as RepositoryIdentityResolver from '../project/RepositoryIdentityResolver.ts'
import * as ServerStorageLease from '../serverStorageLease.ts'
import * as ServerRuntimeStartup from '../serverRuntimeStartup.ts'
import {
  clearPersistedServerRuntimeStateIfStale,
  type PersistedServerRuntimeState,
  readPersistedServerRuntimeState,
} from '../serverRuntimeState.ts'
import * as WorkspacePaths from '../workspace/WorkspacePaths.ts'
import {
  type CliAuthLocationFlags,
  projectLocationFlags,
  resolveCliAuthConfig,
  resolveProjectCliProbeConfig,
} from './config.ts'

type ProjectMutationTarget = {
  readonly id: ProjectId
  readonly title: string
  readonly workspaceRoot: string
}

type ProjectCommandExecutionMode = 'live' | 'offline'
type ProjectCliDispatchCommand = EnvironmentProjectCommandV1
type ProjectLiveProbeResult =
  | {
      readonly _tag: 'Live'
      readonly origin: string
      readonly storageOwnerToken: string
    }
  | {
      readonly _tag: 'Offline'
      readonly staleRuntimeState?: PersistedServerRuntimeState
    }

const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError)

export class ProjectCommandIdGenerationError extends Schema.TaggedErrorClass<ProjectCommandIdGenerationError>()(
  'ProjectCommandIdGenerationError',
  {
    operation: Schema.Literal('generateProjectCommandId'),
    cause: Schema.Defect(),
  },
)
{
  override get message(): string
  {
    return 'Failed to generate a project command identifier.'
  }
}

export class ProjectLiveServerDeclaredResponseError extends Schema.TaggedErrorClass<ProjectLiveServerDeclaredResponseError>()(
  'ProjectLiveServerDeclaredResponseError',
  {
    operation: Schema.Literal('callLiveServer'),
    code: Schema.String,
    traceId: Schema.String,
    cause: Schema.Defect(),
  },
)
{
  override get message(): string
  {
    return `Server request failed (${this.code}, trace ${this.traceId}).`
  }
}

export class ProjectLiveServerUndeclaredStatusError extends Schema.TaggedErrorClass<ProjectLiveServerUndeclaredStatusError>()(
  'ProjectLiveServerUndeclaredStatusError',
  {
    operation: Schema.Literal('callLiveServer'),
    status: Schema.Int,
    cause: Schema.Defect(),
  },
)
{
  override get message(): string
  {
    return `Server request failed with undeclared status ${this.status}.`
  }
}

export const ProjectLiveServerIncompatibilityReason = Schema.Literals([
  'storage_owner_capability_unavailable',
  'project_command_api_unavailable',
])
export type ProjectLiveServerIncompatibilityReason =
  typeof ProjectLiveServerIncompatibilityReason.Type

export class ProjectLiveServerIncompatibleError extends Schema.TaggedErrorClass<ProjectLiveServerIncompatibleError>()(
  'ProjectLiveServerIncompatibleError',
  {
    operation: Schema.Literal('callLiveServer'),
    reason: ProjectLiveServerIncompatibilityReason,
    cause: Schema.optional(Schema.Defect()),
  },
)
{
  override get message(): string
  {
    return this.reason === 'storage_owner_capability_unavailable'
      ? 'The running server does not support safe project CLI authentication.'
      : 'The running server does not support the versioned project command API.'
  }
}

export class ProjectLiveServerRequestError extends Schema.TaggedErrorClass<ProjectLiveServerRequestError>()(
  'ProjectLiveServerRequestError',
  {
    operation: Schema.Literal('callLiveServer'),
    cause: Schema.Defect(),
  },
)
{
  override get message(): string
  {
    return 'Failed to call the running server.'
  }
}

export class ProjectTitleEmptyError extends Schema.TaggedErrorClass<ProjectTitleEmptyError>()(
  'ProjectTitleEmptyError',
  {
    operation: Schema.Literal('validateProjectTitle'),
    title: Schema.String,
  },
)
{
  override get message(): string
  {
    return 'Project title cannot be empty.'
  }
}

export class ProjectIdentifierEmptyError extends Schema.TaggedErrorClass<ProjectIdentifierEmptyError>()(
  'ProjectIdentifierEmptyError',
  {
    operation: Schema.Literal('resolveProjectTarget'),
    identifier: Schema.String,
  },
)
{
  override get message(): string
  {
    return 'Project identifier cannot be empty.'
  }
}

export class ProjectNotFoundError extends Schema.TaggedErrorClass<ProjectNotFoundError>()(
  'ProjectNotFoundError',
  {
    operation: Schema.Literal('resolveProjectTarget'),
    identifier: Schema.String,
    normalizedWorkspaceRoot: Schema.optional(Schema.String),
    activeProjectCount: Schema.Number,
    cause: Schema.optional(Schema.Defect()),
  },
)
{
  override get message(): string
  {
    return `No active project found for '${this.identifier}'.`
  }
}

export class ProjectAlreadyExistsError extends Schema.TaggedErrorClass<ProjectAlreadyExistsError>()(
  'ProjectAlreadyExistsError',
  {
    operation: Schema.Literal('addProject'),
    projectId: ProjectId,
    workspaceRoot: Schema.String,
  },
)
{
  override get message(): string
  {
    return `An active project already exists for '${this.workspaceRoot}'.`
  }
}

export const ProjectCommandError = Schema.Union([
  ProjectCommandIdGenerationError,
  ProjectLiveServerDeclaredResponseError,
  ProjectLiveServerUndeclaredStatusError,
  ProjectLiveServerIncompatibleError,
  ProjectLiveServerRequestError,
  ProjectTitleEmptyError,
  ProjectIdentifierEmptyError,
  ProjectNotFoundError,
  ProjectAlreadyExistsError,
])
export type ProjectCommandError = typeof ProjectCommandError.Type

export function projectCommandErrorFromLiveServerRequest(cause: unknown): ProjectCommandError
{
  if (isEnvironmentHttpCommonError(cause))
  {
    return new ProjectLiveServerDeclaredResponseError({
      operation: 'callLiveServer',
      code: cause.code,
      traceId: cause.traceId,
      cause,
    })
  }
  if (HttpClientError.isHttpClientError(cause) && cause.response !== undefined)
  {
    return new ProjectLiveServerUndeclaredStatusError({
      operation: 'callLiveServer',
      status: cause.response.status,
      cause,
    })
  }

  return new ProjectLiveServerRequestError({ operation: 'callLiveServer', cause })
}

const projectCommandUuid = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.mapError(
    (cause) =>
      new ProjectCommandIdGenerationError({
        operation: 'generateProjectCommandId',
        cause,
      }),
  ),
)

const ProjectCliRuntimeLive = Layer.mergeAll(
  WorkspacePaths.layer,
  OrchestrationLayerLive.pipe(
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceLayerLive),
  ),
)

const PROJECT_CLI_LIVE_SERVER_TIMEOUT = Duration.seconds(1)
const withProjectCliLiveServerTimeout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.timeout(PROJECT_CLI_LIVE_SERVER_TIMEOUT))

const makeLiveServerClient = (origin: string) =>
  HttpApiClient.make(EnvironmentHttpApi, {
    baseUrl: origin,
  })

const normalizeWorkspaceRootForProjectCommand = Effect.fn(
  'normalizeWorkspaceRootForProjectCommand',
)(function* (workspaceRoot: string)
{
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths
  return yield* workspacePaths.normalizeWorkspaceRoot(workspaceRoot)
})

const resolveProjectTitle = Effect.fn('resolveProjectTitle')(function* (
  workspaceRoot: string,
  explicitTitle?: string,
)
{
  if (explicitTitle !== undefined)
  {
    const trimmed = explicitTitle.trim()
    if (trimmed.length > 0)
    {
      return trimmed
    }
    return yield* new ProjectTitleEmptyError({
      operation: 'validateProjectTitle',
      title: explicitTitle,
    })
  }

  const path = yield* Path.Path
  const basename = path.basename(workspaceRoot).trim()
  return basename.length > 0 ? basename : 'project'
})

const findActiveProjectTarget = Effect.fn('findActiveProjectTarget')(function* (input: {
  readonly snapshot: OrchestrationShellSnapshot
  readonly identifier: string
})
{
  const trimmedIdentifier = input.identifier.trim()
  if (trimmedIdentifier.length === 0)
  {
    return yield* new ProjectIdentifierEmptyError({
      operation: 'resolveProjectTarget',
      identifier: input.identifier,
    })
  }

  const activeProjects = input.snapshot.projects
  const exactIdMatch = activeProjects.find((project) => project.id === trimmedIdentifier)
  if (exactIdMatch)
  {
    return {
      id: exactIdMatch.id,
      title: exactIdMatch.title,
      workspaceRoot: exactIdMatch.workspaceRoot,
    } satisfies ProjectMutationTarget
  }

  const normalizedWorkspaceRootResult = yield* Effect.result(
    normalizeWorkspaceRootForProjectCommand(trimmedIdentifier),
  )
  const normalizedWorkspaceRoot =
    normalizedWorkspaceRootResult._tag === 'Success' ? normalizedWorkspaceRootResult.success : null

  const exactWorkspaceMatch =
    normalizedWorkspaceRoot === null
      ? undefined
      : activeProjects.find((project) => project.workspaceRoot === normalizedWorkspaceRoot)

  const resolved = exactWorkspaceMatch
  if (!resolved)
  {
    return yield* new ProjectNotFoundError({
      operation: 'resolveProjectTarget',
      identifier: trimmedIdentifier,
      activeProjectCount: activeProjects.length,
      ...(normalizedWorkspaceRoot === null ? {} : { normalizedWorkspaceRoot }),
      ...(normalizedWorkspaceRootResult._tag === 'Failure'
        ? { cause: normalizedWorkspaceRootResult.failure }
        : {}),
    })
  }

  return {
    id: resolved.id,
    title: resolved.title,
    workspaceRoot: resolved.workspaceRoot,
  } satisfies ProjectMutationTarget
})

const fetchLiveOrchestrationSnapshot = (origin: string, storageOwnerToken: string) =>
  Effect.gen(function* ()
  {
    const client = yield* makeLiveServerClient(origin)
    return yield* client.orchestration.shellSnapshot({
      headers: { [EnvironmentStorageOwnerTokenHeaderName]: storageOwnerToken },
    })
  }).pipe(
    withProjectCliLiveServerTimeout,
    Effect.mapError(projectCommandErrorFromLiveServerRequest),
  )

const dispatchLiveOrchestrationCommand = (
  origin: string,
  storageOwnerToken: string,
  command: ProjectCliDispatchCommand,
) =>
  Effect.gen(function* ()
  {
    const client = yield* makeLiveServerClient(origin)
    const headers = { [EnvironmentStorageOwnerTokenHeaderName]: storageOwnerToken }
    switch (command.type)
    {
      case 'project.create':
        yield* client.orchestration.dispatchProjectV1({ headers, payload: command })
        break
      case 'project.meta.update':
        yield* client.orchestration.dispatchProjectV1({ headers, payload: command })
        break
      case 'project.delete':
        yield* client.orchestration.dispatchProjectV1({ headers, payload: command })
        break
    }
  }).pipe(
    withProjectCliLiveServerTimeout,
    Effect.mapError((cause) =>
      HttpClientError.isHttpClientError(cause) && cause.response?.status === 404
        ? new ProjectLiveServerIncompatibleError({
            operation: 'callLiveServer',
            reason: 'project_command_api_unavailable',
            cause,
          })
        : projectCommandErrorFromLiveServerRequest(cause),
    ),
  )

const getOfflineSnapshot = Effect.fn('getOfflineSnapshot')(function* ()
{
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery
  return yield* projectionSnapshotQuery.getShellSnapshot()
})

const tryResolveLiveProjectExecutionMode = Effect.fn('tryResolveLiveProjectExecutionMode')(
  function* (config: ServerConfig.ServerConfig['Service'])
  {
    const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath)
    if (Option.isNone(runtimeState))
    {
      return { _tag: 'Offline' } satisfies ProjectLiveProbeResult
    }

    const storageOwnerToken = runtimeState.value.storageLeaseToken
    if (storageOwnerToken === undefined || storageOwnerToken.trim().length === 0)
    {
      return yield* new ProjectLiveServerIncompatibleError({
        operation: 'callLiveServer',
        reason: 'storage_owner_capability_unavailable',
      })
    }

    const attempt = fetchLiveOrchestrationSnapshot(
      runtimeState.value.origin,
      storageOwnerToken,
    ).pipe(
      Effect.as({
        origin: runtimeState.value.origin,
        storageOwnerToken,
      }),
    )

    const attempted = yield* Effect.result(attempt)
    if (attempted._tag === 'Success')
    {
      return {
        _tag: 'Live',
        ...attempted.success,
      } satisfies ProjectLiveProbeResult
    }

    yield* Effect.logDebug('Failed to connect to the persisted project CLI server.', {
      origin: runtimeState.value.origin,
      cause: attempted.failure,
    })
    return {
      _tag: 'Offline',
      staleRuntimeState: runtimeState.value,
    } satisfies ProjectLiveProbeResult
  },
)

const runProjectMutationUnscoped = Effect.fn('runProjectMutation')(function* (
  flags: CliAuthLocationFlags,
  run: (input: {
    readonly snapshot: OrchestrationShellSnapshot
    readonly dispatch: (
      command: ProjectCliDispatchCommand,
    ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>
    readonly mode: ProjectCommandExecutionMode
  }) => Effect.Effect<
    string,
    Error,
    | Crypto.Crypto
    | FileSystem.FileSystem
    | HttpClient.HttpClient
    | Path.Path
    | WorkspacePaths.WorkspacePaths
  >,
)
{
  const logLevel = yield* GlobalFlag.LogLevel
  const probeConfig = yield* resolveProjectCliProbeConfig(flags, logLevel)
  const executionMode = yield* tryResolveLiveProjectExecutionMode(probeConfig).pipe(
    Effect.provide(FetchHttpClient.layer),
  )

  if (executionMode._tag === 'Live')
  {
    return yield* Effect.gen(function* ()
    {
      const snapshot = yield* fetchLiveOrchestrationSnapshot(
        executionMode.origin,
        executionMode.storageOwnerToken,
      )
      const output = yield* run({
        snapshot,
        dispatch: (command) =>
          dispatchLiveOrchestrationCommand(
            executionMode.origin,
            executionMode.storageOwnerToken,
            command,
          ),
        mode: 'live',
      })
      yield* Console.log(output)
    }).pipe(Effect.provide(Layer.mergeAll(FetchHttpClient.layer, WorkspacePaths.layer)))
  }

  const { config, storageLease } = yield* resolveCliAuthConfig(flags, logLevel)
  if (executionMode.staleRuntimeState !== undefined)
  {
    yield* clearPersistedServerRuntimeStateIfStale({
      path: config.serverRuntimeStatePath,
      expectedState: executionMode.staleRuntimeState,
    })
  }
  const minimumLogLevel = config.logLevel
  const offlineRuntimeLayer = ProjectCliRuntimeLive.pipe(
    Layer.provide(ServerConfig.layer(config)),
    Layer.provide(ServerStorageLease.layer(storageLease)),
    Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
  )

  return yield* Effect.gen(function* ()
  {
    const snapshot = yield* getOfflineSnapshot()
    const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService
    const output = yield* run({
      snapshot,
      dispatch: (command) => orchestrationEngine.dispatch(command),
      mode: 'offline',
    })
    yield* Console.log(output)
  }).pipe(Effect.provide(offlineRuntimeLayer))
})

const runProjectMutation = (
  ...args: Parameters<typeof runProjectMutationUnscoped>
): ReturnType<typeof runProjectMutationUnscoped> =>
  Effect.scoped(runProjectMutationUnscoped(...args)) as ReturnType<
    typeof runProjectMutationUnscoped
  >

const projectAddCommand = Command.make('add', {
  ...projectLocationFlags,
  workspaceRoot: Argument.string('path').pipe(
    Argument.withDescription('Workspace root to add as a project.'),
  ),
  title: Flag.string('title').pipe(Flag.withDescription('Optional project title.'), Flag.optional),
}).pipe(
  Command.withDescription('Add a project.'),
  Command.withHandler((flags) =>
    runProjectMutation(
      flags,
      Effect.fn('projectAddMutation')(function* ({
        snapshot,
        dispatch,
      }: {
        readonly snapshot: OrchestrationShellSnapshot
        readonly dispatch: (
          command: ProjectCliDispatchCommand,
        ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>
      })
      {
        const workspaceRoot = yield* normalizeWorkspaceRootForProjectCommand(flags.workspaceRoot)
        const existingProject = snapshot.projects.find(
          (project) => project.workspaceRoot === workspaceRoot,
        )
        if (existingProject)
        {
          return yield* new ProjectAlreadyExistsError({
            operation: 'addProject',
            projectId: existingProject.id,
            workspaceRoot,
          })
        }

        const title = yield* resolveProjectTitle(workspaceRoot, Option.getOrUndefined(flags.title))
        const projectId = ProjectId.make(yield* projectCommandUuid)
        yield* dispatch({
          type: 'project.create',
          commandId: CommandId.make(yield* projectCommandUuid),
          projectId,
          title,
          workspaceRoot,
          defaultModelSelection: ServerRuntimeStartup.getAutoBootstrapDefaultModelSelection(),
          createdAt: DateTime.formatIso(yield* DateTime.now),
        })
        return `Added project ${projectId} (${title}) at ${workspaceRoot}.`
      }),
    ),
  ),
)

const projectRemoveCommand = Command.make('remove', {
  ...projectLocationFlags,
  project: Argument.string('project').pipe(
    Argument.withDescription('Project id or workspace root to remove.'),
  ),
  force: Flag.boolean('force').pipe(
    Flag.withDescription('Delete the project and all of its threads.'),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription('Remove a project.'),
  Command.withHandler((flags) =>
    runProjectMutation(
      flags,
      Effect.fn('projectRemoveMutation')(function* ({
        snapshot,
        dispatch,
      }: {
        readonly snapshot: OrchestrationShellSnapshot
        readonly dispatch: (
          command: ProjectCliDispatchCommand,
        ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>
      })
      {
        const project = yield* findActiveProjectTarget({
          snapshot,
          identifier: flags.project,
        })
        yield* dispatch({
          type: 'project.delete',
          commandId: CommandId.make(yield* projectCommandUuid),
          projectId: project.id,
          force: flags.force,
        })
        return `Removed project ${project.id} (${project.title}).`
      }),
    ),
  ),
)

const projectRenameCommand = Command.make('rename', {
  ...projectLocationFlags,
  project: Argument.string('project').pipe(
    Argument.withDescription('Project id or workspace root to rename.'),
  ),
  title: Argument.string('title').pipe(Argument.withDescription('New project title.')),
}).pipe(
  Command.withDescription('Rename a project.'),
  Command.withHandler((flags) =>
    runProjectMutation(
      flags,
      Effect.fn('projectRenameMutation')(function* ({
        snapshot,
        dispatch,
      }: {
        readonly snapshot: OrchestrationShellSnapshot
        readonly dispatch: (
          command: ProjectCliDispatchCommand,
        ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>
      })
      {
        const project = yield* findActiveProjectTarget({
          snapshot,
          identifier: flags.project,
        })
        const nextTitle = yield* resolveProjectTitle(project.workspaceRoot, flags.title)
        if (nextTitle === project.title)
        {
          return `Project ${project.id} is already named ${nextTitle}.`
        }

        yield* dispatch({
          type: 'project.meta.update',
          commandId: CommandId.make(yield* projectCommandUuid),
          projectId: project.id,
          title: nextTitle,
        })
        return `Renamed project ${project.id} to ${nextTitle}.`
      }),
    ),
  ),
)

export const projectCommand = Command.make('project').pipe(
  Command.withDescription('Manage projects.'),
  Command.withSubcommands([projectAddCommand, projectRemoveCommand, projectRenameCommand]),
)
