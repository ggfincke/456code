// apps/server/src/persistence/Errors.ts
// define persistence errors

import * as Schema from 'effect/Schema'
import * as SchemaIssue from 'effect/SchemaIssue'
import * as Predicate from 'effect/Predicate'

function summarizeSchemaIssue(issue: SchemaIssue.Issue): string
{
  switch (issue._tag)
  {
    case 'Filter':
    case 'Encoding':
    case 'Pointer':
      return `${issue._tag}(${summarizeSchemaIssue(issue.issue)})`
    case 'Composite':
    case 'AnyOf':
      return `${issue._tag}(${issue.issues.map(summarizeSchemaIssue).join(',')})`
    default:
      return issue._tag
  }
}

// core Persistence Errors

export const PersistenceErrorCorrelation = Schema.Union([
  Schema.Struct({ sessionId: Schema.String }),
  Schema.Struct({ currentSessionId: Schema.String }),
  Schema.Struct({ pairingLinkId: Schema.String }),
  Schema.Struct({ threadId: Schema.String }),
])
export type PersistenceErrorCorrelation = typeof PersistenceErrorCorrelation.Type

export class PersistenceSqlError extends Schema.TaggedErrorClass<PersistenceSqlError>()(
  'PersistenceSqlError',
  {
    operation: Schema.String,
    detail: Schema.optional(Schema.String),
    correlation: Schema.optional(PersistenceErrorCorrelation),
    cause: Schema.optional(Schema.Defect()),
  },
)
{
  override get message(): string
  {
    return this.detail === undefined
      ? `SQL error in ${this.operation}`
      : `SQL error in ${this.operation}: ${this.detail}`
  }
}

export class ReactorDeliveryError extends Schema.TaggedErrorClass<ReactorDeliveryError>()(
  'ReactorDeliveryError',
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
)
{
  override get message(): string
  {
    return `Reactor delivery error in ${this.operation}`
  }
}

export class PersistenceDecodeError extends Schema.TaggedErrorClass<PersistenceDecodeError>()(
  'PersistenceDecodeError',
  {
    operation: Schema.String,
    issue: Schema.String,
    correlation: Schema.optional(PersistenceErrorCorrelation),
    cause: Schema.optional(Schema.Defect()),
  },
)
{
  static fromSchemaError(
    operation: string,
    cause: Schema.SchemaError,
    correlation?: PersistenceErrorCorrelation,
  ): PersistenceDecodeError
  {
    return new PersistenceDecodeError({
      operation,
      issue: summarizeSchemaIssue(cause.issue),
      ...(correlation === undefined ? {} : { correlation }),
      cause,
    })
  }

  override get message(): string
  {
    return `Decode error in ${this.operation}: ${this.issue}`
  }
}
const isPersistenceSqlError = Schema.is(PersistenceSqlError)
const isPersistenceDecodeError = Schema.is(PersistenceDecodeError)
const isReactorDeliveryError = Schema.is(ReactorDeliveryError)

// read a normalized condition through a bounded chain of SQL wrappers
function sqliteCondition(cause: unknown): string | undefined
{
  let value = cause
  for (let depth = 0; depth < 4 && Predicate.isObject(value); depth += 1)
  {
    if (
      'errcode' in value &&
      typeof value.errcode === 'number' &&
      'errstr' in value &&
      typeof value.errstr === 'string'
    )
    {
      return `SQLITE(${value.errcode}) ${value.errstr}`
    }

    if (
      'name' in value &&
      value.name === 'SQLiteError' &&
      'errno' in value &&
      typeof value.errno === 'number' &&
      Number.isInteger(value.errno)
    )
    {
      return `SQLITE(${value.errno})`
    }

    value = 'cause' in value ? value.cause : undefined
  }

  return undefined
}

// rejected payloads contribute only schema tags or normalized driver conditions
function describeSqlCause(cause: unknown): string | undefined
{
  return Schema.isSchemaError(cause) ? summarizeSchemaIssue(cause.issue) : sqliteCondition(cause)
}

// kept for orchestration/projection call sites, which are being revamped separately.
export function toPersistenceSqlError(
  operation: string,
  correlation?: PersistenceErrorCorrelation,
)
{
  return (cause: unknown): PersistenceSqlError =>
  {
    const detail = describeSqlCause(cause)
    return new PersistenceSqlError({
      operation,
      ...(detail === undefined ? {} : { detail }),
      ...(correlation === undefined ? {} : { correlation }),
      cause,
    })
  }
}

// kept for orchestration/projection call sites, which are being revamped separately.
export function toPersistenceDecodeError(
  operation: string,
  correlation?: PersistenceErrorCorrelation,
)
{
  return (cause: Schema.SchemaError): PersistenceDecodeError =>
    PersistenceDecodeError.fromSchemaError(operation, cause, correlation)
}

export function toPersistenceSqlOrDecodeError(
  sqlOperation: string,
  decodeOperation: string,
  correlation?: PersistenceErrorCorrelation,
)
{
  return (cause: unknown): PersistenceSqlError | PersistenceDecodeError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause, correlation)
      : toPersistenceSqlError(sqlOperation, correlation)(cause)
}

export const isPersistenceError = (u: unknown) =>
  isPersistenceSqlError(u) || isPersistenceDecodeError(u) || isReactorDeliveryError(u)

// provider Session Repository Errors

export class ProviderSessionRepositoryValidationError extends Schema.TaggedErrorClass<ProviderSessionRepositoryValidationError>()(
  'ProviderSessionRepositoryValidationError',
  {
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
)
{
  override get message(): string
  {
    return `Provider session repository validation failed in ${this.operation}: ${this.issue}`
  }
}

export class ProviderSessionRepositoryPersistenceError extends Schema.TaggedErrorClass<ProviderSessionRepositoryPersistenceError>()(
  'ProviderSessionRepositoryPersistenceError',
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
)
{
  override get message(): string
  {
    return `Provider session repository persistence error in ${this.operation}: ${this.detail}`
  }
}

export type OrchestrationEventStoreError = PersistenceSqlError | PersistenceDecodeError

export type ProviderSessionRepositoryError =
  ProviderSessionRepositoryValidationError | ProviderSessionRepositoryPersistenceError

export type OrchestrationCommandReceiptRepositoryError =
  PersistenceSqlError | PersistenceDecodeError

export type ProviderSessionRuntimeRepositoryError = PersistenceSqlError | PersistenceDecodeError
export type AuthPairingLinkRepositoryError = PersistenceSqlError | PersistenceDecodeError
export type AuthSessionRepositoryError = PersistenceSqlError | PersistenceDecodeError

export type ProjectionRepositoryError = PersistenceSqlError | PersistenceDecodeError
