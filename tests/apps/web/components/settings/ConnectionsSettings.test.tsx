// tests/apps/web/components/settings/ConnectionsSettings.test.tsx
// verify pairing credentials stay local to their creation environment generation

// @vitest-environment happy-dom

import { AuthAccessWriteScope, EnvironmentId } from '@t3tools/contracts'
import * as DateTime from 'effect/DateTime'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

const harness = vi.hoisted(() => ({
  authSnapshot: null as unknown,
  command: vi.fn(),
  createPairingCredential: vi.fn(),
  environmentId: 'environment-a',
  revokeClientSession: vi.fn(),
  revokeOtherClientSessions: vi.fn(),
  revokePairingLink: vi.fn(),
  setDefaultAdvertisedEndpointKey: vi.fn(),
}))

const authAccessAtom = vi.hoisted(() => ({ kind: 'auth-access' }))

vi.mock('../../../../../apps/web/src/state/environments', () => ({
  useEnvironments: () => ({ environments: [] }),
  usePrimaryEnvironment: () => ({
    environmentId: EnvironmentId.make(harness.environmentId),
    label: harness.environmentId,
    serverConfig: null,
  }),
}))

vi.mock('../../../../../apps/web/src/environments/primary', () => ({
  createServerPairingCredential: harness.createPairingCredential,
  isLoopbackHostname: (hostname: string) => hostname === 'localhost' || hostname === '127.0.0.1',
  revokeOtherServerClientSessions: harness.revokeOtherClientSessions,
  revokeServerClientSession: harness.revokeClientSession,
  revokeServerPairingLink: harness.revokePairingLink,
  usePrimarySessionState: () => ({
    data: {
      authenticated: true,
      auth: { policy: 'remote-reachable' },
      scopes: [AuthAccessWriteScope],
    },
  }),
}))

vi.mock('../../../../../apps/web/src/state/auth', () => ({
  authEnvironment: {
    accessChanges: () => authAccessAtom,
  },
}))

vi.mock('../../../../../apps/web/src/state/query', () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data: atom === authAccessAtom ? harness.authSnapshot : null,
    error: null,
    failure: null,
    isPending: false,
    hasSettled: true,
    refresh: vi.fn(),
  }),
}))

vi.mock('../../../../../apps/web/src/connection/catalog', () => ({
  environmentCatalog: { remove: Symbol('remove'), retryNow: Symbol('retry') },
}))

vi.mock('../../../../../apps/web/src/connection/onboarding', () => ({
  connectPairing: Symbol('connect-pairing'),
  connectSshEnvironment: Symbol('connect-ssh'),
}))

vi.mock('../../../../../apps/web/src/state/use-atom-command', () => ({
  useAtomCommand: () => harness.command,
}))

vi.mock('../../../../../apps/web/src/uiStateStore', () => ({
  useUiStateStore: (selector: (state: unknown) => unknown) =>
    selector({
      defaultAdvertisedEndpointKey: null,
      setDefaultAdvertisedEndpointKey: harness.setDefaultAdvertisedEndpointKey,
    }),
}))

vi.mock('../../../../../apps/web/src/versionSkew', () => ({
  resolveServerConfigVersionMismatch: () => null,
  resolveServerSelfUpdateCapability: () => null,
}))

vi.mock('../../../../../apps/web/src/components/ServerUpdateAction', () => ({
  ServerUpdateAction: () => null,
}))

vi.mock(
  '../../../../../apps/web/src/components/settings/settingsLayout',
  async (importOriginal) =>
  {
    const actual =
      await importOriginal<
        typeof import('../../../../../apps/web/src/components/settings/settingsLayout')
      >()
    const React = await import('react')
    return {
      ...actual,
      SettingsPageContainer: ({ children }: { readonly children?: React.ReactNode }) =>
        React.createElement('div', null, children),
    }
  },
)

import { ConnectionsSettings } from '../../../../../apps/web/src/components/settings/ConnectionsSettings'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
Object.defineProperty(Element.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

let container: HTMLDivElement
let root: Root

function setEnvironment(environmentId: string, pairingLinkId = `link-${environmentId}`)
{
  harness.environmentId = environmentId
  harness.authSnapshot = {
    type: 'snapshot',
    revision: 1,
    payload: {
      pairingLinks: [
        {
          id: pairingLinkId,
          scopes: [AuthAccessWriteScope],
          subject: 'one-time-token',
          label: `${environmentId} phone`,
          createdAt: DateTime.makeUnsafe('2026-09-04T00:00:00.000Z'),
          expiresAt: DateTime.makeUnsafe('2099-09-04T00:00:00.000Z'),
        },
      ],
      clientSessions: [],
    },
  }
}

async function renderSettings()
{
  await act(async () => root.render(<ConnectionsSettings />))
}

async function clickButton(label: string, occurrence = 0)
{
  const buttons = Array.from(document.querySelectorAll('button')).filter(
    (button) => button.textContent?.trim() === label,
  )
  const button = buttons[occurrence]
  expect(button, `button ${label} at index ${occurrence}`).toBeDefined()
  await act(async () => button!.click())
}

async function createLink()
{
  await clickButton('Create link')
  await clickButton('Create link', 1)
}

function deferred<T>()
{
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) =>
  {
    resolve = complete
  })
  return { promise, resolve }
}

beforeEach(() =>
{
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  Object.defineProperty(window, 'desktopBridge', { configurable: true, value: undefined })
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false })
  harness.createPairingCredential.mockReset()
  setEnvironment('environment-a')
})

afterEach(() =>
{
  act(() => root.unmount())
  container.remove()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('ConnectionsSettings pairing credential ownership', () =>
{
  it('reveals only a newly created credential and clears it on identity change and unmount', async () =>
  {
    await renderSettings()
    expect(document.body.textContent).toContain('Create a new link to share from this client.')
    expect(document.body.textContent).toContain('Revoke')
    expect(document.querySelector('[aria-label="Show QR code"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Show code')

    const credential = 'created-environment-a-secret'
    harness.createPairingCredential.mockResolvedValue({
      id: 'link-environment-a',
      credential,
      expiresAt: DateTime.makeUnsafe('2099-09-04T00:00:00.000Z'),
    })
    await createLink()
    await clickButton('Show code')
    expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(credential)

    setEnvironment('environment-b')
    await renderSettings()
    expect(document.body.textContent).not.toContain(credential)
    expect(document.body.textContent).not.toContain('Show code')

    act(() => root.unmount())
    root = createRoot(container)
    setEnvironment('environment-a')
    await renderSettings()
    expect(document.body.textContent).not.toContain(credential)
    expect(document.body.textContent).not.toContain('Show code')
  })

  it('ignores late creation responses after A to B and A to B to A switches', async () =>
  {
    type CreationResult = {
      readonly id: string
      readonly credential: string
      readonly expiresAt: DateTime.DateTime
    }

    const switchedCreation = deferred<CreationResult>()
    harness.createPairingCredential.mockReturnValue(switchedCreation.promise)
    await renderSettings()
    await clickButton('Create link')
    const switchedSubmit = clickButton('Create link', 1)
    setEnvironment('environment-b')
    await renderSettings()
    switchedCreation.resolve({
      id: 'link-environment-a',
      credential: 'late-after-switch-secret',
      expiresAt: DateTime.makeUnsafe('2099-09-04T00:00:00.000Z'),
    })
    await switchedSubmit
    expect(document.body.textContent).not.toContain('late-after-switch-secret')
    expect(document.body.textContent).not.toContain('Show code')

    setEnvironment('environment-a')
    await renderSettings()
    const cycledCreation = deferred<CreationResult>()
    harness.createPairingCredential.mockReturnValue(cycledCreation.promise)
    await clickButton('Create link')
    const cycledSubmit = clickButton('Create link', 1)
    setEnvironment('environment-b')
    await renderSettings()
    setEnvironment('environment-a')
    await renderSettings()
    cycledCreation.resolve({
      id: 'link-environment-a',
      credential: 'late-after-cycle-secret',
      expiresAt: DateTime.makeUnsafe('2099-09-04T00:00:00.000Z'),
    })
    await cycledSubmit
    expect(document.body.textContent).not.toContain('late-after-cycle-secret')
    expect(document.body.textContent).not.toContain('Show code')
  })
})
