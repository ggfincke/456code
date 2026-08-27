// apps/web/src/components/settings/ConnectionsSettings.tsx
// render connections settings

import {
  ChevronDownIcon,
  ChevronsLeftRightEllipsisIcon,
  PlusIcon,
  RefreshCwIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { type ReactNode, useCallback, useMemo, useState } from 'react'
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthAdministrativeScopes,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthReviewWriteScope,
  AuthStandardClientScopes,
  AuthTerminalOperateScope,
  type AuthClientSession,
  type AuthEnvironmentScope,
  type AuthPairingLink,
  type AdvertisedEndpoint,
  type DesktopDiscoveredSshHost,
  type DesktopSshEnvironmentTarget,
  type DesktopServerExposureState,
  type DesktopWslState,
  type EnvironmentId,
} from '@t3tools/contracts'
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from '@t3tools/client-runtime/state/runtime'
import * as Option from 'effect/Option'

import { cn } from '../../lib/utils'
import { applyWslEnableSelection } from './ConnectionsSettings.logic'
import { SettingsPageContainer, SettingsRow, SettingsSection } from './settingsLayout'
import { Input } from '../ui/input'
import { Checkbox } from '../ui/checkbox'
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from '../ui/dialog'
import { ScrollArea } from '../ui/scroll-area'
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '../ui/alert-dialog'
import { Spinner } from '../ui/spinner'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../ui/select'
import { Switch } from '../ui/switch'
import { stackedThreadToast, toastManager } from '../ui/toast'
import { Tooltip, TooltipPopup, TooltipTrigger } from '../ui/tooltip'
import { Button } from '../ui/button'
import { Group, GroupSeparator } from '../ui/group'
import { AnimatedHeight } from '../AnimatedHeight'
import {
  createServerPairingCredential,
  revokeOtherServerClientSessions,
  revokeServerClientSession,
  revokeServerPairingLink,
  usePrimarySessionState,
  type ServerClientSessionRecord,
} from '~/environments/primary'
import { isDesktopLocalConnectionTarget } from '~/connection/desktopLocal'
import { useUiStateStore } from '~/uiStateStore'
import {
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
} from '~/versionSkew'
import { authEnvironment } from '~/state/auth'
import { environmentCatalog } from '~/connection/catalog'
import {
  connectPairing as connectPairingAtom,
  connectSshEnvironment as connectSshEnvironmentAtom,
} from '~/connection/onboarding'
import { useEnvironmentQuery } from '~/state/query'
import {
  desktopNetworkAccessStateAtom,
  refreshDesktopNetworkAccessState,
} from '~/state/desktopNetworkAccess'
import { desktopSshHostsStateAtom } from '~/state/desktopSshHosts'
import { desktopWslStateAtom, refreshDesktopWslState } from '~/state/desktopWslState'
import {
  type EnvironmentPresentation,
  useEnvironments,
  usePrimaryEnvironment,
} from '~/state/environments'
import { useAtomCommand } from '../../state/use-atom-command'
import { ServerUpdateAction } from '../ServerUpdateAction'
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from './itemRows'
import {
  accessRowClassName,
  type AccessSectionPresentation,
} from './connections/accessPresentation'
import {
  DesktopSshHostRow,
  EmptyRemoteEnvironments,
  SavedBackendListRow,
} from './connections/desktopSsh'
import {
  formatDesktopSshConnectionError,
  formatDesktopSshTarget,
  parseManualDesktopSshTarget,
} from './connections/desktopSshTarget'
import { AdvertisedEndpointListRow, NetworkAccessDescription } from './connections/endpoints'
import {
  endpointDefaultPreferenceKey,
  isTailscaleHttpsEndpoint,
  selectPairingEndpoint,
} from './connections/endpointUrls'
import {
  AuthorizedClientsHeaderAction,
  PairingClientsList,
  sortDesktopClientSessions,
  sortDesktopPairingLinks,
  toDesktopClientSessionRecord,
  toDesktopPairingLinkRecord,
} from './connections/pairing'
import { parsePairingUrlFields, parseRemotePairingFields } from './connections/pairingFields'

const DEFAULT_TAILSCALE_SERVE_PORT = 443
const EMPTY_ADVERTISED_ENDPOINTS: ReadonlyArray<AdvertisedEndpoint> = []
const EMPTY_DISCOVERED_SSH_HOSTS: ReadonlyArray<DesktopDiscoveredSshHost> = []

// sentinels for the consolidated WSL backend picker. The colon is
// rejected by DISTRO_NAME_PATTERN (validated on the desktop side) so
// neither can collide with a real distro name.
const BACKEND_VALUE_DEFAULT_WSL = 'backend:default-wsl'
const BACKEND_VALUE_WSL_OFF = 'backend:wsl-off'

export function ConnectionsSettings()
{
  const desktopBridge = window.desktopBridge
  const { environments } = useEnvironments()
  const primaryEnvironment = usePrimaryEnvironment()
  const connectPairing = useAtomCommand(connectPairingAtom, { reportFailure: false })
  const connectSshEnvironment = useAtomCommand(connectSshEnvironmentAtom, {
    reportFailure: false,
  })
  const removeEnvironment = useAtomCommand(environmentCatalog.remove, { reportFailure: false })
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false })
  const primaryEnvironmentId = primaryEnvironment?.environmentId ?? null
  const primarySessionState = usePrimarySessionState()
  const currentSessionScopes = desktopBridge
    ? AuthAdministrativeScopes
    : primarySessionState.data?.authenticated
      ? (primarySessionState.data.scopes ?? null)
      : null
  const currentAuthPolicy = desktopBridge ? null : (primarySessionState.data?.auth.policy ?? null)
  const savedEnvironments = useMemo(
    () =>
      environments
        .filter((environment) => environment.entry.target._tag !== 'PrimaryConnectionTarget')
        .toSorted((left, right) => left.label.localeCompare(right.label)),
    [environments],
  )
  const savedDesktopSshEnvironmentsByAlias = useMemo(
    () =>
      savedEnvironments.reduce<Record<string, EnvironmentPresentation>>(
        (accumulator, environment) =>
        {
          const profile = environment.entry.profile
          if (
            environment.entry.target._tag === 'SshConnectionTarget' &&
            Option.isSome(profile) &&
            profile.value._tag === 'SshConnectionProfile'
          )
          {
            accumulator[profile.value.target.alias] = environment
          }
          return accumulator
        },
        {},
      ),
    [savedEnvironments],
  )
  const savedDesktopSshEnvironmentKeys = useMemo(() =>
  {
    const keys = new Set<string>()
    for (const environment of savedEnvironments)
    {
      const profile = environment.entry.profile
      if (
        environment.entry.target._tag !== 'SshConnectionTarget' ||
        Option.isNone(profile) ||
        profile.value._tag !== 'SshConnectionProfile'
      )
      {
        continue
      }
      const target = profile.value.target
      keys.add(target.alias)
      keys.add(formatDesktopSshTarget(target))
    }
    return keys
  }, [savedEnvironments])
  const [sshConnectionError, setSshConnectionError] = useState<string | null>(null)
  const [connectingSshHostAlias, setConnectingSshHostAlias] = useState<string | null>(null)

  const [desktopServerExposureMutationError, setDesktopServerExposureMutationError] = useState<
    string | null
  >(null)
  const [desktopAccessManagementMutationError, setDesktopAccessManagementMutationError] = useState<
    string | null
  >(null)
  const [revokingDesktopPairingLinkId, setRevokingDesktopPairingLinkId] = useState<string | null>(
    null,
  )
  const [revokingDesktopClientSessionId, setRevokingDesktopClientSessionId] = useState<
    string | null
  >(null)
  const [isRevokingOtherDesktopClients, setIsRevokingOtherDesktopClients] = useState(false)
  const [addBackendDialogOpen, setAddBackendDialogOpen] = useState(false)
  const [savedBackendMode, setSavedBackendMode] = useState<'remote' | 'ssh'>('remote')
  const [savedBackendHost, setSavedBackendHost] = useState('')
  const [savedBackendPairingCode, setSavedBackendPairingCode] = useState('')
  const [savedBackendSshHost, setSavedBackendSshHost] = useState('')
  const [savedBackendSshUsername, setSavedBackendSshUsername] = useState('')
  const [savedBackendSshPort, setSavedBackendSshPort] = useState('')
  const [savedBackendError, setSavedBackendError] = useState<string | null>(null)
  const [isAddingSavedBackend, setIsAddingSavedBackend] = useState(false)
  const [removingSavedEnvironmentId, setRemovingSavedEnvironmentId] =
    useState<EnvironmentId | null>(null)
  const [isUpdatingDesktopServerExposure, setIsUpdatingDesktopServerExposure] = useState(false)
  const [isDesktopServerExposureDialogOpen, setIsDesktopServerExposureDialogOpen] = useState(false)
  const [isUpdatingTailscaleServe, setIsUpdatingTailscaleServe] = useState(false)
  const [isUpdatingWslBackend, setIsUpdatingWslBackend] = useState(false)
  const [desktopWslMutationError, setDesktopWslMutationError] = useState<string | null>(null)
  // pending WSL setting change waiting on user confirmation. Set when
  // the user tries a destructive change (disable, switch distro,
  // toggle wsl-only) while the WSL backend has saved-env state on this
  // machine. Confirming applies the change; cancelling drops it
  // without touching the persisted setting. Null when nothing is
  // pending.
  type PendingWslChange =
    // wasWslOnly is true when the user picked Off while wsl-only mode
    // was active. In that case "disable" also clears wsl-only and
    // relaunches onto the Windows backend, because leaving wsl-only on
    // with wslBackendEnabled off is a meaningless state (wsl-only is
    // only honoured when the WSL backend is enabled).
    | { readonly kind: 'disable'; readonly wasWslOnly: boolean }
    | { readonly kind: 'distro'; readonly nextDistro: string | null }
    // asked at enable time so the user picks the mode upfront instead
    // of being dropped into "both backends" and having to discover the
    // wsl-only switch separately. Resolved through enable-mode action
    // buttons on the dialog rather than a single Confirm.
    | { readonly kind: 'enable'; readonly nextDistro: string | null }
    | { readonly kind: 'wsl-only'; readonly nextValue: boolean }
  const [pendingWslChange, setPendingWslChange] = useState<PendingWslChange | null>(null)
  const isWslConfirmDialogOpen = pendingWslChange !== null
  const [pendingTailscaleServeEndpoint, setPendingTailscaleServeEndpoint] =
    useState<AdvertisedEndpoint | null>(null)
  const [disableTailscaleServeDialogOpen, setDisableTailscaleServeDialogOpen] = useState(false)
  const [tailscaleServePortInput, setTailscaleServePortInput] = useState(
    String(DEFAULT_TAILSCALE_SERVE_PORT),
  )
  const [pendingDesktopServerExposureMode, setPendingDesktopServerExposureMode] = useState<
    DesktopServerExposureState['mode'] | null
  >(null)
  const primaryServerConfig = primaryEnvironment?.serverConfig ?? null
  const primaryVersionMismatch = resolveServerConfigVersionMismatch(primaryServerConfig)
  const [isAdvertisedEndpointListExpanded, setIsAdvertisedEndpointListExpanded] = useState(false)
  const defaultAdvertisedEndpointKey = useUiStateStore(
    (state) => state.defaultAdvertisedEndpointKey,
  )
  const setDefaultAdvertisedEndpointKey = useUiStateStore(
    (state) => state.setDefaultAdvertisedEndpointKey,
  )
  const canManageLocalBackend = currentSessionScopes?.includes(AuthAccessWriteScope) ?? false
  const authAccessChanges = useEnvironmentQuery(
    canManageLocalBackend && primaryEnvironmentId !== null
      ? authEnvironment.accessChanges({
          environmentId: primaryEnvironmentId,
          input: null,
        })
      : null,
  )
  const desktopNetworkAccess = useEnvironmentQuery(
    canManageLocalBackend && desktopBridge ? desktopNetworkAccessStateAtom : null,
  )
  const desktopSshHosts = useEnvironmentQuery(
    desktopBridge && addBackendDialogOpen && savedBackendMode === 'ssh'
      ? desktopSshHostsStateAtom
      : null,
  )
  const desktopWsl = useEnvironmentQuery(
    canManageLocalBackend && desktopBridge ? desktopWslStateAtom : null,
  )
  const desktopWslState = desktopWsl.data
  const desktopWslError = desktopWslMutationError ?? desktopWsl.error
  const isLoadingWslState = desktopWsl.isPending && desktopWsl.data === null
  const discoveredSshHosts = desktopSshHosts.data ?? EMPTY_DISCOVERED_SSH_HOSTS
  const unsavedDiscoveredSshHosts = useMemo(
    () =>
      discoveredSshHosts.filter((target) =>
      {
        const address = formatDesktopSshTarget(target)
        return (
          !savedDesktopSshEnvironmentKeys.has(target.alias) &&
          !savedDesktopSshEnvironmentKeys.has(address)
        )
      }),
    [discoveredSshHosts, savedDesktopSshEnvironmentKeys],
  )
  const hasLoadedDiscoveredSshHosts =
    desktopSshHosts.data !== null || desktopSshHosts.error !== null
  const isLoadingDiscoveredSshHosts = desktopSshHosts.isPending
  const discoveredSshHostsError = sshConnectionError ?? desktopSshHosts.error
  const desktopServerExposureState = desktopNetworkAccess.data?.serverExposureState ?? null
  const desktopAdvertisedEndpoints =
    desktopNetworkAccess.data?.advertisedEndpoints ?? EMPTY_ADVERTISED_ENDPOINTS
  const desktopServerExposureError =
    desktopServerExposureMutationError ?? desktopNetworkAccess.error
  const desktopAccessManagementError =
    desktopAccessManagementMutationError ?? authAccessChanges.error
  const isLoadingDesktopAccessManagement =
    authAccessChanges.isPending && authAccessChanges.data === null
  const desktopPairingLinks = useMemo(() =>
  {
    const event = authAccessChanges.data
    if (event?.type !== 'snapshot') return []
    return sortDesktopPairingLinks(
      event.payload.pairingLinks.map((pairingLink: AuthPairingLink) =>
        toDesktopPairingLinkRecord(pairingLink),
      ),
    )
  }, [authAccessChanges.data])
  const desktopClientSessions = useMemo(() =>
  {
    const event = authAccessChanges.data
    if (event?.type !== 'snapshot') return []
    return sortDesktopClientSessions(
      event.payload.clientSessions.map((clientSession: AuthClientSession) =>
        toDesktopClientSessionRecord(clientSession),
      ),
    )
  }, [authAccessChanges.data])
  const isLocalBackendNetworkAccessible = desktopBridge
    ? desktopServerExposureState?.mode === 'network-accessible'
    : currentAuthPolicy === 'remote-reachable'
  const trimmedTailscaleServePortInput = tailscaleServePortInput.trim()
  const parsedTailscaleServePort = Number(trimmedTailscaleServePortInput)
  const isTailscaleServePortValid =
    /^\d+$/u.test(trimmedTailscaleServePortInput) &&
    Number.isInteger(parsedTailscaleServePort) &&
    parsedTailscaleServePort >= 1 &&
    parsedTailscaleServePort <= 65_535

  const pendingTailscaleServeBaseUrl = useMemo(() =>
  {
    if (!pendingTailscaleServeEndpoint) return null
    if (!isTailscaleServePortValid) return pendingTailscaleServeEndpoint.httpBaseUrl
    if (parsedTailscaleServePort === DEFAULT_TAILSCALE_SERVE_PORT)
    {
      return pendingTailscaleServeEndpoint.httpBaseUrl
    }
    try
    {
      const url = new URL(pendingTailscaleServeEndpoint.httpBaseUrl)
      url.port = String(parsedTailscaleServePort)
      return url.toString().replace(/\/$/u, '')
    }
    catch
    {
      return pendingTailscaleServeEndpoint.httpBaseUrl
    }
  }, [isTailscaleServePortValid, parsedTailscaleServePort, pendingTailscaleServeEndpoint])

  const handleDesktopServerExposureChange = useCallback(
    async (checked: boolean) =>
    {
      if (!desktopBridge) return
      setIsUpdatingDesktopServerExposure(true)
      setDesktopServerExposureMutationError(null)
      try
      {
        await desktopBridge.setServerExposureMode(checked ? 'network-accessible' : 'local-only')
        refreshDesktopNetworkAccessState()
        setIsDesktopServerExposureDialogOpen(false)
        setIsUpdatingDesktopServerExposure(false)
      }
      catch (error)
      {
        const message =
          error instanceof Error ? error.message : 'Failed to update network exposure.'
        setIsDesktopServerExposureDialogOpen(false)
        setDesktopServerExposureMutationError(message)
        toastManager.add(
          stackedThreadToast({
            type: 'error',
            title: 'Could not update network access',
            description: message,
          }),
        )
        setIsUpdatingDesktopServerExposure(false)
      }
    },
    [desktopBridge],
  )

  const handleConfirmDesktopServerExposureChange = useCallback(() =>
  {
    if (pendingDesktopServerExposureMode === null) return
    const checked = pendingDesktopServerExposureMode === 'network-accessible'
    void handleDesktopServerExposureChange(checked)
  }, [handleDesktopServerExposureChange, pendingDesktopServerExposureMode])

  const handleConfirmTailscaleServeSetup = useCallback(async () =>
  {
    if (!desktopBridge) return
    if (!isTailscaleServePortValid) return
    setIsUpdatingTailscaleServe(true)
    setDesktopServerExposureMutationError(null)
    try
    {
      await desktopBridge.setTailscaleServeEnabled({
        enabled: true,
        port: parsedTailscaleServePort,
      })
      refreshDesktopNetworkAccessState()
      setPendingTailscaleServeEndpoint(null)
    }
    catch (error)
    {
      const message =
        error instanceof Error ? error.message : 'Failed to configure Tailscale HTTPS.'
      setDesktopServerExposureMutationError(message)
      toastManager.add(
        stackedThreadToast({
          type: 'error',
          title: 'Could not set up Tailscale HTTPS',
          description: message,
        }),
      )
    }
    finally
    {
      setIsUpdatingTailscaleServe(false)
    }
  }, [desktopBridge, isTailscaleServePortValid, parsedTailscaleServePort])

  const handleStartTailscaleServeSetup = useCallback(
    (endpoint: AdvertisedEndpoint) =>
    {
      setTailscaleServePortInput(
        String(desktopServerExposureState?.tailscaleServePort ?? DEFAULT_TAILSCALE_SERVE_PORT),
      )
      setPendingTailscaleServeEndpoint(endpoint)
    },
    [desktopServerExposureState?.tailscaleServePort],
  )

  const handleConfirmTailscaleServeDisable = useCallback(async () =>
  {
    if (!desktopBridge) return
    setIsUpdatingTailscaleServe(true)
    setDesktopServerExposureMutationError(null)
    try
    {
      await desktopBridge.setTailscaleServeEnabled({
        enabled: false,
        port: desktopServerExposureState?.tailscaleServePort ?? DEFAULT_TAILSCALE_SERVE_PORT,
      })
      refreshDesktopNetworkAccessState()
      setDisableTailscaleServeDialogOpen(false)
    }
    catch (error)
    {
      const message = error instanceof Error ? error.message : 'Failed to disable Tailscale HTTPS.'
      setDesktopServerExposureMutationError(message)
      toastManager.add(
        stackedThreadToast({
          type: 'error',
          title: 'Could not disable Tailscale HTTPS',
          description: message,
        }),
      )
    }
    finally
    {
      setIsUpdatingTailscaleServe(false)
    }
  }, [desktopBridge, desktopServerExposureState?.tailscaleServePort])

  const handleStartTailscaleServeDisable = useCallback((_endpoint: AdvertisedEndpoint) =>
  {
    setDisableTailscaleServeDialogOpen(true)
  }, [])

  const handleRevokeDesktopPairingLink = useCallback(async (id: string) =>
  {
    setRevokingDesktopPairingLinkId(id)
    setDesktopAccessManagementMutationError(null)
    try
    {
      await revokeServerPairingLink(id)
    }
    catch (error)
    {
      const message = error instanceof Error ? error.message : 'Failed to revoke pairing link.'
      setDesktopAccessManagementMutationError(message)
      toastManager.add(
        stackedThreadToast({
          type: 'error',
          title: 'Could not revoke pairing link',
          description: message,
        }),
      )
    }
    finally
    {
      setRevokingDesktopPairingLinkId(null)
    }
  }, [])

  const handleRevokeDesktopClientSession = useCallback(
    async (sessionId: ServerClientSessionRecord['sessionId']) =>
    {
      setRevokingDesktopClientSessionId(sessionId)
      setDesktopAccessManagementMutationError(null)
      try
      {
        await revokeServerClientSession(sessionId)
      }
      catch (error)
      {
        const message = error instanceof Error ? error.message : 'Failed to revoke client access.'
        setDesktopAccessManagementMutationError(message)
        toastManager.add(
          stackedThreadToast({
            type: 'error',
            title: 'Could not revoke client access',
            description: message,
          }),
        )
      }
      finally
      {
        setRevokingDesktopClientSessionId(null)
      }
    },
    [],
  )

  const handleRevokeOtherDesktopClients = useCallback(async () =>
  {
    setIsRevokingOtherDesktopClients(true)
    setDesktopAccessManagementMutationError(null)
    try
    {
      const revokedCount = await revokeOtherServerClientSessions()
      toastManager.add({
        type: 'success',
        title: revokedCount === 1 ? 'Revoked 1 other client' : `Revoked ${revokedCount} clients`,
        description: 'Other paired clients will need a new pairing link before reconnecting.',
      })
    }
    catch (error)
    {
      const message = error instanceof Error ? error.message : 'Failed to revoke other clients.'
      setDesktopAccessManagementMutationError(message)
      toastManager.add(
        stackedThreadToast({
          type: 'error',
          title: 'Could not revoke other clients',
          description: message,
        }),
      )
    }
    finally
    {
      setIsRevokingOtherDesktopClients(false)
    }
  }, [])

  const handleAddSavedBackend = useCallback(async () =>
  {
    if (savedBackendMode === 'ssh')
    {
      setIsAddingSavedBackend(true)
      setSavedBackendError(null)
      let target: DesktopSshEnvironmentTarget
      try
      {
        target = parseManualDesktopSshTarget({
          host: savedBackendSshHost,
          username: savedBackendSshUsername,
          port: savedBackendSshPort,
        })
      }
      catch (error)
      {
        setSavedBackendError(formatDesktopSshConnectionError(error))
        setIsAddingSavedBackend(false)
        return
      }

      const result = await connectSshEnvironment({ target, label: '' })
      if (result._tag === 'Failure')
      {
        if (!isAtomCommandInterrupted(result))
        {
          setSavedBackendError(formatDesktopSshConnectionError(squashAtomCommandFailure(result)))
        }
        setIsAddingSavedBackend(false)
        return
      }

      setSavedBackendHost('')
      setSavedBackendPairingCode('')
      setSavedBackendSshHost('')
      setSavedBackendSshUsername('')
      setSavedBackendSshPort('')
      setAddBackendDialogOpen(false)
      toastManager.add({
        type: 'success',
        title: 'Environment connected',
        description: `${target.alias} is ready over an SSH-managed tunnel.`,
      })
      setIsAddingSavedBackend(false)
      return
    }

    setIsAddingSavedBackend(true)
    setSavedBackendError(null)
    let remotePairingInput: ReturnType<typeof parseRemotePairingFields>
    try
    {
      remotePairingInput = parseRemotePairingFields({
        host: savedBackendHost,
        pairingCode: savedBackendPairingCode,
      })
    }
    catch (error)
    {
      const message = error instanceof Error ? error.message : 'Failed to add backend.'
      setSavedBackendError(message)
      toastManager.add(
        stackedThreadToast({
          type: 'error',
          title: 'Could not add backend',
          description: message,
        }),
      )
      setIsAddingSavedBackend(false)
      return
    }

    const result = await connectPairing(remotePairingInput)
    if (result._tag === 'Failure')
    {
      if (!isAtomCommandInterrupted(result))
      {
        const error = squashAtomCommandFailure(result)
        const message = error instanceof Error ? error.message : 'Failed to add backend.'
        setSavedBackendError(message)
        toastManager.add(
          stackedThreadToast({
            type: 'error',
            title: 'Could not add backend',
            description: message,
          }),
        )
      }
      setIsAddingSavedBackend(false)
      return
    }

    setSavedBackendHost('')
    setSavedBackendPairingCode('')
    setSavedBackendSshHost('')
    setSavedBackendSshUsername('')
    setSavedBackendSshPort('')
    setAddBackendDialogOpen(false)
    toastManager.add({
      type: 'success',
      title: 'Backend added',
      description: 'The environment is saved and will reconnect on app startup.',
    })
    setIsAddingSavedBackend(false)
  }, [
    connectPairing,
    connectSshEnvironment,
    savedBackendHost,
    savedBackendMode,
    savedBackendPairingCode,
    savedBackendSshHost,
    savedBackendSshPort,
    savedBackendSshUsername,
  ])

  const handleConnectSavedBackend = useCallback(
    async (environmentId: EnvironmentId) =>
    {
      setSavedBackendError(null)
      const result = await retryEnvironment(environmentId)
      if (result._tag === 'Failure' && !isAtomCommandInterrupted(result))
      {
        const error = squashAtomCommandFailure(result)
        const message = error instanceof Error ? error.message : 'Failed to connect backend.'
        setSavedBackendError(message)
        toastManager.add(
          stackedThreadToast({
            type: 'error',
            title: 'Could not connect backend',
            description: message,
          }),
        )
      }
    },
    [retryEnvironment],
  )

  const handleRemoveSavedBackend = useCallback(
    async (environmentId: EnvironmentId) =>
    {
      setRemovingSavedEnvironmentId(environmentId)
      setSavedBackendError(null)
      const result = await removeEnvironment(environmentId)
      setRemovingSavedEnvironmentId(null)
      if (result._tag === 'Failure' && !isAtomCommandInterrupted(result))
      {
        const error = squashAtomCommandFailure(result)
        const message = error instanceof Error ? error.message : 'Failed to remove backend.'
        setSavedBackendError(message)
        toastManager.add(
          stackedThreadToast({
            type: 'error',
            title: 'Could not remove backend',
            description: message,
          }),
        )
      }
    },
    [removeEnvironment],
  )

  const handleConnectSshHost = useCallback(
    async (target: DesktopSshEnvironmentTarget, label?: string) =>
    {
      setConnectingSshHostAlias(target.alias)
      if (savedBackendMode === 'ssh')
      {
        setSavedBackendError(null)
      }
      else
      {
        setSshConnectionError(null)
      }
      const result = await connectSshEnvironment({
        target,
        ...(label === undefined ? {} : { label }),
      })
      setConnectingSshHostAlias(null)
      if (result._tag === 'Success')
      {
        setSavedBackendSshHost('')
        setSavedBackendSshUsername('')
        setSavedBackendSshPort('')
        setAddBackendDialogOpen(false)
        toastManager.add({
          type: 'success',
          title: savedDesktopSshEnvironmentsByAlias[target.alias]
            ? 'Environment reconnected'
            : 'Environment connected',
          description: `${label?.trim() || target.alias} is ready over an SSH-managed tunnel.`,
        })
        return
      }
      if (!isAtomCommandInterrupted(result))
      {
        const error = squashAtomCommandFailure(result)
        const message = formatDesktopSshConnectionError(error)
        if (savedBackendMode === 'ssh')
        {
          setSavedBackendError(message)
        }
        else
        {
          setSshConnectionError(message)
        }
      }
    },
    [connectSshEnvironment, savedBackendMode, savedDesktopSshEnvironmentsByAlias],
  )

  const visibleDesktopPairingLinks = desktopPairingLinks
  const tailscaleHttpsEndpoint = useMemo(
    () => desktopAdvertisedEndpoints.find(isTailscaleHttpsEndpoint) ?? null,
    [desktopAdvertisedEndpoints],
  )
  const visibleDesktopNetworkAdvertisedEndpoints = useMemo(
    () =>
      isLocalBackendNetworkAccessible
        ? desktopAdvertisedEndpoints.filter((endpoint) => !isTailscaleHttpsEndpoint(endpoint))
        : [],
    [desktopAdvertisedEndpoints, isLocalBackendNetworkAccessible],
  )
  const visibleDesktopAdvertisedEndpoints = useMemo(
    () =>
      tailscaleHttpsEndpoint
        ? [...visibleDesktopNetworkAdvertisedEndpoints, tailscaleHttpsEndpoint]
        : visibleDesktopNetworkAdvertisedEndpoints,
    [tailscaleHttpsEndpoint, visibleDesktopNetworkAdvertisedEndpoints],
  )
  const isLocalBackendRemotelyReachable =
    isLocalBackendNetworkAccessible || tailscaleHttpsEndpoint?.status === 'available'
  const defaultDesktopNetworkAdvertisedEndpoint = useMemo(
    () =>
      selectPairingEndpoint(visibleDesktopNetworkAdvertisedEndpoints, defaultAdvertisedEndpointKey),
    [defaultAdvertisedEndpointKey, visibleDesktopNetworkAdvertisedEndpoints],
  )
  const defaultDesktopAdvertisedEndpoint = useMemo(
    () =>
      defaultDesktopNetworkAdvertisedEndpoint ??
      selectPairingEndpoint(
        tailscaleHttpsEndpoint ? [tailscaleHttpsEndpoint] : [],
        defaultAdvertisedEndpointKey,
      ),
    [defaultAdvertisedEndpointKey, defaultDesktopNetworkAdvertisedEndpoint, tailscaleHttpsEndpoint],
  )
  const defaultDesktopAdvertisedEndpointKey = defaultDesktopAdvertisedEndpoint
    ? endpointDefaultPreferenceKey(defaultDesktopAdvertisedEndpoint)
    : null
  const handleSetDefaultAdvertisedEndpoint = useCallback(
    (endpoint: AdvertisedEndpoint) =>
    {
      setDefaultAdvertisedEndpointKey(endpointDefaultPreferenceKey(endpoint))
    },
    [setDefaultAdvertisedEndpointKey],
  )
  const handleSavedBackendHostChange = useCallback((value: string) =>
  {
    const parsedPairingUrl = parsePairingUrlFields(value)
    if (parsedPairingUrl)
    {
      setSavedBackendHost(parsedPairingUrl.host)
      setSavedBackendPairingCode(parsedPairingUrl.pairingCode)
      return
    }
    setSavedBackendHost(value)
  }, [])

  const renderConnectionModeCard = (input: {
    readonly mode: 'remote' | 'ssh'
    readonly title: string
    readonly description: string
    readonly icon?: ReactNode
  }) =>
  {
    const selected = savedBackendMode === input.mode
    return (
      <button
        type="button"
        aria-pressed={selected}
        className={cn(
          'group flex min-h-24 items-start gap-3 rounded-lg border p-4 text-left',
          selected ? 'border-primary/50 bg-primary/5' : 'border-border/60 hover:bg-muted/40',
        )}
        disabled={isAddingSavedBackend}
        onClick={() =>
        {
          setSavedBackendMode(input.mode)
        }}
      >
        {input.icon ? (
          <span
            className={cn(
              'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border',
              selected
                ? 'border-primary/30 bg-primary/10 text-primary'
                : 'border-border/70 bg-background text-muted-foreground group-hover:text-foreground',
            )}
          >
            {input.icon}
          </span>
        ) : null}
        <span className="min-w-0">
          <span className="block text-sm font-medium text-foreground">{input.title}</span>
          <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
            {input.description}
          </span>
        </span>
      </button>
    )
  }

  const renderRemoteFields = () => (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">Host</span>
          <Input
            value={savedBackendHost}
            onChange={(event) => handleSavedBackendHostChange(event.target.value)}
            placeholder="backend.example.com"
            disabled={isAddingSavedBackend}
            spellCheck={false}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">Pairing code</span>
          <Input
            value={savedBackendPairingCode}
            onChange={(event) => setSavedBackendPairingCode(event.target.value)}
            placeholder="PAIRCODE"
            disabled={isAddingSavedBackend}
            spellCheck={false}
          />
        </label>
      </div>
      <div>
        <span className="mt-1 block text-[11px] text-muted-foreground">
          Paste a full pairing URL here to fill both fields automatically.
        </span>
      </div>
    </div>
  )
  const renderRemoteModeBody = () => (
    <div className="space-y-4">
      {renderRemoteFields()}
      {savedBackendError ? <p className="text-xs text-destructive">{savedBackendError}</p> : null}
      <Button
        variant="outline"
        className="w-full"
        disabled={isAddingSavedBackend}
        onClick={() => void handleAddSavedBackend()}
      >
        <PlusIcon className="size-3.5" />
        {isAddingSavedBackend ? 'Adding…' : 'Add environment'}
      </Button>
    </div>
  )
  const renderSshFields = () => (
    <div className="space-y-4">
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">
            SSH host or alias
          </span>
          <Input
            value={savedBackendSshHost}
            onChange={(event) => setSavedBackendSshHost(event.target.value)}
            placeholder="Search hosts or type devbox"
            disabled={isAddingSavedBackend}
            spellCheck={false}
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem]">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">Username</span>
            <Input
              value={savedBackendSshUsername}
              onChange={(event) => setSavedBackendSshUsername(event.target.value)}
              placeholder="root"
              disabled={isAddingSavedBackend}
              spellCheck={false}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">Port</span>
            <Input
              value={savedBackendSshPort}
              onChange={(event) => setSavedBackendSshPort(event.target.value)}
              placeholder="22"
              inputMode="numeric"
              disabled={isAddingSavedBackend}
              spellCheck={false}
            />
          </label>
        </div>
        {savedBackendError || discoveredSshHostsError ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {savedBackendError ?? discoveredSshHostsError}
          </div>
        ) : null}
        <Button
          variant="outline"
          className="w-full"
          disabled={isAddingSavedBackend}
          onClick={() => void handleAddSavedBackend()}
        >
          <PlusIcon className="size-3.5" />
          {isAddingSavedBackend ? 'Adding…' : 'Add environment'}
        </Button>
      </div>
      <div className="overflow-hidden rounded-lg border border-border/60">
        <div className="flex items-center justify-between gap-3 border-b border-border/60 bg-muted/30 px-3 py-2">
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">Suggested hosts</p>
            <p className="text-[11px] text-muted-foreground">From SSH config and known hosts</p>
          </div>
          <Button
            size="xs"
            variant="ghost"
            disabled={isLoadingDiscoveredSshHosts}
            onClick={desktopSshHosts.refresh}
          >
            {isLoadingDiscoveredSshHosts ? (
              <RefreshCwIcon className="size-3 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-3" />
            )}
            Refresh
          </Button>
        </div>
        <ScrollArea scrollFade className="max-h-56">
          <div>
            {unsavedDiscoveredSshHosts.map((target) => (
              <DesktopSshHostRow
                key={`${target.alias}:${target.hostname}:${target.port ?? ''}`}
                target={target}
                connectingHostAlias={connectingSshHostAlias}
                onConnect={(nextTarget) => void handleConnectSshHost(nextTarget)}
              />
            ))}
            {hasLoadedDiscoveredSshHosts &&
            !isLoadingDiscoveredSshHosts &&
            unsavedDiscoveredSshHosts.length === 0 ? (
              <div className={ITEM_ROW_CLASSNAME}>
                <p className="text-xs text-muted-foreground">No new SSH hosts were discovered.</p>
              </div>
            ) : null}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
  const renderNetworkAccessToggle = () => (
    <Switch
      checked={desktopServerExposureState?.mode === 'network-accessible'}
      disabled={!desktopServerExposureState || isUpdatingDesktopServerExposure}
      onCheckedChange={(checked) =>
      {
        setPendingDesktopServerExposureMode(checked ? 'network-accessible' : 'local-only')
        setIsDesktopServerExposureDialogOpen(true)
      }}
      aria-label="Enable network access"
    />
  )
  const renderEndpointRows = (presentation: AccessSectionPresentation) =>
    isAdvertisedEndpointListExpanded
      ? visibleDesktopNetworkAdvertisedEndpoints.map((endpoint) =>
        {
          const endpointKey = endpointDefaultPreferenceKey(endpoint)
          return (
            <AdvertisedEndpointListRow
              key={endpoint.id}
              endpoint={endpoint}
              isDefault={endpointKey === defaultDesktopAdvertisedEndpointKey}
              presentation={presentation}
              onSetDefault={handleSetDefaultAdvertisedEndpoint}
              onSetupTailscaleServe={handleStartTailscaleServeSetup}
              onDisableTailscaleServe={handleStartTailscaleServeDisable}
              isUpdatingTailscaleServe={isUpdatingTailscaleServe}
            />
          )
        })
      : null
  // apply a setting change immediately. The orchestrator reconciles the
  // pool in the background and the primary backend is untouched, so we
  // don't gate this behind a confirmation dialog. After the desktop
  // side persists the change and nudges its orchestrator, we trigger
  // the renderer's reconciler so the WSL backend's saved-env-shaped
  // entry catches up (registers/unregisters) without a reload.
  const applyWslSettingChange = useCallback(
    async (apply: () => Promise<DesktopWslState>) =>
    {
      if (!desktopBridge) return
      setIsUpdatingWslBackend(true)
      setDesktopWslMutationError(null)
      try
      {
        await apply()
        refreshDesktopWslState()
        // the connection platform source polls the desktop bootstrap list and
        // reconciles the environment catalog automatically, so toggling the WSL
        // backend on/off or switching distros is picked up here without an
        // explicit renderer reconcile.
      }
      catch (error)
      {
        const message = error instanceof Error ? error.message : 'Failed to update WSL backend.'
        setDesktopWslMutationError(message)
        toastManager.add(
          stackedThreadToast({
            type: 'error',
            title: 'Could not change WSL backend',
            description: message,
          }),
        )
        refreshDesktopWslState()
      }
      finally
      {
        setIsUpdatingWslBackend(false)
      }
    },
    [desktopBridge],
  )

  // reload the keep-alive WSL state atom. Clearing the mutation error before
  // refresh lets the atom-owned load error become the visible retry state.
  const loadWslState = useCallback(() =>
  {
    setDesktopWslMutationError(null)
    refreshDesktopWslState()
  }, [])

  // true when a desktop-local WSL backend is currently registered as an
  // environment on this machine. We use this as a proxy for "the user has work
  // that lives on the WSL side": if WSL has connected in a way that registered
  // the env, disabling or switching distros could disrupt open threads/projects.
  // if WSL never connected (fresh install, toggled on then immediately off,
  // etc.) there's no local environment, so we skip the confirmation dialog.
  const hasWslRegistrationToLose = useMemo(() =>
  {
    return environments.some((environment) =>
      isDesktopLocalConnectionTarget(environment.entry.target),
    )
  }, [environments])

  // single picker for "WSL backend off" vs "running on distro X". The
  // dropdown maps "Off" to disable and any distro entry to enable +
  // run on that distro. Splitting these into a separate switch and
  // dropdown was confusing — they're the same decision.
  const handleSelectWslMode = useCallback(
    (value: string) =>
    {
      if (!desktopBridge || !desktopWslState) return
      const defaultDistroName =
        desktopWslState.distros.find((distro) => distro.isDefault)?.name ?? null
      if (value === BACKEND_VALUE_WSL_OFF)
      {
        // match the recovery row's visibility (`enabled || wslOnly`): when WSL
        // went unavailable while wsl-only was persisted, `enabled` can be false
        // while `wslOnly` is true, and the "Switch to Windows" button must
        // still clear that state instead of silently no-op'ing.
        if (!desktopWslState.enabled && !desktopWslState.wslOnly) return
        const wasWslOnly = desktopWslState.wslOnly
        // confirm when there's WSL state to lose, OR when wsl-only is
        // on (turning the only running backend off needs to switch
        // back to Windows and restart — always consequential).
        if (hasWslRegistrationToLose || wasWslOnly)
        {
          setPendingWslChange({ kind: 'disable', wasWslOnly })
          return
        }
        void applyWslSettingChange(() => desktopBridge.setWslBackendEnabled(false))
        return
      }
      const nextDistro = value === BACKEND_VALUE_DEFAULT_WSL ? null : value
      const resolvedNext = nextDistro ?? defaultDistroName
      if (!desktopWslState.enabled)
      {
        // was off, user picked a distro: ask whether to run both
        // backends or only WSL. We always ask here so the user picks
        // the mode upfront instead of having to discover the wsl-only
        // switch afterwards.
        setPendingWslChange({ kind: 'enable', nextDistro })
        return
      }
      // already enabled — treat as a distro switch. Skip the change if
      // the user re-picked the row that's already selected.
      const resolvedCurrent = desktopWslState.distro ?? defaultDistroName
      if (resolvedCurrent === resolvedNext) return
      // confirm when there's WSL registration to lose, OR in wsl-only mode:
      // there the primary IS the WSL backend, so a distro change relaunches
      // the app (the IPC handler does this) rather than swapping a secondary,
      // and the user should see that coming.
      if (hasWslRegistrationToLose || desktopWslState.wslOnly)
      {
        setPendingWslChange({ kind: 'distro', nextDistro })
        return
      }
      void applyWslSettingChange(() => desktopBridge.setWslDistro(nextDistro))
    },
    [applyWslSettingChange, desktopBridge, desktopWslState, hasWslRegistrationToLose],
  )

  // dispatched from the enable modal's two action buttons.
  const handleConfirmEnableWsl = useCallback(
    (mode: 'both' | 'wsl-only') =>
    {
      if (!desktopBridge || !pendingWslChange || pendingWslChange.kind !== 'enable') return
      const nextDistro = pendingWslChange.nextDistro
      setPendingWslChange(null)
      const persistedDistro = desktopWslState?.distro ?? null
      void applyWslSettingChange(() =>
        applyWslEnableSelection({
          bridge: desktopBridge,
          mode,
          nextDistro,
          persistedDistro,
        }),
      )
    },
    [applyWslSettingChange, desktopBridge, desktopWslState, pendingWslChange],
  )

  const handleToggleWslOnly = useCallback(
    (enabled: boolean) =>
    {
      if (!desktopBridge || !desktopWslState || desktopWslState.wslOnly === enabled) return
      // wsl-only changes which backend the pool uses as "primary",
      // which is decided once at app launch. The desktop side persists
      // the setting immediately but doesn't tear down or restart
      // anything itself; the renderer warns the user to expect a
      // restart and (in a follow-up) can trigger it automatically.
      // always prompt — even enabling is consequential here.
      setPendingWslChange({ kind: 'wsl-only', nextValue: enabled })
    },
    [desktopBridge, desktopWslState],
  )

  const handleConfirmWslChange = useCallback(() =>
  {
    if (!desktopBridge || !pendingWslChange) return
    const change = pendingWslChange
    // the enable kind resolves through handleConfirmEnableWsl, not
    // this single Confirm path.
    if (change.kind === 'enable') return
    setPendingWslChange(null)
    if (change.kind === 'disable')
    {
      void applyWslSettingChange(async () =>
      {
        const next = await desktopBridge.setWslBackendEnabled(false)
        if (change.wasWslOnly)
        {
          // clearing wsl-only relaunches onto the Windows backend.
          return await desktopBridge.setWslOnly(false)
        }
        return next
      })
      return
    }
    if (change.kind === 'distro')
    {
      void applyWslSettingChange(() => desktopBridge.setWslDistro(change.nextDistro))
      return
    }
    void applyWslSettingChange(() => desktopBridge.setWslOnly(change.nextValue))
  }, [applyWslSettingChange, desktopBridge, pendingWslChange])

  const renderWslRow = () =>
  {
    if (!desktopWslState)
    {
      // a load failed: keep a recovery row (with retry) visible instead of
      // silently hiding the section. The error persists across an in-flight
      // retry so the row doesn't flicker away, and the button reflects the
      // loading state. With no error we simply haven't loaded yet (or WSL
      // management isn't available), so render nothing.
      if (desktopWslError && canManageLocalBackend)
      {
        return (
          <SettingsRow
            title="WSL backend"
            description="Couldn't load the WSL backend state."
            status={<span className="block text-destructive">{desktopWslError}</span>}
            control={
              <Button
                size="xs"
                variant="outline"
                onClick={loadWslState}
                disabled={isLoadingWslState}
              >
                {isLoadingWslState ? 'Retrying…' : 'Retry'}
              </Button>
            }
          />
        )
      }
      return null
    }
    // WSL went unavailable while the user still has the WSL backend persisted
    // (it may have been uninstalled or its distro removed). The desktop side
    // falls back to the Windows backend, but the normal distro picker needs a
    // live distro list it no longer has. Without a control here the user would
    // be stranded on a WSL preference they can't clear, so render a recovery
    // row that switches back to Windows. When WSL is unavailable AND unused,
    // there's nothing to recover — keep the section hidden as before.
    if (!desktopWslState.available)
    {
      if (!desktopWslState.enabled && !desktopWslState.wslOnly) return null
      return (
        <SettingsRow
          title="WSL backend"
          description="WSL is no longer available, so the Windows backend is running instead. Switch off the WSL backend to clear this preference."
          status={
            desktopWslError ? (
              <span className="block text-destructive">{desktopWslError}</span>
            ) : null
          }
          control={
            <Button
              variant="outline"
              disabled={isUpdatingWslBackend}
              onClick={() => handleSelectWslMode(BACKEND_VALUE_WSL_OFF)}
            >
              Switch to Windows
            </Button>
          }
        />
      )
    }
    // distro is null when the user wants the WSL default. Map it to the
    // real default's name so the Select highlights a real option; fall
    // back to the sentinel only when no distros are listed yet (the
    // dropdown then renders a single placeholder that matches).
    const defaultDistroName =
      desktopWslState.distros.find((distro) => distro.isDefault)?.name ?? null
    const selectValue = !desktopWslState.enabled
      ? BACKEND_VALUE_WSL_OFF
      : (desktopWslState.distro ?? defaultDistroName ?? BACKEND_VALUE_DEFAULT_WSL)
    const selectLabel =
      selectValue === BACKEND_VALUE_WSL_OFF
        ? 'Off'
        : selectValue === BACKEND_VALUE_DEFAULT_WSL
          ? 'Default distro'
          : selectValue
    return (
      <>
        <SettingsRow
          title="WSL backend"
          description="Run a second backend inside a WSL distro alongside the Windows one. Pick a distro to start it; pick Off to stop it. Projects opened against the WSL backend live on the Linux side; Windows projects stay where they are."
          status={
            desktopWslError ? (
              <span className="block text-destructive">{desktopWslError}</span>
            ) : desktopWslState.preflightError ? (
              <span className="block text-destructive">
                WSL backend couldn't start: {desktopWslState.preflightError}
              </span>
            ) : null
          }
          control={
            <Select
              value={selectValue}
              onValueChange={(value) =>
              {
                if (typeof value !== 'string') return
                handleSelectWslMode(value)
              }}
            >
              <SelectTrigger
                className="w-full sm:w-56"
                aria-label="WSL backend"
                disabled={isUpdatingWslBackend}
              >
                <SelectValue>{selectLabel}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value={BACKEND_VALUE_WSL_OFF}>
                  Off
                </SelectItem>
                {desktopWslState.distros.length === 0 ? (
                  <SelectItem hideIndicator value={BACKEND_VALUE_DEFAULT_WSL}>
                    Default distro
                  </SelectItem>
                ) : (
                  desktopWslState.distros.map((distro) => (
                    <SelectItem hideIndicator key={distro.name} value={distro.name}>
                      {distro.name}
                      {distro.isDefault ? ' (default)' : ''}
                    </SelectItem>
                  ))
                )}
              </SelectPopup>
            </Select>
          }
        />
        {desktopWslState.enabled ? (
          <SettingsRow
            title="WSL only"
            description="Stop the Windows backend and run only the WSL backend. Useful if you develop entirely inside WSL and don't want a second backend process. 456code restarts when you change this."
            className="bg-muted/20 pl-7 sm:pl-8"
            control={
              <Switch
                checked={desktopWslState.wslOnly}
                disabled={isUpdatingWslBackend}
                onCheckedChange={(checked) => handleToggleWslOnly(checked)}
                aria-label="Run WSL only"
              />
            }
          />
        ) : null}
      </>
    )
  }

  const renderTailscaleRow = () => (
    <SettingsRow
      title="Tailscale HTTPS"
      description={
        tailscaleHttpsEndpoint
          ? tailscaleHttpsEndpoint.status === 'available'
            ? tailscaleHttpsEndpoint.httpBaseUrl
            : 'Use Tailscale Serve to expose this backend through a MagicDNS HTTPS URL.'
          : 'Start Tailscale to set up HTTPS access through MagicDNS.'
      }
      control={
        tailscaleHttpsEndpoint ? (
          <Switch
            checked={tailscaleHttpsEndpoint.status === 'available'}
            disabled={isUpdatingTailscaleServe}
            onCheckedChange={(checked) =>
              {
              if (checked)
                {
                handleStartTailscaleServeSetup(tailscaleHttpsEndpoint)
                return
              }
              handleStartTailscaleServeDisable(tailscaleHttpsEndpoint)
            }}
            aria-label="Enable Tailscale HTTPS"
          />
        ) : null
      }
    />
  )
  const renderAuthorizedClients = (presentation: AccessSectionPresentation) => (
    <>
      {desktopAccessManagementError ? (
        <div className={accessRowClassName(presentation)}>
          <p className="text-xs text-destructive">{desktopAccessManagementError}</p>
        </div>
      ) : null}
      <PairingClientsList
        endpointUrl={desktopServerExposureState?.endpointUrl}
        endpoints={visibleDesktopAdvertisedEndpoints}
        defaultEndpointKey={defaultDesktopAdvertisedEndpointKey}
        presentation={presentation}
        isLoading={isLoadingDesktopAccessManagement}
        pairingLinks={visibleDesktopPairingLinks}
        clientSessions={desktopClientSessions}
        revokingPairingLinkId={revokingDesktopPairingLinkId}
        revokingClientSessionId={revokingDesktopClientSessionId}
        onRevokePairingLink={handleRevokeDesktopPairingLink}
        onRevokeClientSession={handleRevokeDesktopClientSession}
      />
    </>
  )
  const renderNetworkAccessRow = () => (
    <SettingsRow
      title="Network access"
      description={
        isLocalBackendNetworkAccessible ? (
          <NetworkAccessDescription
            endpoint={defaultDesktopNetworkAdvertisedEndpoint}
            hiddenEndpointCount={Math.max(visibleDesktopNetworkAdvertisedEndpoints.length - 1, 0)}
            expanded={isAdvertisedEndpointListExpanded}
            onToggleExpanded={() => setIsAdvertisedEndpointListExpanded((expanded) => !expanded)}
            fallback={
              desktopServerExposureState?.endpointUrl
                ? `Reachable at ${desktopServerExposureState.endpointUrl}`
                : desktopServerExposureState?.advertisedHost
                  ? `Exposed on all interfaces. Pairing links use ${desktopServerExposureState.advertisedHost}.`
                  : 'Exposed on all interfaces.'
            }
          />
        ) : desktopServerExposureState ? (
          'Limited to this machine.'
        ) : (
          'Loading…'
        )
      }
      status={
        desktopServerExposureError ? (
          <span className="block text-destructive">{desktopServerExposureError}</span>
        ) : null
      }
      control={renderNetworkAccessToggle()}
    />
  )
  const renderDisabledNetworkAccessRow = () => (
    <SettingsRow
      title="Network access"
      description={
        currentAuthPolicy === 'remote-reachable'
          ? 'This backend is already configured for remote access. Network exposure changes must be made where the server is launched.'
          : 'This backend is only reachable on this machine. Restart it with a non-loopback host to enable remote pairing.'
      }
      control={
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="inline-flex">
                <Switch
                  checked={isLocalBackendNetworkAccessible}
                  disabled
                  aria-label="Enable network access"
                />
              </span>
            }
          />
          <TooltipPopup side="top">
            Network exposure changes restart the backend and must be controlled where the server
            process is launched.
          </TooltipPopup>
        </Tooltip>
      }
    />
  )

  return (
    <SettingsPageContainer>
      {canManageLocalBackend ? (
        <>
          <SettingsSection id="settings-connections-this-environment" title="This environment">
            {primaryVersionMismatch ? (
              <SettingsRow
                title="Version drift"
                description={
                  <span className="flex items-center gap-1 text-warning">
                    <TriangleAlertIcon className="size-3.5 shrink-0" />
                    Client {primaryVersionMismatch.clientVersion}, server{' '}
                    {primaryVersionMismatch.serverVersion}. Sync them if RPC calls or reconnects
                    fail.
                  </span>
                }
                control={
                  primaryEnvironmentId !== null ? (
                    <ServerUpdateAction
                      environmentId={primaryEnvironmentId}
                      serverLabel={primaryEnvironment?.label ?? 'this server'}
                      selfUpdate={resolveServerSelfUpdateCapability(primaryServerConfig)}
                      targetVersion={primaryVersionMismatch.clientVersion}
                    />
                  ) : undefined
                }
              />
            ) : null}
            {desktopBridge ? (
              <>
                {renderNetworkAccessRow()}
                {renderEndpointRows('endpoint-rail')}
                {renderTailscaleRow()}
                {renderWslRow()}
              </>
            ) : (
              renderDisabledNetworkAccessRow()
            )}
          </SettingsSection>

          {isLocalBackendRemotelyReachable ? (
            <SettingsSection
              id="settings-connections-authorized-clients"
              title="Authorized clients"
              headerAction={
                <AuthorizedClientsHeaderAction
                  clientSessions={desktopClientSessions}
                  isRevokingOtherClients={isRevokingOtherDesktopClients}
                  onRevokeOtherClients={handleRevokeOtherDesktopClients}
                />
              }
            >
              <ScrollArea
                scrollFade
                className="max-h-[22.5rem]"
                data-testid="authorized-clients-scroll-area"
              >
                {renderAuthorizedClients('current')}
              </ScrollArea>
            </SettingsSection>
          ) : null}
          <AlertDialog
            open={isDesktopServerExposureDialogOpen}
            onOpenChange={(open) =>
              {
              if (isUpdatingDesktopServerExposure) return
              setIsDesktopServerExposureDialogOpen(open)
            }}
            onOpenChangeComplete={(open) =>
              {
              if (!open) setPendingDesktopServerExposureMode(null)
            }}
          >
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {pendingDesktopServerExposureMode === 'network-accessible'
                    ? 'Enable network access?'
                    : 'Disable network access?'}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {pendingDesktopServerExposureMode === 'network-accessible'
                    ? '456code will restart to expose this environment over the network.'
                    : '456code will restart and limit this environment back to this machine.'}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose
                  disabled={isUpdatingDesktopServerExposure}
                  render={<Button variant="outline" disabled={isUpdatingDesktopServerExposure} />}
                >
                  Cancel
                </AlertDialogClose>
                <Button
                  variant={
                    pendingDesktopServerExposureMode === 'local-only' ? 'destructive' : 'default'
                  }
                  onClick={handleConfirmDesktopServerExposureChange}
                  disabled={
                    pendingDesktopServerExposureMode === null || isUpdatingDesktopServerExposure
                  }
                >
                  {isUpdatingDesktopServerExposure ? (
                    <>
                      <Spinner className="size-3.5" />
                      Restarting…
                    </>
                  ) : pendingDesktopServerExposureMode === 'network-accessible' ? (
                    'Restart and enable'
                  ) : (
                    'Restart and disable'
                  )}
                </Button>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
          <AlertDialog
            open={isWslConfirmDialogOpen}
            onOpenChange={(open) =>
              {
              if (isUpdatingWslBackend) return
              if (!open) setPendingWslChange(null)
            }}
          >
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {pendingWslChange?.kind === 'disable'
                    ? pendingWslChange.wasWslOnly
                      ? 'Turn off WSL and switch back to Windows?'
                      : 'Disable WSL backend?'
                    : pendingWslChange?.kind === 'distro'
                      ? 'Switch WSL distro?'
                      : pendingWslChange?.kind === 'enable'
                        ? 'Start the WSL backend'
                        : pendingWslChange?.nextValue
                          ? 'Run only the WSL backend?'
                          : 'Re-enable the Windows backend?'}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {pendingWslChange?.kind === 'disable'
                    ? pendingWslChange.wasWslOnly
                      ? '456code will restart on the Windows backend. Threads and projects opened against WSL stay safe inside the distro and become available again when you re-enable WSL.'
                      : "The WSL backend will stop. Threads and projects opened against WSL stay safe inside the distro, but they'll be unavailable in 456code until you re-enable WSL."
                    : pendingWslChange?.kind === 'distro'
                      ? '456code will restart the WSL backend on the new distro. Sessions still running on the current distro will be interrupted.'
                      : pendingWslChange?.kind === 'enable'
                        ? 'Run the WSL backend alongside the Windows one, or stop the Windows backend and use only WSL? You can change this later from Settings.'
                        : pendingWslChange?.nextValue
                          ? "456code will restart and start only the WSL backend. Your Windows-side projects won't be accessible until you turn this off again."
                          : '456code will restart and bring the Windows backend back up alongside WSL.'}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose
                  disabled={isUpdatingWslBackend}
                  render={<Button variant="outline" disabled={isUpdatingWslBackend} />}
                >
                  Cancel
                </AlertDialogClose>
                {pendingWslChange?.kind === 'enable' ? (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => handleConfirmEnableWsl('wsl-only')}
                      disabled={isUpdatingWslBackend}
                    >
                      {isUpdatingWslBackend ? (
                        <>
                          <Spinner className="size-3.5" />
                          Applying…
                        </>
                      ) : (
                        'Use only WSL'
                      )}
                    </Button>
                    <Button
                      variant="default"
                      onClick={() => handleConfirmEnableWsl('both')}
                      disabled={isUpdatingWslBackend}
                    >
                      {isUpdatingWslBackend ? (
                        <>
                          <Spinner className="size-3.5" />
                          Applying…
                        </>
                      ) : (
                        'Run both backends'
                      )}
                    </Button>
                  </>
                ) : (
                  <Button
                    variant={
                      pendingWslChange?.kind === 'disable' ||
                      (pendingWslChange?.kind === 'wsl-only' && pendingWslChange.nextValue)
                        ? 'destructive'
                        : 'default'
                    }
                    onClick={handleConfirmWslChange}
                    disabled={isUpdatingWslBackend}
                  >
                    {isUpdatingWslBackend ? (
                      <>
                        <Spinner className="size-3.5" />
                        Applying…
                      </>
                    ) : pendingWslChange?.kind === 'disable' ? (
                      pendingWslChange.wasWslOnly ? (
                        'Switch to Windows'
                      ) : (
                        'Disable WSL'
                      )
                    ) : pendingWslChange?.kind === 'distro' ? (
                      'Switch distro'
                    ) : pendingWslChange?.nextValue ? (
                      'Restart and enable'
                    ) : (
                      'Restart and disable'
                    )}
                  </Button>
                )}
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
          <AlertDialog
            open={disableTailscaleServeDialogOpen}
            onOpenChange={(open) =>
              {
              if (isUpdatingTailscaleServe) return
              setDisableTailscaleServeDialogOpen(open)
            }}
          >
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>Disable Tailscale HTTPS?</AlertDialogTitle>
                <AlertDialogDescription>
                  456code will restart the local backend without Tailscale Serve.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose
                  disabled={isUpdatingTailscaleServe}
                  render={<Button variant="outline" disabled={isUpdatingTailscaleServe} />}
                >
                  Cancel
                </AlertDialogClose>
                <Button
                  variant="destructive"
                  onClick={() => void handleConfirmTailscaleServeDisable()}
                  disabled={isUpdatingTailscaleServe}
                >
                  {isUpdatingTailscaleServe ? (
                    <>
                      <Spinner className="size-3.5" />
                      Restarting…
                    </>
                  ) : (
                    'Restart and disable'
                  )}
                </Button>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
          <Dialog
            open={pendingTailscaleServeEndpoint !== null}
            onOpenChange={(open) =>
              {
              if (isUpdatingTailscaleServe) return
              if (!open) setPendingTailscaleServeEndpoint(null)
            }}
          >
            <DialogPopup className="max-w-md">
              <DialogHeader>
                <DialogTitle>Set up Tailscale HTTPS?</DialogTitle>
                <DialogDescription>
                  456code will restart the local backend with Tailscale Serve enabled and ask
                  Tailscale to proxy HTTPS traffic to this backend.
                </DialogDescription>
              </DialogHeader>
              <DialogPanel className="space-y-4">
                <label className="block">
                  <span className="text-sm font-medium text-foreground">HTTPS port</span>
                  <Input
                    className="mt-2"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={65_535}
                    step={1}
                    value={tailscaleServePortInput}
                    onChange={(event) => setTailscaleServePortInput(event.target.value)}
                    disabled={isUpdatingTailscaleServe}
                  />
                </label>
                {!isTailscaleServePortValid ? (
                  <p className="mt-2 text-xs text-destructive">Enter a port from 1 to 65535.</p>
                ) : null}
                <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-2">
                  <p className="text-xs font-medium text-muted-foreground">HTTPS endpoint</p>
                  <p
                    className="mt-1 truncate text-sm text-foreground"
                    title={pendingTailscaleServeBaseUrl ?? undefined}
                  >
                    {pendingTailscaleServeBaseUrl ?? 'Pending MagicDNS endpoint'}
                  </p>
                </div>
              </DialogPanel>
              <DialogFooter>
                <DialogClose
                  disabled={isUpdatingTailscaleServe}
                  render={<Button variant="outline" disabled={isUpdatingTailscaleServe} />}
                >
                  Cancel
                </DialogClose>
                <Button
                  onClick={() => void handleConfirmTailscaleServeSetup()}
                  disabled={isUpdatingTailscaleServe || !isTailscaleServePortValid}
                >
                  {isUpdatingTailscaleServe ? (
                    <>
                      <Spinner className="size-3.5" />
                      Restarting…
                    </>
                  ) : (
                    'Enable'
                  )}
                </Button>
              </DialogFooter>
            </DialogPopup>
          </Dialog>
        </>
      ) : (
        <SettingsSection id="settings-connections-this-environment" title="This environment">
          <SettingsRow
            title="Administrative access"
            description="Pairing links and client-session management require the access:write scope for this backend."
          />
        </SettingsSection>
      )}

      <SettingsSection
        id="settings-connections-remote-environments"
        title="Remote environments"
        headerAction={
          <Dialog
            open={addBackendDialogOpen}
            onOpenChange={(open) =>
            {
              setAddBackendDialogOpen(open)
              if (!open)
              {
                setSavedBackendError(null)
              }
            }}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <DialogTrigger
                    render={
                      <Button
                        size="xs"
                        variant="ghost"
                        className="h-5 gap-1 rounded-sm px-1 text-[11px] font-normal text-muted-foreground/60 hover:text-muted-foreground"
                        aria-label="Add environment"
                      >
                        <PlusIcon className="size-3" />
                        <span>Add environment</span>
                      </Button>
                    }
                  />
                }
              />
              <TooltipPopup side="top">Add environment</TooltipPopup>
            </Tooltip>
            <DialogPopup className="max-h-[80dvh] sm:max-w-3xl">
              <DialogHeader>
                <DialogTitle>Add Environment</DialogTitle>
                <DialogDescription>Pair another environment to this client.</DialogDescription>
              </DialogHeader>
              <DialogPanel>
                <div className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    {renderConnectionModeCard({
                      mode: 'remote',
                      title: 'Remote link',
                      description: 'Enter a backend host and pairing code.',
                      icon: <ChevronsLeftRightEllipsisIcon aria-hidden className="size-4" />,
                    })}
                    {desktopBridge
                      ? renderConnectionModeCard({
                          mode: 'ssh',
                          title: 'SSH',
                          description: 'Use local SSH config, agent, and tunnels for the backend.',
                          icon: <TerminalIcon aria-hidden className="size-4" />,
                        })
                      : null}
                  </div>
                  <AnimatedHeight>
                    {savedBackendMode === 'ssh' ? renderSshFields() : renderRemoteModeBody()}
                  </AnimatedHeight>
                </div>
              </DialogPanel>
            </DialogPopup>
          </Dialog>
        }
      >
        {savedEnvironments.map((environment) => (
          <SavedBackendListRow
            key={environment.environmentId}
            environment={environment}
            removingEnvironmentId={removingSavedEnvironmentId}
            onConnect={handleConnectSavedBackend}
            onRemove={handleRemoveSavedBackend}
          />
        ))}
        {savedEnvironments.length === 0 ? <EmptyRemoteEnvironments /> : null}
      </SettingsSection>
    </SettingsPageContainer>
  )
}
