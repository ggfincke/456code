// apps/server/src/auth/EnvironmentAuthErrors.ts
// define server authentication errors and error classifiers

import * as Schema from 'effect/Schema'

const serverAuthInternalErrorContext = {
  cause: Schema.Defect(),
}

export class ServerAuthBootstrapCredentialValidationError extends Schema.TaggedError<ServerAuthBootstrapCredentialValidationError>()(
  'ServerAuthBootstrapCredentialValidationError',
  {
    ...serverAuthInternalErrorContext,
  },
)
{
  override get message(): string
  {
    return 'Failed to validate bootstrap credential.'
  }
}

export class ServerAuthSessionCredentialValidationError extends Schema.TaggedError<ServerAuthSessionCredentialValidationError>()(
  'ServerAuthSessionCredentialValidationError',
  {
    ...serverAuthInternalErrorContext,
  },
)
{
  override get message(): string
  {
    return 'Failed to validate session credential.'
  }
}

export class ServerAuthAuthenticatedSessionIssueError extends Schema.TaggedError<ServerAuthAuthenticatedSessionIssueError>()(
  'ServerAuthAuthenticatedSessionIssueError',
  {
    ...serverAuthInternalErrorContext,
  },
)
{
  override get message(): string
  {
    return 'Failed to issue authenticated session.'
  }
}

export class ServerAuthAuthenticatedAccessTokenIssueError extends Schema.TaggedError<ServerAuthAuthenticatedAccessTokenIssueError>()(
  'ServerAuthAuthenticatedAccessTokenIssueError',
  {
    ...serverAuthInternalErrorContext,
  },
)
{
  override get message(): string
  {
    return 'Failed to issue authenticated access token.'
  }
}

export class ServerAuthPairingLinkCreationError extends Schema.TaggedError<ServerAuthPairingLinkCreationError>()(
  'ServerAuthPairingLinkCreationError',
  {
    ...serverAuthInternalErrorContext,
  },
)
{
  override get message(): string
  {
    return 'Failed to create pairing link.'
  }
}

export class ServerAuthPairingLinksListError extends Schema.TaggedError<ServerAuthPairingLinksListError>()(
  'ServerAuthPairingLinksListError',
  {
    ...serverAuthInternalErrorContext,
  },
)
{
  override get message(): string
  {
    return 'Failed to list pairing links.'
  }
}

export class ServerAuthPairingLinkRevocationError extends Schema.TaggedError<ServerAuthPairingLinkRevocationError>()(
  'ServerAuthPairingLinkRevocationError',
  {
    ...serverAuthInternalErrorContext,
  },
)
{
  override get message(): string
  {
    return 'Failed to revoke pairing link.'
  }
}

export class ServerAuthSessionTokenIssueError extends Schema.TaggedError<ServerAuthSessionTokenIssueError>()(
  'ServerAuthSessionTokenIssueError',
  {
    ...serverAuthInternalErrorContext,
  },
)
{
  override get message(): string
  {
    return 'Failed to issue session token.'
  }
}

export class ServerAuthSessionsListError extends Schema.TaggedError<ServerAuthSessionsListError>()(
  'ServerAuthSessionsListError',
  {
    ...serverAuthInternalErrorContext,
  },
)
{
  override get message(): string
  {
    return 'Failed to list sessions.'
  }
}

export class ServerAuthSessionRevocationError extends Schema.TaggedError<ServerAuthSessionRevocationError>()(
  'ServerAuthSessionRevocationError',
  {
    ...serverAuthInternalErrorContext,
  },
)
{
  override get message(): string
  {
    return 'Failed to revoke session.'
  }
}

export class ServerAuthOtherSessionsRevocationError extends Schema.TaggedError<ServerAuthOtherSessionsRevocationError>()(
  'ServerAuthOtherSessionsRevocationError',
  {
    ...serverAuthInternalErrorContext,
  },
)
{
  override get message(): string
  {
    return 'Failed to revoke other sessions.'
  }
}

export class ServerAuthWebSocketTokenIssueError extends Schema.TaggedError<ServerAuthWebSocketTokenIssueError>()(
  'ServerAuthWebSocketTokenIssueError',
  {
    ...serverAuthInternalErrorContext,
  },
)
{
  override get message(): string
  {
    return 'Failed to issue websocket token.'
  }
}

export class ServerAuthDpopReplayStateRecordError extends Schema.TaggedError<ServerAuthDpopReplayStateRecordError>()(
  'ServerAuthDpopReplayStateRecordError',
  {
    ...serverAuthInternalErrorContext,
  },
)
{
  override get message(): string
  {
    return 'Failed to record DPoP proof replay state.'
  }
}

export class ServerAuthDpopReplayKeyCalculationError extends Schema.TaggedError<ServerAuthDpopReplayKeyCalculationError>()(
  'ServerAuthDpopReplayKeyCalculationError',
  {
    ...serverAuthInternalErrorContext,
  },
)
{
  override get message(): string
  {
    return 'Failed to calculate DPoP replay key.'
  }
}

export const ServerAuthInternalError = Schema.Union([
  ServerAuthBootstrapCredentialValidationError,
  ServerAuthSessionCredentialValidationError,
  ServerAuthAuthenticatedSessionIssueError,
  ServerAuthAuthenticatedAccessTokenIssueError,
  ServerAuthPairingLinkCreationError,
  ServerAuthPairingLinksListError,
  ServerAuthPairingLinkRevocationError,
  ServerAuthSessionTokenIssueError,
  ServerAuthSessionsListError,
  ServerAuthSessionRevocationError,
  ServerAuthOtherSessionsRevocationError,
  ServerAuthWebSocketTokenIssueError,
  ServerAuthDpopReplayStateRecordError,
  ServerAuthDpopReplayKeyCalculationError,
])
export type ServerAuthInternalError = typeof ServerAuthInternalError.Type
export const isServerAuthInternalError = Schema.is(ServerAuthInternalError)

export class ServerAuthMissingCredentialError extends Schema.TaggedError<ServerAuthMissingCredentialError>()(
  'ServerAuthMissingCredentialError',
  {},
)
{
  override get message(): string
  {
    return 'Server authentication credential is missing.'
  }
}

export class ServerAuthInvalidCredentialError extends Schema.TaggedError<ServerAuthInvalidCredentialError>()(
  'ServerAuthInvalidCredentialError',
  {
    diagnostic: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
)
{
  override get message(): string
  {
    return 'Server authentication credential is invalid.'
  }
}

export const ServerAuthCredentialError = Schema.Union([
  ServerAuthMissingCredentialError,
  ServerAuthInvalidCredentialError,
])
export type ServerAuthCredentialError = typeof ServerAuthCredentialError.Type
export const isServerAuthCredentialError = Schema.is(ServerAuthCredentialError)
export const serverAuthCredentialReason = (
  error: ServerAuthCredentialError,
): 'missing_credential' | 'invalid_credential' =>
  error._tag === 'ServerAuthMissingCredentialError' ? 'missing_credential' : 'invalid_credential'

export class ServerAuthInvalidScopeError extends Schema.TaggedError<ServerAuthInvalidScopeError>()(
  'ServerAuthInvalidScopeError',
  {},
)
{
  override get message(): string
  {
    return 'The requested authentication scope is invalid.'
  }
}

export class ServerAuthScopeNotGrantedError extends Schema.TaggedError<ServerAuthScopeNotGrantedError>()(
  'ServerAuthScopeNotGrantedError',
  {},
)
{
  override get message(): string
  {
    return 'The requested authentication scope was not granted.'
  }
}

export const ServerAuthInvalidRequestError = Schema.Union([
  ServerAuthInvalidScopeError,
  ServerAuthScopeNotGrantedError,
])
export type ServerAuthInvalidRequestError = typeof ServerAuthInvalidRequestError.Type
export const isServerAuthInvalidRequestError = Schema.is(ServerAuthInvalidRequestError)
export const serverAuthInvalidRequestReason = (
  error: ServerAuthInvalidRequestError,
): 'invalid_scope' | 'scope_not_granted' =>
  error._tag === 'ServerAuthInvalidScopeError' ? 'invalid_scope' : 'scope_not_granted'

export class ServerAuthForbiddenOperationError extends Schema.TaggedError<ServerAuthForbiddenOperationError>()(
  'ServerAuthForbiddenOperationError',
  {},
)
{
  override get message(): string
  {
    return 'The current authentication session cannot revoke itself.'
  }
}
