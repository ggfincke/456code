/**
 * ProjectFileLoader - Effect service that loads the checked-in `456code.json`
 * project file from a workspace root.
 *
 * Loading is best-effort: a missing file resolves to `Option.none`, and
 * unreadable or invalid files are logged and treated as absent so callers
 * can fall back to their defaults.
 *
 * @module ProjectFileLoader
 */
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'

import { PROJECT_FILE_NAME, type ProjectFile } from '@t3tools/contracts'
import { ProjectFileFromJson } from '@t3tools/shared/projectFile'

const decodeProjectFileJson = Schema.decodeEffect(ProjectFileFromJson)

export class ProjectFileLoadError extends Schema.TaggedErrorClass<ProjectFileLoadError>()(
  'ProjectFileLoadError',
  {
    operation: Schema.Literals(['read', 'decode']),
    workspaceRoot: Schema.String,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
)
{
  override get message(): string
  {
    return `Failed to ${this.operation} ${PROJECT_FILE_NAME} at ${this.filePath}.`
  }
}

/** Service tag for 456code.json project file loading. */
export class ProjectFileLoader extends Context.Service<
  ProjectFileLoader,
  {
    /**
     * Load and decode `456code.json` at the workspace root.
     *
     * Never fails: missing, unreadable, or invalid files resolve to
     * `Option.none` (invalid files are logged as warnings).
     */
    readonly load: (workspaceRoot: string) => Effect.Effect<Option.Option<ProjectFile>>
  }
>()('456code/project/ProjectFileLoader')
{}

const logProjectFileLoadError = (error: ProjectFileLoadError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      workspaceRoot: error.workspaceRoot,
      filePath: error.filePath,
      errorTag: error._tag,
    }),
  )

export const make = Effect.gen(function* ()
{
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const load: ProjectFileLoader['Service']['load'] = Effect.fn('ProjectFileLoader.load')(
    function* (workspaceRoot)
    {
      const filePath = path.join(workspaceRoot, PROJECT_FILE_NAME)
      const raw = yield* fileSystem.readFileString(filePath).pipe(
        Effect.map(Option.some),
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === 'NotFound'
              ? Effect.succeed(Option.none<string>())
              : logProjectFileLoadError(
                  new ProjectFileLoadError({
                    operation: 'read',
                    workspaceRoot,
                    filePath,
                    cause: error,
                  }),
                ).pipe(Effect.as(Option.none<string>())),
        }),
      )
      if (Option.isNone(raw))
      {
        return Option.none<ProjectFile>()
      }
      return yield* decodeProjectFileJson(raw.value).pipe(
        Effect.map(Option.some),
        Effect.catchTags({
          SchemaError: (error) =>
            logProjectFileLoadError(
              new ProjectFileLoadError({
                operation: 'decode',
                workspaceRoot,
                filePath,
                cause: error,
              }),
            ).pipe(Effect.as(Option.none<ProjectFile>())),
        }),
      )
    },
  )

  return ProjectFileLoader.of({ load })
})

export const layer = Layer.effect(ProjectFileLoader, make)
