// apps/server/src/checkpointing/CheckpointIdentity.ts
// resolves and verifies capture-time Git identity for checkpoint reads and restores

import { CheckpointRef, NonNegativeInt } from '@t3tools/contracts'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'

import { GitVcsDriver } from '../vcs/GitVcsDriver.ts'

export const CheckpointIdentityOperation = Schema.Literals(['capture', 'read', 'revert'])
export type CheckpointIdentityOperation = typeof CheckpointIdentityOperation.Type

export interface RecordedCheckpointIdentity
{
  readonly checkpointRef: CheckpointRef
  readonly checkpointTurnCount: number
  readonly checkpointCaptureRoot: string | null
  readonly checkpointRepositoryCommonDir: string | null
  readonly checkpointCommitOid: string | null
}

export interface ResolvedCheckpointIdentity
{
  readonly cwd: string
  readonly checkpointRef: CheckpointRef
  readonly checkpointTurnCount: number
  readonly checkpointCaptureRoot: string
  readonly checkpointRepositoryCommonDir: string
  readonly checkpointCommitOid: string
  readonly legacyMode: 'none' | 'null-root' | 'pre-oid'
}

export class CheckpointCaptureIdentityMissingError extends Schema.TaggedErrorClass<CheckpointCaptureIdentityMissingError>()(
  'CheckpointCaptureIdentityMissingError',
  {
    operation: CheckpointIdentityOperation,
    checkpointRef: CheckpointRef,
    checkpointTurnCount: NonNegativeInt,
    detail: Schema.String,
  },
)
{
  override get message(): string
  {
    return (
      `Checkpoint '${this.checkpointRef}' at turn ${this.checkpointTurnCount} ` +
      `is missing capture identity: ${this.detail}`
    )
  }
}

export class CheckpointRepositoryMismatchError extends Schema.TaggedErrorClass<CheckpointRepositoryMismatchError>()(
  'CheckpointRepositoryMismatchError',
  {
    operation: CheckpointIdentityOperation,
    checkpointRef: CheckpointRef,
    checkpointTurnCount: NonNegativeInt,
    expectedRepositoryCommonDir: Schema.String,
    actualRepositoryCommonDir: Schema.String,
    attemptedRoot: Schema.String,
  },
)
{
  override get message(): string
  {
    return (
      `Checkpoint '${this.checkpointRef}' belongs to repository ` +
      `'${this.expectedRepositoryCommonDir}', but '${this.attemptedRoot}' resolves to ` +
      `'${this.actualRepositoryCommonDir}'.`
    )
  }
}

export class CheckpointRefOidMismatchError extends Schema.TaggedErrorClass<CheckpointRefOidMismatchError>()(
  'CheckpointRefOidMismatchError',
  {
    operation: CheckpointIdentityOperation,
    checkpointRef: CheckpointRef,
    checkpointTurnCount: NonNegativeInt,
    expectedCommitOid: Schema.NullOr(Schema.String),
    actualCommitOid: Schema.NullOr(Schema.String),
    attemptedRoot: Schema.String,
  },
)
{
  override get message(): string
  {
    if (this.actualCommitOid === null)
    {
      return `Checkpoint ref '${this.checkpointRef}' is unavailable in '${this.attemptedRoot}'.`
    }
    if (this.expectedCommitOid === null)
    {
      return (
        `Legacy checkpoint ref '${this.checkpointRef}' resolved to '${this.actualCommitOid}', ` +
        'but no captured OID is available for destructive verification.'
      )
    }
    return (
      `Checkpoint ref '${this.checkpointRef}' resolved to '${this.actualCommitOid}' instead of ` +
      `captured OID '${this.expectedCommitOid}' in '${this.attemptedRoot}'.`
    )
  }
}

export class CheckpointCaptureRootUnavailableError extends Schema.TaggedErrorClass<CheckpointCaptureRootUnavailableError>()(
  'CheckpointCaptureRootUnavailableError',
  {
    operation: CheckpointIdentityOperation,
    checkpointRef: CheckpointRef,
    checkpointTurnCount: NonNegativeInt,
    attemptedRoot: Schema.NullOr(Schema.String),
    detail: Schema.String,
  },
)
{
  override get message(): string
  {
    const root = this.attemptedRoot === null ? 'the current workspace' : `'${this.attemptedRoot}'`
    return `Checkpoint root ${root} is unavailable: ${this.detail}`
  }
}

export class CheckpointDestructiveLegacyRefusalError extends Schema.TaggedErrorClass<CheckpointDestructiveLegacyRefusalError>()(
  'CheckpointDestructiveLegacyRefusalError',
  {
    operation: Schema.Literal('revert'),
    checkpointRef: CheckpointRef,
    checkpointTurnCount: NonNegativeInt,
    legacyMode: Schema.Literals(['null-root', 'pre-oid', 'incomplete']),
  },
)
{
  override get message(): string
  {
    return (
      `Checkpoint '${this.checkpointRef}' at turn ${this.checkpointTurnCount} predates exact ` +
      `capture identity (${this.legacyMode}); destructive restore requires manual recovery.`
    )
  }
}

export type CheckpointIdentityError =
  | CheckpointCaptureIdentityMissingError
  | CheckpointRepositoryMismatchError
  | CheckpointRefOidMismatchError
  | CheckpointCaptureRootUnavailableError
  | CheckpointDestructiveLegacyRefusalError

export interface ResolvedRepositoryRevision
{
  readonly cwd: string
  readonly repositoryRoot: string
  readonly repositoryCommonDir: string
  readonly commitOid: string
}

export interface ResolvedRepositoryObjectRevision
{
  readonly repositoryCommonDir: string
  readonly commitOid: string
}

export class RepositoryRevisionUnavailableError extends Schema.TaggedErrorClass<RepositoryRevisionUnavailableError>()(
  'RepositoryRevisionUnavailableError',
  {
    cwd: Schema.String,
    revision: Schema.String,
    detail: Schema.String,
  },
)
{
  override get message(): string
  {
    return `Git revision '${this.revision}' is unavailable from '${this.cwd}': ${this.detail}`
  }
}

export class RepositoryRevisionMismatchError extends Schema.TaggedErrorClass<RepositoryRevisionMismatchError>()(
  'RepositoryRevisionMismatchError',
  {
    cwd: Schema.String,
    expectedRepositoryCommonDir: Schema.String,
    actualRepositoryCommonDir: Schema.String,
  },
)
{
  override get message(): string
  {
    return (
      `Repository '${this.cwd}' resolves to '${this.actualRepositoryCommonDir}', not ` +
      `'${this.expectedRepositoryCommonDir}'.`
    )
  }
}

export class RepositoryRevisionOidMismatchError extends Schema.TaggedErrorClass<RepositoryRevisionOidMismatchError>()(
  'RepositoryRevisionOidMismatchError',
  {
    cwd: Schema.String,
    revision: Schema.String,
    expectedCommitOid: Schema.String,
    actualCommitOid: Schema.String,
  },
)
{
  override get message(): string
  {
    return (
      `Git revision '${this.revision}' resolved to '${this.actualCommitOid}', not ` +
      `'${this.expectedCommitOid}'.`
    )
  }
}

export type RepositoryRevisionIdentityError =
  | RepositoryRevisionUnavailableError
  | RepositoryRevisionMismatchError
  | RepositoryRevisionOidMismatchError

interface ResolvedRepository
{
  readonly root: string
  readonly commonDir: string
}

type IdentityMode = 'authoritative' | 'null-root' | 'pre-oid' | 'incomplete'

function identityMode(record: RecordedCheckpointIdentity): IdentityMode
{
  const root = record.checkpointCaptureRoot
  const commonDir = record.checkpointRepositoryCommonDir
  const commitOid = record.checkpointCommitOid
  if (root !== null && commonDir !== null && commitOid !== null)
  {
    return 'authoritative'
  }
  if (root === null && commonDir === null && commitOid === null)
  {
    return 'null-root'
  }
  if (root !== null && commonDir === null && commitOid === null)
  {
    return 'pre-oid'
  }
  return 'incomplete'
}

export class CheckpointIdentityResolver extends Context.Service<
  CheckpointIdentityResolver,
  {
    readonly resolveCapture: (input: {
      readonly cwd: string
      readonly checkpointRef: CheckpointRef
      readonly checkpointTurnCount: number
      readonly expectedCommitOid?: string
    }) => Effect.Effect<ResolvedCheckpointIdentity, CheckpointIdentityError>
    readonly resolveRead: (input: {
      readonly record: RecordedCheckpointIdentity
      readonly currentRoot: string | null
    }) => Effect.Effect<ResolvedCheckpointIdentity, CheckpointIdentityError>
    readonly resolveReadRange: (input: {
      readonly from: RecordedCheckpointIdentity
      readonly to: RecordedCheckpointIdentity
      readonly currentRoot: string | null
    }) => Effect.Effect<
      {
        readonly cwd: string
        readonly repositoryCommonDir: string
        readonly fromCommitOid: string
        readonly toCommitOid: string
      },
      CheckpointIdentityError
    >
    readonly resolveDestructive: (input: {
      readonly record: RecordedCheckpointIdentity
      readonly restoreRoot: string | null
    }) => Effect.Effect<ResolvedCheckpointIdentity, CheckpointIdentityError>
    readonly resolveRepositoryRevision: (input: {
      readonly cwd: string
      readonly revision: string
      readonly expectedRepositoryCommonDir?: string
      readonly expectedCommitOid?: string
    }) => Effect.Effect<ResolvedRepositoryRevision, RepositoryRevisionIdentityError>
    // verifies an immutable commit directly against the captured shared object
    // database when every worktree path has been removed
    readonly resolveRepositoryObjectRevision: (input: {
      readonly repositoryCommonDir: string
      readonly revision: string
      readonly expectedCommitOid: string
    }) => Effect.Effect<ResolvedRepositoryObjectRevision, RepositoryRevisionIdentityError>
  }
>()('456code/checkpointing/CheckpointIdentity/CheckpointIdentityResolver')
{}

export const make = Effect.gen(function* ()
{
  const git = yield* GitVcsDriver
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const rootUnavailable = (
    operation: CheckpointIdentityOperation,
    record: Pick<RecordedCheckpointIdentity, 'checkpointRef' | 'checkpointTurnCount'>,
    attemptedRoot: string | null,
    detail: string,
  ) =>
    new CheckpointCaptureRootUnavailableError({
      operation,
      checkpointRef: record.checkpointRef,
      checkpointTurnCount: record.checkpointTurnCount,
      attemptedRoot,
      detail,
    })

  const resolveRepository = Effect.fn('CheckpointIdentity.resolveRepository')(function* (input: {
    readonly operation: CheckpointIdentityOperation
    readonly record: Pick<RecordedCheckpointIdentity, 'checkpointRef' | 'checkpointTurnCount'>
    readonly cwd: string
  })
  {
    const canonicalCwd = yield* fileSystem
      .realPath(input.cwd)
      .pipe(
        Effect.mapError(() =>
          rootUnavailable(input.operation, input.record, input.cwd, 'the directory does not exist'),
        ),
      )
    const rootResult = yield* git
      .execute({
        operation: 'CheckpointIdentity.resolveRepository.root',
        cwd: canonicalCwd,
        args: ['rev-parse', '--show-toplevel'],
        allowNonZeroExit: true,
        maxOutputBytes: 4_096,
      })
      .pipe(
        Effect.mapError((error) =>
          rootUnavailable(input.operation, input.record, input.cwd, error.message),
        ),
      )
    const rootPath = rootResult.stdout.trim()
    if (rootResult.exitCode !== 0 || rootPath.length === 0)
    {
      return yield* rootUnavailable(
        input.operation,
        input.record,
        input.cwd,
        rootResult.stderr.trim() || 'the directory is not a Git worktree',
      )
    }
    const canonicalRoot = yield* fileSystem
      .realPath(rootPath)
      .pipe(
        Effect.mapError(() =>
          rootUnavailable(input.operation, input.record, input.cwd, 'the Git root is unavailable'),
        ),
      )

    const commonDirResult = yield* git
      .execute({
        operation: 'CheckpointIdentity.resolveRepository.commonDir',
        cwd: canonicalCwd,
        args: ['rev-parse', '--git-common-dir'],
        allowNonZeroExit: true,
        maxOutputBytes: 4_096,
      })
      .pipe(
        Effect.mapError((error) =>
          rootUnavailable(input.operation, input.record, input.cwd, error.message),
        ),
      )
    const rawCommonDir = commonDirResult.stdout.trim()
    if (commonDirResult.exitCode !== 0 || rawCommonDir.length === 0)
    {
      return yield* rootUnavailable(
        input.operation,
        input.record,
        input.cwd,
        commonDirResult.stderr.trim() || 'the Git common directory is unavailable',
      )
    }
    const absoluteCommonDir = path.isAbsolute(rawCommonDir)
      ? rawCommonDir
      : path.resolve(canonicalCwd, rawCommonDir)
    const canonicalCommonDir = yield* fileSystem
      .realPath(absoluteCommonDir)
      .pipe(
        Effect.mapError(() =>
          rootUnavailable(
            input.operation,
            input.record,
            input.cwd,
            'the Git common directory does not exist',
          ),
        ),
      )

    return {
      root: path.normalize(canonicalRoot),
      commonDir: path.normalize(canonicalCommonDir),
    } satisfies ResolvedRepository
  })

  const resolveRefOid = Effect.fn('CheckpointIdentity.resolveRefOid')(function* (input: {
    readonly operation: CheckpointIdentityOperation
    readonly record: Pick<RecordedCheckpointIdentity, 'checkpointRef' | 'checkpointTurnCount'>
    readonly cwd: string
  })
  {
    const result = yield* git
      .execute({
        operation: 'CheckpointIdentity.resolveRefOid',
        cwd: input.cwd,
        args: ['rev-parse', '--verify', '--quiet', `${input.record.checkpointRef}^{commit}`],
        allowNonZeroExit: true,
        maxOutputBytes: 4_096,
      })
      .pipe(
        Effect.mapError((error) =>
          rootUnavailable(input.operation, input.record, input.cwd, error.message),
        ),
      )
    const commitOid = result.stdout.trim()
    return result.exitCode === 0 && commitOid.length > 0 ? commitOid : null
  })

  const repositoryMismatch = (
    operation: CheckpointIdentityOperation,
    record: RecordedCheckpointIdentity,
    expectedRepositoryCommonDir: string,
    repository: ResolvedRepository,
  ) =>
    new CheckpointRepositoryMismatchError({
      operation,
      checkpointRef: record.checkpointRef,
      checkpointTurnCount: record.checkpointTurnCount,
      expectedRepositoryCommonDir,
      actualRepositoryCommonDir: repository.commonDir,
      attemptedRoot: repository.root,
    })

  const oidMismatch = (
    operation: CheckpointIdentityOperation,
    record: RecordedCheckpointIdentity,
    expectedCommitOid: string | null,
    actualCommitOid: string | null,
    attemptedRoot: string,
  ) =>
    new CheckpointRefOidMismatchError({
      operation,
      checkpointRef: record.checkpointRef,
      checkpointTurnCount: record.checkpointTurnCount,
      expectedCommitOid,
      actualCommitOid,
      attemptedRoot,
    })

  const resolveCapture: CheckpointIdentityResolver['Service']['resolveCapture'] = Effect.fn(
    'CheckpointIdentity.resolveCapture',
  )(function* (input)
  {
    const record: RecordedCheckpointIdentity = {
      checkpointRef: input.checkpointRef,
      checkpointTurnCount: input.checkpointTurnCount,
      checkpointCaptureRoot: null,
      checkpointRepositoryCommonDir: null,
      checkpointCommitOid: null,
    }
    const repository = yield* resolveRepository({ operation: 'capture', record, cwd: input.cwd })
    const commitOid = yield* resolveRefOid({
      operation: 'capture',
      record,
      cwd: repository.root,
    })
    if (commitOid === null || (input.expectedCommitOid && commitOid !== input.expectedCommitOid))
    {
      return yield* oidMismatch(
        'capture',
        record,
        input.expectedCommitOid ?? null,
        commitOid,
        repository.root,
      )
    }
    return {
      cwd: repository.root,
      checkpointRef: input.checkpointRef,
      checkpointTurnCount: input.checkpointTurnCount,
      checkpointCaptureRoot: repository.root,
      checkpointRepositoryCommonDir: repository.commonDir,
      checkpointCommitOid: commitOid,
      legacyMode: 'none',
    }
  })

  const resolveNullRootRead = Effect.fn('CheckpointIdentity.resolveNullRootRead')(
    function* (input: {
      readonly record: RecordedCheckpointIdentity
      readonly currentRoot: string | null
    })
    {
      if (input.currentRoot === null)
      {
        return yield* rootUnavailable(
          'read',
          input.record,
          null,
          'no current workspace root is available for the legacy fallback',
        )
      }
      const repository = yield* resolveRepository({
        operation: 'read',
        record: input.record,
        cwd: input.currentRoot,
      })
      const commitOid = yield* resolveRefOid({
        operation: 'read',
        record: input.record,
        cwd: repository.root,
      })
      if (commitOid === null)
      {
        return yield* oidMismatch('read', input.record, null, null, repository.root)
      }
      return {
        cwd: repository.root,
        checkpointRef: input.record.checkpointRef,
        checkpointTurnCount: input.record.checkpointTurnCount,
        checkpointCaptureRoot: repository.root,
        checkpointRepositoryCommonDir: repository.commonDir,
        checkpointCommitOid: commitOid,
        legacyMode: 'null-root',
      } satisfies ResolvedCheckpointIdentity
    },
  )

  const resolvePreOidRead = Effect.fn('CheckpointIdentity.resolvePreOidRead')(function* (input: {
    readonly record: RecordedCheckpointIdentity
    readonly currentRoot: string | null
  })
  {
    if (input.record.checkpointCaptureRoot === null || input.currentRoot === null)
    {
      return yield* rootUnavailable(
        'read',
        input.record,
        input.currentRoot,
        'both recorded and current roots are required for pre-OID verification',
      )
    }
    const recordedRepository = yield* resolveRepository({
      operation: 'read',
      record: input.record,
      cwd: input.record.checkpointCaptureRoot,
    })
    const currentRepository = yield* resolveRepository({
      operation: 'read',
      record: input.record,
      cwd: input.currentRoot,
    })
    if (recordedRepository.commonDir !== currentRepository.commonDir)
    {
      return yield* repositoryMismatch(
        'read',
        input.record,
        recordedRepository.commonDir,
        currentRepository,
      )
    }
    const commitOid = yield* resolveRefOid({
      operation: 'read',
      record: input.record,
      cwd: currentRepository.root,
    })
    if (commitOid === null)
    {
      return yield* oidMismatch('read', input.record, null, null, currentRepository.root)
    }
    return {
      cwd: currentRepository.root,
      checkpointRef: input.record.checkpointRef,
      checkpointTurnCount: input.record.checkpointTurnCount,
      checkpointCaptureRoot: recordedRepository.root,
      checkpointRepositoryCommonDir: currentRepository.commonDir,
      checkpointCommitOid: commitOid,
      legacyMode: 'pre-oid',
    } satisfies ResolvedCheckpointIdentity
  })

  const resolveAuthoritativeRead = Effect.fn('CheckpointIdentity.resolveAuthoritativeRead')(
    function* (input: {
      readonly record: RecordedCheckpointIdentity
      readonly currentRoot: string | null
    })
    {
      const captureRoot = input.record.checkpointCaptureRoot
      const expectedCommonDir = input.record.checkpointRepositoryCommonDir
      const expectedCommitOid = input.record.checkpointCommitOid
      if (captureRoot === null || expectedCommonDir === null || expectedCommitOid === null)
      {
        return yield* new CheckpointCaptureIdentityMissingError({
          operation: 'read',
          checkpointRef: input.record.checkpointRef,
          checkpointTurnCount: input.record.checkpointTurnCount,
          detail: 'authoritative capture identity is incomplete',
        })
      }

      const candidates = [captureRoot, input.currentRoot]
        .filter((candidate): candidate is string => candidate !== null)
        .filter((candidate, index, all) => all.indexOf(candidate) === index)
      let captureUnavailable: CheckpointCaptureRootUnavailableError | null = null
      let repositoryFailure: CheckpointRepositoryMismatchError | null = null
      let oidFailure: CheckpointRefOidMismatchError | null = null

      for (const candidate of candidates)
      {
        const repositoryResult = yield* resolveRepository({
          operation: 'read',
          record: input.record,
          cwd: candidate,
        }).pipe(
          Effect.map((repository) => ({ _tag: 'success' as const, repository })),
          Effect.catch((error) => Effect.succeed({ _tag: 'failure' as const, error })),
        )
        if (repositoryResult._tag === 'failure')
        {
          if (candidate === captureRoot)
          {
            captureUnavailable = repositoryResult.error
          }
          continue
        }
        const repository = repositoryResult.repository
        if (repository.commonDir !== expectedCommonDir)
        {
          repositoryFailure ??= repositoryMismatch(
            'read',
            input.record,
            expectedCommonDir,
            repository,
          )
          continue
        }
        const actualCommitOid = yield* resolveRefOid({
          operation: 'read',
          record: input.record,
          cwd: repository.root,
        })
        if (actualCommitOid !== expectedCommitOid)
        {
          oidFailure ??= oidMismatch(
            'read',
            input.record,
            expectedCommitOid,
            actualCommitOid,
            repository.root,
          )
          continue
        }
        return {
          cwd: repository.root,
          checkpointRef: input.record.checkpointRef,
          checkpointTurnCount: input.record.checkpointTurnCount,
          checkpointCaptureRoot: captureRoot,
          checkpointRepositoryCommonDir: expectedCommonDir,
          checkpointCommitOid: expectedCommitOid,
          legacyMode: 'none',
        } satisfies ResolvedCheckpointIdentity
      }

      if (oidFailure !== null)
      {
        return yield* oidFailure
      }
      if (repositoryFailure !== null)
      {
        return yield* repositoryFailure
      }
      if (captureUnavailable !== null)
      {
        return yield* captureUnavailable
      }
      return yield* rootUnavailable(
        'read',
        input.record,
        captureRoot,
        'neither the capture root nor the current workspace can be resolved',
      )
    },
  )

  const resolveRead: CheckpointIdentityResolver['Service']['resolveRead'] = Effect.fn(
    'CheckpointIdentity.resolveRead',
  )(function* (input)
  {
    switch (identityMode(input.record))
    {
      case 'authoritative':
        return yield* resolveAuthoritativeRead(input)
      case 'null-root':
        return yield* resolveNullRootRead(input)
      case 'pre-oid':
        return yield* resolvePreOidRead(input)
      case 'incomplete':
        return yield* new CheckpointCaptureIdentityMissingError({
          operation: 'read',
          checkpointRef: input.record.checkpointRef,
          checkpointTurnCount: input.record.checkpointTurnCount,
          detail: 'root, repository anchor, and commit OID are only partially recorded',
        })
    }
  })

  const resolveReadRange: CheckpointIdentityResolver['Service']['resolveReadRange'] = Effect.fn(
    'CheckpointIdentity.resolveReadRange',
  )(function* (input)
  {
    const from = yield* resolveRead({ record: input.from, currentRoot: input.currentRoot })
    const to = yield* resolveRead({ record: input.to, currentRoot: input.currentRoot })
    if (from.checkpointRepositoryCommonDir !== to.checkpointRepositoryCommonDir)
    {
      return yield* new CheckpointRepositoryMismatchError({
        operation: 'read',
        checkpointRef: input.to.checkpointRef,
        checkpointTurnCount: input.to.checkpointTurnCount,
        expectedRepositoryCommonDir: from.checkpointRepositoryCommonDir,
        actualRepositoryCommonDir: to.checkpointRepositoryCommonDir,
        attemptedRoot: to.cwd,
      })
    }
    return {
      cwd: from.cwd,
      repositoryCommonDir: from.checkpointRepositoryCommonDir,
      fromCommitOid: from.checkpointCommitOid,
      toCommitOid: to.checkpointCommitOid,
    }
  })

  const resolveDestructive: CheckpointIdentityResolver['Service']['resolveDestructive'] = Effect.fn(
    'CheckpointIdentity.resolveDestructive',
  )(function* (input)
  {
    const mode = identityMode(input.record)
    if (mode !== 'authoritative')
    {
      return yield* new CheckpointDestructiveLegacyRefusalError({
        operation: 'revert',
        checkpointRef: input.record.checkpointRef,
        checkpointTurnCount: input.record.checkpointTurnCount,
        legacyMode: mode,
      })
    }
    if (input.restoreRoot === null)
    {
      return yield* rootUnavailable(
        'revert',
        input.record,
        null,
        'no selected provider-session root is available',
      )
    }
    const repository = yield* resolveRepository({
      operation: 'revert',
      record: input.record,
      cwd: input.restoreRoot,
    })
    if (repository.commonDir !== input.record.checkpointRepositoryCommonDir)
    {
      return yield* repositoryMismatch(
        'revert',
        input.record,
        input.record.checkpointRepositoryCommonDir as string,
        repository,
      )
    }
    const actualCommitOid = yield* resolveRefOid({
      operation: 'revert',
      record: input.record,
      cwd: repository.root,
    })
    if (actualCommitOid !== input.record.checkpointCommitOid)
    {
      return yield* oidMismatch(
        'revert',
        input.record,
        input.record.checkpointCommitOid,
        actualCommitOid,
        repository.root,
      )
    }
    return {
      cwd: repository.root,
      checkpointRef: input.record.checkpointRef,
      checkpointTurnCount: input.record.checkpointTurnCount,
      checkpointCaptureRoot: input.record.checkpointCaptureRoot as string,
      checkpointRepositoryCommonDir: input.record.checkpointRepositoryCommonDir as string,
      checkpointCommitOid: input.record.checkpointCommitOid as string,
      legacyMode: 'none',
    }
  })

  const resolveRepositoryRevision: CheckpointIdentityResolver['Service']['resolveRepositoryRevision'] =
    Effect.fn('CheckpointIdentity.resolveRepositoryRevision')(function* (input)
    {
      const record = {
        checkpointRef: CheckpointRef.make(input.revision),
        checkpointTurnCount: 0,
      }
      const repository = yield* resolveRepository({
        operation: 'read',
        record,
        cwd: input.cwd,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new RepositoryRevisionUnavailableError({
              cwd: input.cwd,
              revision: input.revision,
              detail: cause.message,
            }),
        ),
      )
      if (
        input.expectedRepositoryCommonDir !== undefined &&
        repository.commonDir !== input.expectedRepositoryCommonDir
      )
      {
        return yield* new RepositoryRevisionMismatchError({
          cwd: repository.root,
          expectedRepositoryCommonDir: input.expectedRepositoryCommonDir,
          actualRepositoryCommonDir: repository.commonDir,
        })
      }
      const result = yield* git
        .execute({
          operation: 'CheckpointIdentity.resolveRepositoryRevision',
          cwd: repository.root,
          args: ['rev-parse', '--verify', '--quiet', `${input.revision}^{commit}`],
          allowNonZeroExit: true,
          maxOutputBytes: 4_096,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new RepositoryRevisionUnavailableError({
                cwd: repository.root,
                revision: input.revision,
                detail: cause.message,
              }),
          ),
        )
      const commitOid = result.stdout.trim()
      if (result.exitCode !== 0 || commitOid.length === 0)
      {
        return yield* new RepositoryRevisionUnavailableError({
          cwd: repository.root,
          revision: input.revision,
          detail: result.stderr.trim() || 'the revision is not a commit',
        })
      }
      if (input.expectedCommitOid !== undefined && commitOid !== input.expectedCommitOid)
      {
        return yield* new RepositoryRevisionOidMismatchError({
          cwd: repository.root,
          revision: input.revision,
          expectedCommitOid: input.expectedCommitOid,
          actualCommitOid: commitOid,
        })
      }
      return {
        cwd: repository.root,
        repositoryRoot: repository.root,
        repositoryCommonDir: repository.commonDir,
        commitOid,
      }
    })

  const resolveRepositoryObjectRevision: CheckpointIdentityResolver['Service']['resolveRepositoryObjectRevision'] =
    Effect.fn('CheckpointIdentity.resolveRepositoryObjectRevision')(function* (input)
    {
      const canonicalCommonDir = yield* fileSystem.realPath(input.repositoryCommonDir).pipe(
        Effect.map(path.normalize),
        Effect.mapError(
          () =>
            new RepositoryRevisionUnavailableError({
              cwd: input.repositoryCommonDir,
              revision: input.revision,
              detail: 'the captured Git common directory does not exist',
            }),
        ),
      )
      if (canonicalCommonDir !== path.normalize(input.repositoryCommonDir))
      {
        return yield* new RepositoryRevisionMismatchError({
          cwd: input.repositoryCommonDir,
          expectedRepositoryCommonDir: path.normalize(input.repositoryCommonDir),
          actualRepositoryCommonDir: canonicalCommonDir,
        })
      }
      const gitDirResult = yield* git
        .execute({
          operation: 'CheckpointIdentity.resolveRepositoryObjectRevision.gitDir',
          cwd: canonicalCommonDir,
          args: ['--git-dir', canonicalCommonDir, 'rev-parse', '--absolute-git-dir'],
          allowNonZeroExit: true,
          maxOutputBytes: 4_096,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new RepositoryRevisionUnavailableError({
                cwd: canonicalCommonDir,
                revision: input.revision,
                detail: cause.message,
              }),
          ),
        )
      const actualGitDir = gitDirResult.stdout.trim()
      if (gitDirResult.exitCode !== 0 || actualGitDir.length === 0)
      {
        return yield* new RepositoryRevisionUnavailableError({
          cwd: canonicalCommonDir,
          revision: input.revision,
          detail: gitDirResult.stderr.trim() || 'the captured path is not a Git object database',
        })
      }
      const canonicalActualGitDir = yield* fileSystem.realPath(actualGitDir).pipe(
        Effect.map(path.normalize),
        Effect.mapError(
          () =>
            new RepositoryRevisionUnavailableError({
              cwd: canonicalCommonDir,
              revision: input.revision,
              detail: 'the resolved Git object database is unavailable',
            }),
        ),
      )
      if (canonicalActualGitDir !== canonicalCommonDir)
      {
        return yield* new RepositoryRevisionMismatchError({
          cwd: canonicalCommonDir,
          expectedRepositoryCommonDir: canonicalCommonDir,
          actualRepositoryCommonDir: canonicalActualGitDir,
        })
      }
      const result = yield* git
        .execute({
          operation: 'CheckpointIdentity.resolveRepositoryObjectRevision',
          cwd: canonicalCommonDir,
          args: [
            '--git-dir',
            canonicalCommonDir,
            'rev-parse',
            '--verify',
            '--quiet',
            `${input.revision}^{commit}`,
          ],
          allowNonZeroExit: true,
          maxOutputBytes: 4_096,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new RepositoryRevisionUnavailableError({
                cwd: canonicalCommonDir,
                revision: input.revision,
                detail: cause.message,
              }),
          ),
        )
      const commitOid = result.stdout.trim()
      if (result.exitCode !== 0 || commitOid.length === 0)
      {
        return yield* new RepositoryRevisionUnavailableError({
          cwd: canonicalCommonDir,
          revision: input.revision,
          detail:
            result.stderr.trim() || 'the revision is not a commit in the captured object database',
        })
      }
      if (commitOid !== input.expectedCommitOid)
      {
        return yield* new RepositoryRevisionOidMismatchError({
          cwd: canonicalCommonDir,
          revision: input.revision,
          expectedCommitOid: input.expectedCommitOid,
          actualCommitOid: commitOid,
        })
      }
      return { repositoryCommonDir: canonicalCommonDir, commitOid }
    })

  return CheckpointIdentityResolver.of({
    resolveCapture,
    resolveRead,
    resolveReadRange,
    resolveDestructive,
    resolveRepositoryRevision,
    resolveRepositoryObjectRevision,
  })
})

export const layer = Layer.effect(CheckpointIdentityResolver, make)
