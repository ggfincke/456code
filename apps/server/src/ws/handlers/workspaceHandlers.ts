// apps/server/src/ws/handlers/workspaceHandlers.ts
// builds workspace websocket rpc handlers from narrow concrete dependencies

import {
  AssetWorkspaceContextNotFoundError,
  AssetWorkspaceContextResolutionError,
  type FilesystemBrowseFailure,
  FilesystemBrowseError,
  type ProjectEntriesFailure,
  type ProjectFileFailure,
  type ProjectFileOperation,
  ProjectListEntriesError,
  ProjectReadFileError,
  ProjectReadMdxDocumentError,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
  WS_METHODS,
  type WsRpcGroup,
} from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import type * as RpcGroup from 'effect/unstable/rpc/RpcGroup'

import type * as AssetAccess from '../../assets/AssetAccess.ts'
import type * as WorkspaceMdxDocument from '../../mdx/WorkspaceMdxDocument.ts'
import type * as ProjectionSnapshotQuery from '../../orchestration/Services/ProjectionSnapshotQuery.ts'
import type * as ExternalLauncher from '../../process/externalLauncher.ts'
import type * as WorkspaceEntries from '../../workspace/WorkspaceEntries.ts'
import type * as WorkspaceFileSystem from '../../workspace/WorkspaceFileSystem.ts'
import type * as WorkspacePaths from '../../workspace/WorkspacePaths.ts'
import type { makeRpcAuthorization } from '../rpcAuthorization.ts'

type WsRpcHandlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof WsRpcGroup>>
type WorkspaceRpcMethod =
  | typeof WS_METHODS.projectsSearchEntries
  | typeof WS_METHODS.projectsListEntries
  | typeof WS_METHODS.projectsReadFile
  | typeof WS_METHODS.projectsReadMdxDocument
  | typeof WS_METHODS.projectsWriteFile
  | typeof WS_METHODS.shellOpenInEditor
  | typeof WS_METHODS.filesystemBrowse
  | typeof WS_METHODS.assetsCreateUrl
type WorkspaceRpcHandlers = Pick<WsRpcHandlers, WorkspaceRpcMethod>

interface WorkspaceRpcHandlerDependencies
{
  readonly workspaceEntries: WorkspaceEntries.WorkspaceEntries['Service']
  readonly workspaceFileSystem: WorkspaceFileSystem.WorkspaceFileSystem['Service']
  readonly externalLauncher: ExternalLauncher.ExternalLauncher['Service']
  readonly projectionSnapshotQuery: ProjectionSnapshotQuery.ProjectionSnapshotQuery['Service']
  readonly readWorkspaceMdxDocument: typeof WorkspaceMdxDocument.readWorkspaceMdxDocument
  readonly issueAssetUrl: typeof AssetAccess.issueAssetUrl
  readonly observeRpcEffect: ReturnType<typeof makeRpcAuthorization>['observeRpcEffect']
}

function unexpectedCompatibilityError(error: never): never
{
  throw new Error(`Unhandled compatibility error: ${String(error)}`)
}

function projectEntriesFailureContext(error: WorkspaceEntries.WorkspaceEntriesError): {
  readonly failure: ProjectEntriesFailure
  readonly normalizedCwd?: string
  readonly timeout?: string
  readonly detail?: string
}
{
  switch (error._tag)
  {
    case 'WorkspaceRootNotExistsError':
      return {
        failure: 'workspace_root_not_found',
        normalizedCwd: error.normalizedWorkspaceRoot,
      }
    case 'WorkspaceRootCreateFailedError':
      return {
        failure: 'workspace_root_create_failed',
        normalizedCwd: error.normalizedWorkspaceRoot,
      }
    case 'WorkspaceRootStatFailedError':
      return {
        failure: 'workspace_root_stat_failed',
        normalizedCwd: error.normalizedWorkspaceRoot,
        detail: error.phase,
      }
    case 'WorkspaceRootNotDirectoryError':
      return {
        failure: 'workspace_root_not_directory',
        normalizedCwd: error.normalizedWorkspaceRoot,
      }
    case 'WorkspaceSearchIndexCreateFailed':
      return {
        failure: 'search_index_create_failed',
        normalizedCwd: error.cwd,
        detail: error.reason,
      }
    case 'WorkspaceSearchIndexScanTimedOut':
      return {
        failure: 'search_index_scan_timed_out',
        normalizedCwd: error.cwd,
        timeout: error.timeout,
      }
    case 'WorkspaceSearchIndexSearchFailed':
      return {
        failure: 'search_index_search_failed',
        normalizedCwd: error.cwd,
        detail: error.reason,
      }
    default:
      return unexpectedCompatibilityError(error)
  }
}

function filesystemBrowseFailureContext(error: WorkspaceEntries.WorkspaceEntriesBrowseError): {
  readonly failure: FilesystemBrowseFailure
  readonly parentPath?: string
  readonly platform?: string
}
{
  switch (error._tag)
  {
    case 'WorkspaceEntriesWindowsPathUnsupportedError':
      return { failure: 'windows_path_unsupported', platform: error.platform }
    case 'WorkspaceEntriesCurrentProjectRequiredError':
      return { failure: 'current_project_required' }
    case 'WorkspaceEntriesReadDirectoryError':
      return { failure: 'read_directory_failed', parentPath: error.parentPath }
    default:
      return unexpectedCompatibilityError(error)
  }
}

function projectFileFailureContext(
  error:
    WorkspaceFileSystem.WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError,
): {
  readonly failure: ProjectFileFailure
  readonly resolvedPath?: string
  readonly resolvedWorkspaceRoot?: string
  readonly operation?: ProjectFileOperation
  readonly operationPath?: string
}
{
  switch (error._tag)
  {
    case 'WorkspacePathOutsideRootError':
      return { failure: 'workspace_path_outside_root' }
    case 'WorkspaceFileSystemOperationError':
      return {
        failure: 'operation_failed',
        resolvedPath: error.resolvedPath,
        operation: error.operation,
        operationPath: error.operationPath,
      }
    case 'WorkspaceFilePathEscapeError':
      return {
        failure: 'resolved_path_outside_root',
        resolvedPath: error.resolvedPath,
        resolvedWorkspaceRoot: error.resolvedWorkspaceRoot,
      }
    case 'WorkspacePathNotFileError':
      return { failure: 'path_not_file', resolvedPath: error.resolvedPath }
    case 'WorkspaceBinaryFileError':
      return { failure: 'binary_file', resolvedPath: error.resolvedPath }
    default:
      return unexpectedCompatibilityError(error)
  }
}

export function makeWorkspaceRpcHandlers({
  workspaceEntries,
  workspaceFileSystem,
  externalLauncher,
  projectionSnapshotQuery,
  readWorkspaceMdxDocument,
  issueAssetUrl,
  observeRpcEffect,
}: WorkspaceRpcHandlerDependencies)
{
  return {
    [WS_METHODS.projectsSearchEntries]: (input) =>
      observeRpcEffect(
        WS_METHODS.projectsSearchEntries,
        workspaceEntries.search(input).pipe(
          Effect.mapError(
            (cause) =>
              new ProjectSearchEntriesError({
                cwd: input.cwd,
                queryLength: input.query.length,
                limit: input.limit,
                ...projectEntriesFailureContext(cause),
                cause,
              }),
          ),
        ),
        { 'rpc.aggregate': 'workspace' },
      ),
    [WS_METHODS.projectsListEntries]: (input) =>
      observeRpcEffect(
        WS_METHODS.projectsListEntries,
        workspaceEntries.list(input).pipe(
          Effect.mapError(
            (cause) =>
              new ProjectListEntriesError({
                ...input,
                ...projectEntriesFailureContext(cause),
                cause,
              }),
          ),
        ),
        { 'rpc.aggregate': 'workspace' },
      ),
    [WS_METHODS.projectsReadFile]: (input) =>
      observeRpcEffect(
        WS_METHODS.projectsReadFile,
        workspaceFileSystem.readFile(input).pipe(
          Effect.mapError(
            (cause) =>
              new ProjectReadFileError({
                ...input,
                ...projectFileFailureContext(cause),
                cause,
              }),
          ),
        ),
        { 'rpc.aggregate': 'workspace' },
      ),
    [WS_METHODS.projectsReadMdxDocument]: (input) =>
      observeRpcEffect(
        WS_METHODS.projectsReadMdxDocument,
        Effect.gen(function* ()
        {
          const contextNotFound = () =>
            new ProjectReadMdxDocumentError({
              threadId: input.threadId,
              relativePath: input.relativePath,
              failure: 'workspace_context_not_found',
            })
          const thread = yield* projectionSnapshotQuery
            .getThreadShellById(input.threadId)
            .pipe(Effect.mapError(() => contextNotFound()))
          if (Option.isNone(thread))
          {
            return yield* contextNotFound()
          }
          const project = yield* projectionSnapshotQuery
            .getProjectShellById(thread.value.projectId)
            .pipe(Effect.mapError(() => contextNotFound()))
          if (Option.isNone(project))
          {
            return yield* contextNotFound()
          }

          const workspaceRoot = thread.value.worktreePath ?? project.value.workspaceRoot
          return yield* readWorkspaceMdxDocument({
            ...input,
            workspaceRoot,
          }).pipe(
            Effect.mapError((cause) =>
              cause._tag === 'ProjectReadMdxDocumentError'
                ? cause
                : new ProjectReadFileError({
                    cwd: workspaceRoot,
                    relativePath: input.relativePath,
                    ...projectFileFailureContext(cause),
                    cause,
                  }),
            ),
          )
        }),
        { 'rpc.aggregate': 'workspace' },
      ),
    [WS_METHODS.projectsWriteFile]: (input) =>
      observeRpcEffect(
        WS_METHODS.projectsWriteFile,
        workspaceFileSystem.writeFile(input).pipe(
          Effect.mapError(
            (cause) =>
              new ProjectWriteFileError({
                cwd: input.cwd,
                relativePath: input.relativePath,
                ...projectFileFailureContext(cause),
                cause,
              }),
          ),
        ),
        { 'rpc.aggregate': 'workspace' },
      ),
    [WS_METHODS.shellOpenInEditor]: (input) =>
      observeRpcEffect(WS_METHODS.shellOpenInEditor, externalLauncher.launchEditor(input), {
        'rpc.aggregate': 'workspace',
      }),
    [WS_METHODS.filesystemBrowse]: (input) =>
      observeRpcEffect(
        WS_METHODS.filesystemBrowse,
        workspaceEntries.browse(input).pipe(
          Effect.mapError(
            (cause) =>
              new FilesystemBrowseError({
                ...input,
                ...filesystemBrowseFailureContext(cause),
                cause,
              }),
          ),
        ),
        { 'rpc.aggregate': 'workspace' },
      ),
    [WS_METHODS.assetsCreateUrl]: (input) =>
      observeRpcEffect(
        WS_METHODS.assetsCreateUrl,
        Effect.gen(function* ()
        {
          if (input.resource._tag !== 'workspace-file')
          {
            return yield* issueAssetUrl({ resource: input.resource })
          }
          const thread = yield* projectionSnapshotQuery
            .getThreadShellById(input.resource.threadId)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new AssetWorkspaceContextResolutionError({
                    resource: input.resource,
                    cause,
                  }),
              ),
            )
          if (Option.isNone(thread))
          {
            return yield* new AssetWorkspaceContextNotFoundError({
              resource: input.resource,
            })
          }
          const project = yield* projectionSnapshotQuery
            .getProjectShellById(thread.value.projectId)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new AssetWorkspaceContextResolutionError({
                    resource: input.resource,
                    cause,
                  }),
              ),
            )
          if (Option.isNone(project))
          {
            return yield* new AssetWorkspaceContextNotFoundError({
              resource: input.resource,
            })
          }
          return yield* issueAssetUrl({
            resource: input.resource,
            workspaceRoot: thread.value.worktreePath ?? project.value.workspaceRoot,
          })
        }),
        { 'rpc.aggregate': 'workspace' },
      ),
  } satisfies WorkspaceRpcHandlers
}
