// tests/apps/mobile/features/layout/AdaptiveWorkspaceLayout.test.tsx
// verify android split-view task creation remains reachable from an active thread

// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vite-plus/test'

const harness = vi.hoisted(() => ({ navigate: vi.fn() }))

vi.mock('@effect/atom-react', async () =>
{
  const { AsyncResult } = await import('effect/unstable/reactivity')
  return { useAtomValue: () => AsyncResult.success({ projectGroupingEnabled: false }) }
})

vi.mock('../../../../../apps/mobile/src/state/preferences', () => ({
  mobilePreferencesAtom: {},
}))

vi.mock('@react-navigation/native', async () =>
{
  const { createContext } = await import('react')
  return {
    NavigationContext: createContext(null),
    NavigationRouteContext: createContext(null),
    StackActions: { replace: vi.fn() },
    useFocusEffect: vi.fn(),
    useNavigation: () => ({ navigate: harness.navigate }),
  }
})

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  useWindowDimensions: () => ({ width: 1200, height: 900 }),
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
  Pressable: ({
    children,
    accessibilityLabel,
    onPress,
  }: {
    children?: ReactNode
    accessibilityLabel?: string
    onPress?: () => void
  }) => (
    <button aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
}))

vi.mock('react-native-reanimated', () => ({
  Easing: { cubic: (value: number) => value, inOut: (curve: unknown) => curve },
  ReduceMotion: { System: 'system' },
  default: { View: ({ children }: { children?: ReactNode }) => <div>{children}</div> },
  useAnimatedStyle: (style: () => unknown) => style(),
  useSharedValue: (value: number) => ({ value }),
  withTiming: (value: number) => value,
}))

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}))

vi.mock('../../../../../apps/mobile/src/components/AppSymbol', () => ({
  SymbolView: () => null,
}))

vi.mock('../../../../../apps/mobile/src/lib/useThemeColor', () => ({
  useThemeColor: () => '#ffffff',
}))

vi.mock('../../../../../apps/mobile/src/features/layout/workspace-inspector-pane', () => ({
  WorkspaceInspectorPane: () => null,
}))

vi.mock('../../../../../apps/mobile/src/features/threads/ThreadNavigationSidebar', () => ({
  ThreadNavigationSidebar: ({ selectedThreadKey }: { selectedThreadKey: string | null }) => (
    <nav aria-label="Thread sidebar" data-selected-thread={selectedThreadKey} />
  ),
}))

import { AdaptiveWorkspaceLayout } from '../../../../../apps/mobile/src/features/layout/AdaptiveWorkspaceLayout'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

it('opens the new-task sheet from the Android wide sidebar while a thread is selected', () =>
{
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try
  {
    act(() =>
      root.render(
        <AdaptiveWorkspaceLayout pathname="/threads/environment-proof/thread-proof">
          <main>Selected thread</main>
        </AdaptiveWorkspaceLayout>,
      ),
    )
    expect(container.querySelector('nav')?.getAttribute('data-selected-thread')).toBeTruthy()
    expect(container.querySelector('main')?.textContent).toBe('Selected thread')
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="New task"]')
    expect(button).not.toBeNull()
    act(() => button!.click())
    expect(harness.navigate).toHaveBeenCalledExactlyOnceWith('NewTaskSheet', { screen: 'NewTask' })
  }
  finally
  {
    act(() => root.unmount())
    container.remove()
  }
})
