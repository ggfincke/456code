// tests/apps/web/components/ui/toast.logic.test.ts
// verify should hide collapsed toast content behavior

import type { ScopedThreadRef } from '@t3tools/contracts'
import type { ServerConfigStreamEvent } from '@t3tools/contracts'
import { assert, describe, expect, it } from 'vite-plus/test'
import {
  buildVisibleToastLayout,
  hasVisibleToastAction,
  shouldHideCollapsedToastContent,
  shouldRenderThreadScopedToast,
} from '../../../../../apps/web/src/components/ui/toast.logic'
import { hiddenToastActionProps } from '../../../../../apps/web/src/components/ui/toastHelpers'
import {
  createKeybindingsUpdateToastController,
  KEYBINDINGS_SUCCESS_TOAST_COOLDOWN_MS,
} from '../../../../../apps/web/src/components/KeybindingsUpdateToast.logic'

function keybindingsEvent(
  overrides: Partial<Extract<ServerConfigStreamEvent, { type: 'keybindingsUpdated' }>> = {},
): Extract<ServerConfigStreamEvent, { type: 'keybindingsUpdated' }>
{
  return {
    version: 1,
    type: 'keybindingsUpdated',
    payload: {
      keybindings: [],
      issues: [],
    },
    ...overrides,
  }
}

describe('hasVisibleToastAction', () =>
{
  it('distinguishes a labeled action from the defined empty update payload', () =>
  {
    expect(hasVisibleToastAction({ children: 'Update' })).toBe(true)
    expect(hiddenToastActionProps.children).toBeNull()
    expect(hasVisibleToastAction(hiddenToastActionProps)).toBe(false)
    expect(hasVisibleToastAction(undefined)).toBe(false)
  })
})

describe('shouldHideCollapsedToastContent', () =>
{
  it('keeps a single visible toast readable', () =>
  {
    assert.equal(shouldHideCollapsedToastContent(0, 1), false)
  })

  it('keeps the front-most toast readable in a visible stack', () =>
  {
    assert.equal(shouldHideCollapsedToastContent(0, 3), false)
  })

  it('hides non-front toasts until the stack is expanded', () =>
  {
    assert.equal(shouldHideCollapsedToastContent(1, 3), true)
  })
})

describe('buildVisibleToastLayout', () =>
{
  it('computes indices and offsets from the visible subset', () =>
  {
    const visibleToasts = [
      { id: 'a', height: 48 },
      { id: 'b', height: 72 },
      { id: 'c', height: 24 },
    ]

    const layout = buildVisibleToastLayout(visibleToasts)

    assert.equal(layout.frontmostHeight, 48)
    assert.deepEqual(
      layout.items.map(({ toast, visibleIndex, offsetY }) => ({
        id: toast.id,
        visibleIndex,
        offsetY,
      })),
      [
        { id: 'a', visibleIndex: 0, offsetY: 0 },
        { id: 'b', visibleIndex: 1, offsetY: 48 },
        { id: 'c', visibleIndex: 2, offsetY: 120 },
      ],
    )
  })

  it('reflows live toasts forward when the front toast is dismissed', () =>
  {
    const visibleToasts = [
      { id: 'a', height: 48, transitionStatus: 'ending' as const },
      { id: 'b', height: 72 },
      { id: 'c', height: 24 },
    ]

    const layout = buildVisibleToastLayout(visibleToasts)

    // frontmost height should be the first live toast, not the ending one
    assert.equal(layout.frontmostHeight, 72)
    assert.deepEqual(
      layout.items.map(({ toast, visibleIndex, offsetY }) => ({
        id: toast.id,
        visibleIndex,
        offsetY,
      })),
      [
        // ending toast stays at its front slot; data-ending-style drives its exit
        { id: 'a', visibleIndex: 0, offsetY: 0 },
        // live toasts get fresh indices starting at 0 so they move up in sync
        { id: 'b', visibleIndex: 0, offsetY: 0 },
        { id: 'c', visibleIndex: 1, offsetY: 72 },
      ],
    )
  })

  it('keeps a non-front ending toast at its current slot so it exits straight', () =>
  {
    const visibleToasts = [
      { id: 'a', height: 48 },
      { id: 'b', height: 72, transitionStatus: 'ending' as const },
      { id: 'c', height: 24 },
    ]

    const layout = buildVisibleToastLayout(visibleToasts)

    // front toast stays, so frontmost height is unchanged
    assert.equal(layout.frontmostHeight, 48)
    assert.deepEqual(
      layout.items.map(({ toast, visibleIndex, offsetY }) => ({
        id: toast.id,
        visibleIndex,
        offsetY,
      })),
      [
        // front live toast — unaffected
        { id: 'a', visibleIndex: 0, offsetY: 0 },
        // ending toast keeps its pre-dismissal slot so its horizontal exit
        // originates from where the user saw it (not from Y=0).
        { id: 'b', visibleIndex: 1, offsetY: 48 },
        // live toast behind "b" slides forward into the vacated slot.
        { id: 'c', visibleIndex: 1, offsetY: 48 },
      ],
    )
  })

  it('treats missing heights as zero', () =>
  {
    const layout = buildVisibleToastLayout([
      { id: 'a' },
      { id: 'b', height: undefined },
      { id: 'c', height: 30 },
    ])

    assert.equal(layout.frontmostHeight, 0)
    assert.deepEqual(
      layout.items.map(({ toast, offsetY }) => ({
        id: toast.id,
        offsetY,
      })),
      [
        { id: 'a', offsetY: 0 },
        { id: 'b', offsetY: 0 },
        { id: 'c', offsetY: 0 },
      ],
    )
  })
})

describe('shouldRenderThreadScopedToast', () =>
{
  const activeThreadRef = {
    environmentId: 'environment-a',
    threadId: 'thread-1',
  } as ScopedThreadRef

  it('renders a toast scoped to the active thread ref', () =>
  {
    assert.equal(
      shouldRenderThreadScopedToast(
        {
          threadRef: activeThreadRef,
        },
        activeThreadRef,
      ),
      true,
    )
  })

  it('hides a scoped toast when the environment differs', () =>
  {
    assert.equal(
      shouldRenderThreadScopedToast(
        {
          threadRef: {
            environmentId: 'environment-b',
            threadId: 'thread-1',
          } as ScopedThreadRef,
        },
        activeThreadRef,
      ),
      false,
    )
  })

  it('keeps legacy thread-id scoped toasts working', () =>
  {
    assert.equal(
      shouldRenderThreadScopedToast(
        {
          threadId: 'thread-1' as never,
        },
        activeThreadRef,
      ),
      true,
    )
  })
})

describe('toast policy', () =>
{
  it('coalesces repeated successful keybinding reload notifications during the cooldown', () =>
  {
    let now = 1_000
    const controller = createKeybindingsUpdateToastController({
      now: () => now,
    })

    expect(controller.handle(keybindingsEvent())).toEqual({ _tag: 'Success' })

    now += KEYBINDINGS_SUCCESS_TOAST_COOLDOWN_MS - 1
    expect(controller.handle(keybindingsEvent())).toBeNull()

    now += 1
    expect(controller.handle(keybindingsEvent())).toEqual({ _tag: 'Success' })
  })

  it('surfaces keybinding configuration issues', () =>
  {
    const controller = createKeybindingsUpdateToastController({})

    expect(
      controller.handle(
        keybindingsEvent({
          payload: {
            keybindings: [],
            issues: [
              {
                kind: 'keybindings.malformed-config',
                message: 'Expected JSON array',
              },
            ],
          },
        }),
      ),
    ).toEqual({
      _tag: 'InvalidConfiguration',
      message: 'Expected JSON array',
    })
  })

  it('ignores unrelated server config notifications', () =>
  {
    const controller = createKeybindingsUpdateToastController({})

    expect(
      controller.handle({
        version: 1,
        type: 'settingsUpdated',
        payload: { settings: {} as never },
      }),
    ).toBeNull()
  })
})
