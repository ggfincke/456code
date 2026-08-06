// packages/client-runtime/src/relay/protocol.ts
// constructs the relay http protocol from contract schemas

import * as Relay from '@t3tools/contracts/relay'
import { EnvironmentId, ThreadId } from '@t3tools/contracts'
import * as Context from 'effect/Context'
import * as Schema from 'effect/Schema'
import * as HttpApi from 'effect/unstable/httpapi/HttpApi'
import * as HttpApiEndpoint from 'effect/unstable/httpapi/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/unstable/httpapi/HttpApiGroup'
import * as HttpApiMiddleware from 'effect/unstable/httpapi/HttpApiMiddleware'
import * as HttpApiSecurity from 'effect/unstable/httpapi/HttpApiSecurity'
import * as OpenApi from 'effect/unstable/httpapi/OpenApi'

const RelayAuthAndInternalErrors = [Relay.RelayAuthInvalidError, Relay.RelayInternalError] as const

const RelayEnvironmentLinkErrors = [
  Relay.RelayAuthInvalidError,
  Relay.RelayEnvironmentLinkProofExpiredError,
  Relay.RelayEnvironmentLinkProofInvalidError,
  Relay.RelayEnvironmentLinkUnavailableError,
  Relay.RelayEnvironmentLinkFailedError,
  Relay.RelayInternalError,
] as const

const RelayEnvironmentConnectErrors = [
  Relay.RelayAuthInvalidError,
  Relay.RelayEnvironmentConnectNotAuthorizedError,
  Relay.RelayEnvironmentEndpointUnavailableError,
  Relay.RelayEnvironmentEndpointTimedOutError,
  Relay.RelayInternalError,
] as const

const RelayAgentActivityPublishErrors = [
  Relay.RelayAuthInvalidError,
  Relay.RelayAgentActivityPublishProofExpiredError,
  Relay.RelayAgentActivityPublishProofInvalidError,
  Relay.RelayInternalError,
] as const

export class RelayClientPrincipal extends Context.Service<
  RelayClientPrincipal,
  {
    readonly userId: string
    readonly token: string
    readonly proofKeyThumbprint?: string
    readonly dpopScopes?: ReadonlyArray<Relay.RelayDpopAccessTokenScope>
  }
>()('@t3tools/client-runtime/relay/protocol/RelayClientPrincipal')
{}

export class RelayEnvironmentPrincipal extends Context.Service<
  RelayEnvironmentPrincipal,
  {
    readonly environmentId: string
    readonly environmentPublicKey: string
  }
>()('@t3tools/client-runtime/relay/protocol/RelayEnvironmentPrincipal')
{}

const RelayClientBearerAuthorization = HttpApiSecurity.http({ scheme: 'bearer' }).pipe(
  HttpApiSecurity.annotate(
    OpenApi.Description,
    'Clerk session or OAuth bearer token for the signed-in relay user.',
  ),
)

export class RelayClientAuth extends HttpApiMiddleware.Service<
  RelayClientAuth,
  { provides: RelayClientPrincipal }
>()('RelayClientAuth', {
  error: Relay.RelayAuthInvalidError,
  security: { clientBearer: RelayClientBearerAuthorization },
})
{}

const RelayEnvironmentBearerAuthorization = HttpApiSecurity.http({ scheme: 'bearer' }).pipe(
  HttpApiSecurity.annotate(
    OpenApi.Description,
    'Relay-issued environment credential installed when the environment is linked.',
  ),
)

export class RelayEnvironmentAuth extends HttpApiMiddleware.Service<
  RelayEnvironmentAuth,
  { provides: RelayEnvironmentPrincipal }
>()('RelayEnvironmentAuth', {
  error: [Relay.RelayAuthInvalidError, Relay.RelayInternalError],
  security: { environmentBearer: RelayEnvironmentBearerAuthorization },
})
{}

const RelayDpopAuthorization = HttpApiSecurity.http({ scheme: 'DPoP' }).pipe(
  HttpApiSecurity.annotate(
    OpenApi.Description,
    'DPoP-bound access token. Requests must also include the DPoP proof JWT header.',
  ),
)

export class RelayDpopClientAuth extends HttpApiMiddleware.Service<
  RelayDpopClientAuth,
  { provides: RelayClientPrincipal }
>()('RelayDpopClientAuth', {
  error: Relay.RelayAuthInvalidError,
  security: { relayDpop: RelayDpopAuthorization },
})
{}

export const RelayHealthGroup = HttpApiGroup.make('health')
  .add(
    HttpApiEndpoint.get('health', '/health', {
      success: Relay.RelayHealthResponse,
      error: Relay.RelayInternalError,
    }).annotate(OpenApi.Summary, 'Check relay health'),
  )
  .annotate(OpenApi.Description, 'Service health and readiness.')

export const RelayMetadataGroup = HttpApiGroup.make('metadata')
  .add(
    HttpApiEndpoint.get('authorizationServer', '/.well-known/oauth-authorization-server', {
      success: Relay.RelayAuthorizationServerMetadata,
    }).annotate(OpenApi.Summary, 'Read OAuth authorization-server metadata'),
    HttpApiEndpoint.get('protectedResource', '/.well-known/oauth-protected-resource', {
      success: Relay.RelayProtectedResourceMetadata,
    }).annotate(OpenApi.Summary, 'Read OAuth protected-resource metadata'),
  )
  .annotate(OpenApi.Description, 'OAuth and DPoP discovery metadata.')

export const RelayRegisterDeviceEndpoint = HttpApiEndpoint.post(
  'registerDevice',
  '/v1/mobile/devices',
  {
    headers: Relay.RelayDpopRequestHeaders,
    payload: Relay.RelayDeviceRegistrationRequest,
    success: Relay.RelayOkResponse,
    error: RelayAuthAndInternalErrors,
  },
).annotate(OpenApi.Summary, 'Register or update a mobile device')

export const RelayRegisterLiveActivityEndpoint = HttpApiEndpoint.post(
  'registerLiveActivity',
  '/v1/mobile/live-activities',
  {
    headers: Relay.RelayDpopRequestHeaders,
    payload: Relay.RelayLiveActivityRegistrationRequest,
    success: Relay.RelayOkResponse,
    error: RelayAuthAndInternalErrors,
  },
).annotate(OpenApi.Summary, 'Register a Live Activity push token')

export const RelayAgentActivitySnapshotEndpoint = HttpApiEndpoint.get(
  'getAgentActivitySnapshot',
  '/v1/mobile/agent-activity',
  {
    headers: Relay.RelayDpopRequestHeaders,
    success: Relay.RelayAgentActivitySnapshotResponse,
    error: RelayAuthAndInternalErrors,
  },
).annotate(OpenApi.Summary, 'Read the current Live Activity aggregate')

export const RelayUnregisterDeviceEndpoint = HttpApiEndpoint.delete(
  'unregisterDevice',
  '/v1/mobile/devices/:deviceId',
  {
    headers: Relay.RelayDpopRequestHeaders,
    params: Relay.RelayDeviceUnregistrationParams,
    success: Relay.RelayOkResponse,
    error: RelayAuthAndInternalErrors,
  },
).annotate(OpenApi.Summary, 'Unregister a mobile device')

export const RelayMobileGroup = HttpApiGroup.make('mobile')
  .add(
    RelayRegisterDeviceEndpoint,
    RelayRegisterLiveActivityEndpoint,
    RelayAgentActivitySnapshotEndpoint,
    RelayUnregisterDeviceEndpoint,
  )
  .annotate(OpenApi.Description, 'Mobile push-notification and Live Activity registration.')
  .middleware(RelayDpopClientAuth)

export const RelayClientGroup = HttpApiGroup.make('client')
  .add(
    HttpApiEndpoint.get('listEnvironments', '/v1/environments', {
      headers: Relay.RelayBearerRequestHeaders,
      success: Relay.RelayListEnvironmentsResponse,
      error: RelayAuthAndInternalErrors,
    }).annotate(OpenApi.Summary, 'List linked environments'),
    HttpApiEndpoint.get('listDevices', '/v1/client/devices', {
      headers: Relay.RelayBearerRequestHeaders,
      success: Relay.RelayListDevicesResponse,
      error: RelayAuthAndInternalErrors,
    }).annotate(OpenApi.Summary, 'List registered mobile devices'),
    HttpApiEndpoint.post('linkEnvironment', '/v1/client/environment-links', {
      headers: Relay.RelayBearerRequestHeaders,
      payload: Relay.RelayEnvironmentLinkRequest,
      success: Relay.RelayEnvironmentLinkResponse,
      error: RelayEnvironmentLinkErrors,
    }).annotate(OpenApi.Summary, 'Link an environment'),
    HttpApiEndpoint.post(
      'createEnvironmentLinkChallenge',
      '/v1/client/environment-link-challenges',
      {
        headers: Relay.RelayBearerRequestHeaders,
        payload: Relay.RelayEnvironmentLinkChallengeRequest,
        success: Relay.RelayEnvironmentLinkChallengeResponse,
        error: RelayAuthAndInternalErrors,
      },
    ).annotate(OpenApi.Summary, 'Create an environment-link challenge'),
    HttpApiEndpoint.delete('unlinkEnvironment', '/v1/client/environment-links/:environmentId', {
      headers: Relay.RelayBearerRequestHeaders,
      params: Relay.RelayEnvironmentUnlinkParams,
      success: Relay.RelayOkResponse,
      error: RelayAuthAndInternalErrors,
    }).annotate(OpenApi.Summary, 'Unlink an environment'),
  )
  .annotate(OpenApi.Description, 'Cloud-user environment links and registered devices.')
  .middleware(RelayClientAuth)

export const RelayExchangeDpopAccessTokenEndpoint = HttpApiEndpoint.post(
  'exchangeDpopAccessToken',
  '/v1/client/dpop-token',
  {
    headers: Relay.RelayDpopProofRequestHeaders,
    payload: Relay.RelayDpopAccessTokenRequest,
    success: Relay.RelayDpopAccessTokenResponse,
    error: RelayAuthAndInternalErrors,
  },
)
  .annotate(OpenApi.Summary, 'Exchange a Clerk token for a DPoP access token')
  .annotate(
    OpenApi.Description,
    'Bootstrap endpoint. Send the DPoP proof JWT in the dpop header and the Clerk token in subject_token. The returned access token is bound to the proof key.',
  )

export const RelayTokenGroup = HttpApiGroup.make('token')
  .add(RelayExchangeDpopAccessTokenEndpoint)
  .annotate(OpenApi.Description, 'OAuth token exchange for DPoP-bound client access.')

export const RelayConnectEnvironmentEndpoint = HttpApiEndpoint.post(
  'connectEnvironment',
  '/v1/environments/:environmentId/connect',
  {
    headers: Relay.RelayDpopRequestHeaders,
    params: Schema.Struct({ environmentId: EnvironmentId }),
    payload: Relay.RelayEnvironmentConnectRequest,
    success: Relay.RelayEnvironmentConnectResponse,
    error: RelayEnvironmentConnectErrors,
  },
).annotate(OpenApi.Summary, 'Connect to an environment')

export const RelayGetEnvironmentStatusEndpoint = HttpApiEndpoint.post(
  'getEnvironmentStatus',
  '/v1/environments/:environmentId/status',
  {
    headers: Relay.RelayDpopRequestHeaders,
    params: Schema.Struct({ environmentId: EnvironmentId }),
    success: Relay.RelayEnvironmentStatusResponse,
    error: RelayEnvironmentConnectErrors,
  },
).annotate(OpenApi.Summary, 'Check environment status')

export const RelayDpopClientGroup = HttpApiGroup.make('dpopClient')
  .add(RelayConnectEnvironmentEndpoint, RelayGetEnvironmentStatusEndpoint)
  .annotate(OpenApi.Description, 'DPoP-authenticated client access to linked environments.')
  .middleware(RelayDpopClientAuth)

export const RelayServerGroup = HttpApiGroup.make('server')
  .add(
    HttpApiEndpoint.post(
      'publishAgentActivity',
      '/v1/environments/:environmentId/threads/:threadId/agent-activity',
      {
        params: Schema.Struct({
          environmentId: EnvironmentId,
          threadId: ThreadId,
        }),
        payload: Relay.RelayAgentActivityPublishRequest,
        success: Relay.RelayPublishResponse,
        error: RelayAgentActivityPublishErrors,
      },
    ).annotate(OpenApi.Summary, 'Publish agent activity'),
  )
  .annotate(OpenApi.Description, 'Environment-authenticated activity publication.')
  .middleware(RelayEnvironmentAuth)

export const RelayApi = HttpApi.make('RelayApi')
  .add(
    RelayHealthGroup,
    RelayMetadataGroup,
    RelayMobileGroup,
    RelayClientGroup,
    RelayTokenGroup,
    RelayDpopClientGroup,
    RelayServerGroup,
  )
  .annotate(OpenApi.Title, '456code Relay API')
  .annotate(OpenApi.Version, '1.0.0')
  .annotate(
    OpenApi.Description,
    'Control-plane API for linking 456code environments, connecting authorized clients, and publishing agent activity.',
  )
export type RelayApi = typeof RelayApi
