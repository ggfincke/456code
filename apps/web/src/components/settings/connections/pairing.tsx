// apps/web/src/components/settings/connections/pairing.tsx
// pairing link and authorized-client rows for connections settings

import {
  AuthAccessWriteScope,
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
  type AuthClientSession,
  type AuthEnvironmentScope,
  type AuthPairingCredentialResult,
  type AuthPairingLink,
  type AdvertisedEndpoint,
} from '@t3tools/contracts'
import * as DateTime from 'effect/DateTime'
import { ChevronDownIcon, PlusIcon, QrCodeIcon } from 'lucide-react'
import { memo, useCallback, useMemo, useState, type ReactNode } from 'react'

import { useCopyToClipboard } from '../../../hooks/useCopyToClipboard'
import { formatElapsedDurationLabel, formatExpiresInLabel } from '../../../timestampFormat'
import {
  createServerPairingCredential,
  isLoopbackHostname,
  type ServerClientSessionRecord,
  type ServerPairingLinkRecord,
} from '~/environments/primary'
import { ConnectionStatusDot } from '../../ConnectionStatusDot'
import { resolveDesktopPairingUrl, resolveHostedPairingUrl } from '../pairingUrls'
import { useRelativeTimeTick, SettingsRow } from '../settingsLayout'
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from '../itemRows'
import { Input } from '../../ui/input'
import { Checkbox } from '../../ui/checkbox'
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
} from '../../ui/dialog'
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '../../ui/alert-dialog'
import { Group, GroupSeparator } from '../../ui/group'
import { Popover, PopoverPopup, PopoverTrigger } from '../../ui/popover'
import { QRCodeSvg } from '../../ui/qr-code'
import { Button } from '../../ui/button'
import { stackedThreadToast, toastManager } from '../../ui/toast'
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from '../../ui/menu'
import { Textarea } from '../../ui/textarea'
import {
  AccessScopeSummary,
  PAIRING_SCOPE_OPTIONS,
  accessRowClassName,
  formatAccessTimestamp,
  type AccessSectionPresentation,
} from './accessPresentation'
import {
  endpointDefaultPreferenceKey,
  isHostedAppPairingUrl,
  resolveAdvertisedEndpointPairingUrl,
  resolveCurrentOriginPairingUrl,
  selectPairingEndpoint,
} from './endpointUrls'

export function sortDesktopPairingLinks(links: ReadonlyArray<ServerPairingLinkRecord>)
{
  return [...links].toSorted(
    (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  )
}

export function sortDesktopClientSessions(sessions: ReadonlyArray<ServerClientSessionRecord>)
{
  return [...sessions].toSorted((left, right) =>
  {
    if (left.current !== right.current)
    {
      return left.current ? -1 : 1
    }
    if (left.connected !== right.connected)
    {
      return left.connected ? -1 : 1
    }
    return new Date(right.issuedAt).getTime() - new Date(left.issuedAt).getTime()
  })
}

export function toDesktopPairingLinkRecord(pairingLink: AuthPairingLink): ServerPairingLinkRecord
{
  return {
    ...pairingLink,
    createdAt: DateTime.formatIso(pairingLink.createdAt),
    expiresAt: DateTime.formatIso(pairingLink.expiresAt),
  }
}

export function toDesktopClientSessionRecord(
  clientSession: AuthClientSession,
): ServerClientSessionRecord
{
  return {
    ...clientSession,
    issuedAt: DateTime.formatIso(clientSession.issuedAt),
    expiresAt: DateTime.formatIso(clientSession.expiresAt),
    lastConnectedAt:
      clientSession.lastConnectedAt === null
        ? null
        : DateTime.formatIso(clientSession.lastConnectedAt),
  }
}

type PairingLinkListRowProps = {
  pairingLink: ServerPairingLinkRecord
  credential: string | undefined
  endpointUrl: string | null | undefined
  endpoints: ReadonlyArray<AdvertisedEndpoint>
  defaultEndpointKey: string | null
  presentation?: AccessSectionPresentation
  revokingPairingLinkId: string | null
  onRevoke: (id: string) => void
}

export const PairingLinkListRow = memo(function PairingLinkListRow({
  pairingLink,
  credential,
  endpointUrl,
  endpoints,
  defaultEndpointKey,
  presentation = 'current',
  revokingPairingLinkId,
  onRevoke,
}: PairingLinkListRowProps)
{
  const nowMs = useRelativeTimeTick(1_000)
  const expiresAtMs = useMemo(
    () => new Date(pairingLink.expiresAt).getTime(),
    [pairingLink.expiresAt],
  )
  const [isRevealDialogOpen, setIsRevealDialogOpen] = useState(false)

  const currentOriginPairingUrl = useMemo(
    () => (credential ? resolveCurrentOriginPairingUrl(credential) : null),
    [credential],
  )
  const hostedPairingUrl = useMemo(
    () =>
      credential && endpointUrl != null && endpointUrl !== ''
        ? resolveHostedPairingUrl(endpointUrl, credential)
        : null,
    [credential, endpointUrl],
  )
  const endpointPairingUrl = useMemo(() =>
  {
    const endpoint = selectPairingEndpoint(endpoints, defaultEndpointKey)
    return endpoint && credential ? resolveAdvertisedEndpointPairingUrl(endpoint, credential) : null
  }, [credential, defaultEndpointKey, endpoints])
  const endpointCopyOptions = useMemo(() =>
  {
    const options: Array<{
      readonly key: string
      readonly label: string
      readonly url: string
      readonly detail: string
    }> = []
    if (!credential) return options
    for (const endpoint of endpoints)
    {
      if (endpoint.status === 'unavailable')
      {
        continue
      }
      const url = resolveAdvertisedEndpointPairingUrl(endpoint, credential)
      options.push({
        key: endpointDefaultPreferenceKey(endpoint),
        label: endpoint.label,
        url,
        detail: isHostedAppPairingUrl(url) ? 'Hosted app link' : 'Backend pairing URL',
      })
    }
    return options
  }, [credential, endpoints])
  const shareablePairingUrl =
    endpointPairingUrl ??
    (credential && endpointUrl != null && endpointUrl !== ''
      ? (hostedPairingUrl ?? resolveDesktopPairingUrl(endpointUrl, credential))
      : isLoopbackHostname(window.location.hostname)
        ? null
        : currentOriginPairingUrl)
  const revealValue = shareablePairingUrl ?? credential ?? ''
  const isShareableHostedAppPairingUrl =
    shareablePairingUrl !== null && isHostedAppPairingUrl(shareablePairingUrl)
  const canCopyToClipboard =
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    navigator.clipboard?.writeText != null

  const { copyToClipboard } = useCopyToClipboard<'code' | 'hosted-link' | 'link'>({
    onCopy: (kind) =>
    {
      toastManager.add({
        type: 'success',
        title:
          kind === 'hosted-link'
            ? 'Hosted app link copied'
            : kind === 'link'
              ? 'Pairing URL copied'
              : 'Pairing code copied',
        description:
          kind === 'hosted-link'
            ? 'Open it in the browser on the device you want to connect.'
            : kind === 'link'
              ? 'Open it in the client you want to pair to this environment.'
              : 'Paste it into another client to finish pairing.',
      })
    },
    onError: (error, kind) =>
    {
      setIsRevealDialogOpen(true)
      toastManager.add(
        stackedThreadToast({
          type: 'error',
          title: canCopyToClipboard
            ? kind === 'hosted-link'
              ? 'Could not copy hosted app link'
              : kind === 'link'
                ? 'Could not copy pairing URL'
                : 'Could not copy pairing code'
            : 'Clipboard copy unavailable',
          description: canCopyToClipboard ? error.message : 'Showing the full value instead.',
        }),
      )
    },
  })

  const copyPairingValue = useCallback(
    (value: string, kind: 'code' | 'hosted-link' | 'link') =>
    {
      copyToClipboard(value, kind)
    },
    [copyToClipboard],
  )

  const copyKindForUrl = useCallback(
    (url: string): 'hosted-link' | 'link' => (isHostedAppPairingUrl(url) ? 'hosted-link' : 'link'),
    [],
  )

  const handleCopyCode = useCallback(() =>
  {
    if (credential) copyPairingValue(credential, 'code')
  }, [copyPairingValue, credential])

  const handleCopyDefaultLink = useCallback(() =>
  {
    if (!shareablePairingUrl) return
    copyPairingValue(shareablePairingUrl, copyKindForUrl(shareablePairingUrl))
  }, [copyKindForUrl, copyPairingValue, shareablePairingUrl])

  const expiresAbsolute = formatAccessTimestamp(pairingLink.expiresAt)

  const primaryLabel = pairingLink.label ?? 'Pairing link'
  const defaultEndpointCopyOption =
    endpointCopyOptions.find((option) => option.key === defaultEndpointKey) ??
    endpointCopyOptions[0] ??
    null
  const defaultEndpointCopyLabel = defaultEndpointCopyOption?.label ?? 'URL'
  const backendEndpointCopyOptions = endpointCopyOptions.filter(
    (option) => !isHostedAppPairingUrl(option.url),
  )
  const hostedEndpointCopyOptions = endpointCopyOptions.filter((option) =>
    isHostedAppPairingUrl(option.url),
  )
  const renderEndpointMenuItems = (
    options: typeof endpointCopyOptions = endpointCopyOptions,
    renderDetail = true,
  ) =>
    options.map((option) => (
      <MenuItem
        key={option.key}
        onClick={() => copyPairingValue(option.url, copyKindForUrl(option.url))}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate">{option.label}</span>
          {renderDetail ? (
            <span className="block truncate text-[11px] text-muted-foreground">
              {option.detail}
            </span>
          ) : null}
        </span>
      </MenuItem>
    ))
  const renderPairingCodeMenuItem = (renderDetail = true) => (
    <MenuItem onClick={handleCopyCode}>
      <span className="min-w-0 flex-1">
        <span className="block truncate">Copy code</span>
        {renderDetail ? (
          <span className="block truncate text-[11px] text-muted-foreground">Token only</span>
        ) : null}
      </span>
    </MenuItem>
  )
  const renderCompactEndpointGroup = (
    label: string,
    options: typeof endpointCopyOptions,
    includeSeparator: boolean,
  ) =>
    options.length > 0 ? (
      <>
        {includeSeparator ? <MenuSeparator /> : null}
        <MenuGroup>
          <MenuGroupLabel>{label}</MenuGroupLabel>
          {renderEndpointMenuItems(options, false)}
        </MenuGroup>
      </>
    ) : null
  const renderGroupedCopyMenuItems = (options?: { codeFirst?: boolean }) => (
    <>
      {options?.codeFirst ? (
        <>
          <MenuGroup>
            <MenuGroupLabel>Pairing code</MenuGroupLabel>
            {renderPairingCodeMenuItem(false)}
          </MenuGroup>
          {endpointCopyOptions.length > 0 ? <MenuSeparator /> : null}
        </>
      ) : null}
      {renderCompactEndpointGroup('Pairing URLs', backendEndpointCopyOptions, false)}
      {renderCompactEndpointGroup(
        'Hosted app link',
        hostedEndpointCopyOptions,
        backendEndpointCopyOptions.length > 0,
      )}
      {!options?.codeFirst ? (
        <>
          {endpointCopyOptions.length > 0 ? <MenuSeparator /> : null}
          <MenuGroup>
            <MenuGroupLabel>Pairing code</MenuGroupLabel>
            {renderPairingCodeMenuItem(false)}
          </MenuGroup>
        </>
      ) : null}
    </>
  )

  if (expiresAtMs <= nowMs)
  {
    return null
  }

  return (
    <div className={accessRowClassName(presentation)}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={`Link created at ${formatAccessTimestamp(pairingLink.createdAt)}`}
              dotClassName="bg-amber-400"
            />
            <h3 className="text-sm font-medium text-foreground">{primaryLabel}</h3>
            <Popover>
              {shareablePairingUrl ? (
                <>
                  <PopoverTrigger
                    openOnHover
                    delay={250}
                    closeDelay={100}
                    render={
                      <button
                        type="button"
                        className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground/50 outline-none hover:text-foreground"
                        aria-label="Show QR code"
                      />
                    }
                  >
                    <QrCodeIcon aria-hidden className="size-3" />
                  </PopoverTrigger>
                  <PopoverPopup side="top" align="start" tooltipStyle className="w-max">
                    <QRCodeSvg
                      value={shareablePairingUrl}
                      size={88}
                      level="M"
                      marginSize={2}
                      title="Pairing link — scan to open on another device"
                    />
                  </PopoverPopup>
                </>
              ) : null}
            </Popover>
          </div>
          <p className="text-xs text-muted-foreground" title={expiresAbsolute}>
            {formatExpiresInLabel(pairingLink.expiresAt, nowMs)}
            <span aria-hidden> · </span>
            <AccessScopeSummary scopes={pairingLink.scopes} label="Pairing link scopes" />
          </p>
          {!credential ? (
            <p className="text-[11px] text-muted-foreground/70">
              Create a new link to share from this client.
            </p>
          ) : shareablePairingUrl === null ? (
            <p className="text-[11px] text-muted-foreground/70">
              Copy the token and pair from another client using this backend&apos;s reachable host.
            </p>
          ) : null}
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          <Dialog
            open={credential !== undefined && isRevealDialogOpen}
            onOpenChange={setIsRevealDialogOpen}
          >
            {!credential ? null : canCopyToClipboard ? (
              <>
                {shareablePairingUrl ? (
                  <Group aria-label="Copy selected endpoint">
                    <Button
                      size="xs"
                      variant="outline"
                      className="max-w-56"
                      title={`Copy pairing URL for: ${defaultEndpointCopyLabel}`}
                      onClick={handleCopyDefaultLink}
                    >
                      <span className="truncate">
                        Copy pairing URL for: {defaultEndpointCopyLabel}
                      </span>
                    </Button>
                    <GroupSeparator />
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            size="icon-xs"
                            variant="outline"
                            aria-label="Choose endpoint to copy"
                          />
                        }
                      >
                        <ChevronDownIcon className="size-3.5" />
                      </MenuTrigger>
                      <MenuPopup align="end" className="min-w-60">
                        {renderGroupedCopyMenuItems()}
                      </MenuPopup>
                    </Menu>
                  </Group>
                ) : (
                  <Button size="xs" variant="outline" onClick={handleCopyCode}>
                    Copy code
                  </Button>
                )}
              </>
            ) : (
              <DialogTrigger render={<Button size="xs" variant="outline" />}>
                {shareablePairingUrl ? 'Show link' : 'Show code'}
              </DialogTrigger>
            )}
            <DialogPopup className="max-w-md">
              <DialogHeader>
                <DialogTitle>
                  {shareablePairingUrl
                    ? isShareableHostedAppPairingUrl
                      ? 'Hosted app pairing link'
                      : 'Pairing link'
                    : 'Pairing code'}
                </DialogTitle>
                <DialogDescription>
                  {shareablePairingUrl
                    ? isShareableHostedAppPairingUrl
                      ? 'Clipboard copy is unavailable here. Open or manually copy this hosted app link on the device you want to connect.'
                      : 'Clipboard copy is unavailable here. Open or manually copy this full pairing URL on the device you want to connect.'
                    : 'Clipboard copy is unavailable here. Manually copy this code into another client.'}
                </DialogDescription>
              </DialogHeader>
              <DialogPanel className="space-y-4">
                <Textarea
                  readOnly
                  value={revealValue}
                  rows={shareablePairingUrl ? 4 : 3}
                  className="text-xs leading-relaxed"
                  onFocus={(event) => event.currentTarget.select()}
                  onClick={(event) => event.currentTarget.select()}
                />
                {shareablePairingUrl ? (
                  <div className="flex justify-center rounded-xl border border-border/60 bg-muted/30 p-4">
                    <QRCodeSvg
                      value={shareablePairingUrl}
                      size={132}
                      level="M"
                      marginSize={2}
                      title="Pairing link — scan to open on another device"
                    />
                  </div>
                ) : null}
              </DialogPanel>
              <DialogFooter variant="bare">
                <Button variant="outline" onClick={() => setIsRevealDialogOpen(false)}>
                  Done
                </Button>
                {canCopyToClipboard ? (
                  <Button variant="outline" size="xs" onClick={handleCopyCode}>
                    Copy code
                  </Button>
                ) : null}
              </DialogFooter>
            </DialogPopup>
          </Dialog>
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={revokingPairingLinkId === pairingLink.id}
            onClick={() => void onRevoke(pairingLink.id)}
          >
            {revokingPairingLinkId === pairingLink.id ? 'Revoking…' : 'Revoke'}
          </Button>
        </div>
      </div>
    </div>
  )
})

type ConnectedClientListRowProps = {
  clientSession: ServerClientSessionRecord
  presentation?: AccessSectionPresentation
  revokingClientSessionId: string | null
  onRevokeSession: (sessionId: ServerClientSessionRecord['sessionId']) => void
}

export const ConnectedClientListRow = memo(function ConnectedClientListRow({
  clientSession,
  presentation = 'current',
  revokingClientSessionId,
  onRevokeSession,
}: ConnectedClientListRowProps)
{
  const nowMs = useRelativeTimeTick(1_000)
  const isLive = clientSession.current || clientSession.connected
  const lastConnectedAt = clientSession.lastConnectedAt
  const statusTooltip = isLive
    ? lastConnectedAt
      ? `Connected for ${formatElapsedDurationLabel(lastConnectedAt, nowMs)}`
      : 'Connected'
    : lastConnectedAt
      ? `Last connected at ${formatAccessTimestamp(lastConnectedAt)}`
      : 'Not connected yet.'
  const deviceInfoBits = [
    clientSession.client.deviceType !== 'unknown'
      ? clientSession.client.deviceType[0]?.toUpperCase() + clientSession.client.deviceType.slice(1)
      : null,
    clientSession.client.os ?? null,
    clientSession.client.browser ?? null,
    clientSession.client.ipAddress ?? null,
  ].filter((value): value is string => value !== null)
  const primaryLabel =
    clientSession.client.label ??
    ([clientSession.client.os, clientSession.client.browser].filter(Boolean).join(' · ') ||
      clientSession.subject)

  return (
    <div className={accessRowClassName(presentation)}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={statusTooltip}
              dotClassName={isLive ? 'bg-success' : 'bg-muted-foreground/30'}
              pingClassName={isLive ? 'bg-success/60 duration-2000' : null}
            />
            <h3 className="text-sm font-medium text-foreground">{primaryLabel}</h3>
            {clientSession.current ? (
              <span className="text-[10px] text-muted-foreground/80 rounded-md border border-border/50 bg-muted/50 px-1 py-0.5">
                This device
              </span>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {deviceInfoBits.length > 0 ? (
              <>
                {deviceInfoBits.join(' · ')}
                <span aria-hidden> · </span>
              </>
            ) : null}
            <AccessScopeSummary scopes={clientSession.scopes} label="Client scopes" />
          </p>
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          {!clientSession.current ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={revokingClientSessionId === clientSession.sessionId}
              onClick={() => void onRevokeSession(clientSession.sessionId)}
            >
              {revokingClientSessionId === clientSession.sessionId ? 'Revoking…' : 'Revoke'}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
})

type AuthorizedClientsHeaderActionProps = {
  onPairingLinkCreated: (result: AuthPairingCredentialResult) => void
  clientSessions: ReadonlyArray<ServerClientSessionRecord>
  isRevokingOtherClients: boolean
  onRevokeOtherClients: () => void
}

export const AuthorizedClientsHeaderAction = memo(function AuthorizedClientsHeaderAction({
  onPairingLinkCreated,
  clientSessions,
  isRevokingOtherClients,
  onRevokeOtherClients,
}: AuthorizedClientsHeaderActionProps)
{
  const [dialogOpen, setDialogOpen] = useState(false)
  const [pairingLabel, setPairingLabel] = useState('')
  const [pairingScopes, setPairingScopes] = useState<ReadonlyArray<AuthEnvironmentScope>>([
    ...AuthStandardClientScopes,
  ])
  const [isCreatingPairingLink, setIsCreatingPairingLink] = useState(false)

  const handleCreatePairingLink = useCallback(async () =>
  {
    setIsCreatingPairingLink(true)
    try
    {
      const created = await createServerPairingCredential({
        label: pairingLabel,
        scopes: pairingScopes,
      })
      onPairingLinkCreated(created)
      setPairingLabel('')
      setPairingScopes([...AuthStandardClientScopes])
      setDialogOpen(false)
    }
    catch (error)
    {
      const message = error instanceof Error ? error.message : 'Failed to create pairing URL.'
      toastManager.add(
        stackedThreadToast({
          type: 'error',
          title: 'Could not create pairing URL',
          description: message,
        }),
      )
    }
    finally
    {
      setIsCreatingPairingLink(false)
    }
  }, [onPairingLinkCreated, pairingLabel, pairingScopes])

  const togglePairingScope = useCallback((scope: AuthEnvironmentScope, checked: boolean) =>
  {
    setPairingScopes((current) =>
      checked ? [...current, scope] : current.filter((currentScope) => currentScope !== scope),
    )
  }, [])

  return (
    <div className="flex items-center gap-2">
      <Button
        size="xs"
        variant="destructive-outline"
        disabled={
          isRevokingOtherClients || clientSessions.every((clientSession) => clientSession.current)
        }
        onClick={() => void onRevokeOtherClients()}
      >
        {isRevokingOtherClients ? 'Revoking…' : 'Revoke others'}
      </Button>
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) =>
        {
          setDialogOpen(open)
          if (!open)
          {
            setPairingLabel('')
            setPairingScopes([...AuthStandardClientScopes])
          }
        }}
      >
        <DialogTrigger
          render={
            <Button size="xs" variant="default">
              <PlusIcon className="size-3" />
              Create link
            </Button>
          }
        />
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create pairing link</DialogTitle>
            <DialogDescription>
              Generate a one-time link that another device can use to pair with this backend as an
              authorized client.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-5">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">
                Client label (optional)
              </span>
              <Input
                value={pairingLabel}
                onChange={(event) => setPairingLabel(event.target.value)}
                placeholder="e.g. Living room iPad"
                disabled={isCreatingPairingLink}
                autoFocus
              />
            </label>
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-xs font-medium text-foreground">Permissions</h3>
                  <p className="text-xs text-muted-foreground">
                    Limit what the paired client can do.
                  </p>
                </div>
                <div className="flex gap-1">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={isCreatingPairingLink}
                    onClick={() => setPairingScopes([AuthOrchestrationReadScope])}
                  >
                    Read only
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={isCreatingPairingLink}
                    onClick={() => setPairingScopes([...AuthStandardClientScopes])}
                  >
                    Standard
                  </Button>
                </div>
              </div>
              <div className="divide-y divide-border/60 rounded-lg border border-input bg-muted/25">
                {PAIRING_SCOPE_OPTIONS.map(({ scope, title, description }) => (
                  <label
                    key={scope}
                    className="flex cursor-pointer items-start gap-3 px-3 py-2.5 transition-colors hover:bg-muted/40"
                  >
                    <Checkbox
                      className="mt-0.5"
                      checked={pairingScopes.includes(scope)}
                      disabled={isCreatingPairingLink}
                      onCheckedChange={(checked) => togglePairingScope(scope, checked === true)}
                    />
                    <span className="min-w-0">
                      <span className="block text-xs font-medium text-foreground">{title}</span>
                      <span className="block text-xs leading-snug text-muted-foreground">
                        {description}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              {pairingScopes.length === 0 ? (
                <p className="text-xs text-destructive">Select at least one permission.</p>
              ) : pairingScopes.includes(AuthAccessWriteScope) ? (
                <p className="text-xs text-warning">
                  This client can create or revoke access for other devices.
                </p>
              ) : null}
            </section>
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button
              variant="outline"
              disabled={isCreatingPairingLink}
              onClick={() => setDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={isCreatingPairingLink || pairingScopes.length === 0}
              onClick={() => void handleCreatePairingLink()}
            >
              {isCreatingPairingLink ? 'Creating…' : 'Create link'}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  )
})

type PairingClientsListProps = {
  endpointUrl: string | null | undefined
  endpoints: ReadonlyArray<AdvertisedEndpoint>
  defaultEndpointKey: string | null
  presentation?: AccessSectionPresentation
  isLoading: boolean
  pairingLinks: ReadonlyArray<ServerPairingLinkRecord>
  createdPairingCredentials: ReadonlyMap<string, string>
  clientSessions: ReadonlyArray<ServerClientSessionRecord>
  revokingPairingLinkId: string | null
  revokingClientSessionId: string | null
  onRevokePairingLink: (id: string) => void
  onRevokeClientSession: (sessionId: ServerClientSessionRecord['sessionId']) => void
}

export const PairingClientsList = memo(function PairingClientsList({
  endpointUrl,
  endpoints,
  defaultEndpointKey,
  presentation = 'current',
  isLoading,
  pairingLinks,
  createdPairingCredentials,
  clientSessions,
  revokingPairingLinkId,
  revokingClientSessionId,
  onRevokePairingLink,
  onRevokeClientSession,
}: PairingClientsListProps)
{
  return (
    <>
      {pairingLinks.map((pairingLink) => (
        <PairingLinkListRow
          key={pairingLink.id}
          pairingLink={pairingLink}
          credential={createdPairingCredentials.get(pairingLink.id)}
          endpointUrl={endpointUrl}
          endpoints={endpoints}
          defaultEndpointKey={defaultEndpointKey}
          presentation={presentation}
          revokingPairingLinkId={revokingPairingLinkId}
          onRevoke={onRevokePairingLink}
        />
      ))}

      {clientSessions.map((clientSession) => (
        <ConnectedClientListRow
          key={clientSession.sessionId}
          clientSession={clientSession}
          presentation={presentation}
          revokingClientSessionId={revokingClientSessionId}
          onRevokeSession={onRevokeClientSession}
        />
      ))}

      {pairingLinks.length === 0 && clientSessions.length === 0 && !isLoading ? (
        <div className={accessRowClassName(presentation)}>
          <p className="text-xs text-muted-foreground/60">No pairing links or client sessions.</p>
        </div>
      ) : null}
    </>
  )
})
