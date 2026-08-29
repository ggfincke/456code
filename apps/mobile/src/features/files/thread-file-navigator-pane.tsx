// apps/mobile/src/features/files/thread-file-navigator-pane.tsx
// render thread file navigator pane

import type { EnvironmentId, ProjectListEntriesResult } from '@t3tools/contracts'
import { useCallback, useMemo, useState, type ComponentProps } from 'react'
import { Platform, useColorScheme, View, type NativeSyntheticEvent } from 'react-native'
import {
  Screen,
  ScreenStack,
  ScreenStackHeaderConfig,
  ScreenStackHeaderSearchBarView,
  SearchBar,
} from 'react-native-screens'

import { nativeHeaderScrollEdgeEffects } from '../../native/StackHeader'
import { useThemeColor } from '../../lib/useThemeColor'
import { projectEnvironment } from '../../state/projects'
import { useEnvironmentQuery } from '../../state/query'
import { FileTreeBrowser } from './FileTreeBrowser'
import { preloadWorkspaceFileContents } from './preload-workspace-file'

export function ThreadFileNavigatorPane(props: {
  readonly cwd: string
  readonly environmentId: EnvironmentId
  readonly projectName: string
  readonly selectedPath: string | null
  readonly onSelectFile: (path: string) => void
})
{
  const [searchQuery, setSearchQuery] = useState('')
  const colorScheme = useColorScheme()
  const highlightTheme = colorScheme === 'dark' ? 'dark' : 'light'
  const foregroundColor = String(useThemeColor('--color-foreground'))
  const sheetColor = String(useThemeColor('--color-sheet'))
  const headerScrollEdgeEffects = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version)
  const entriesQuery = useEnvironmentQuery(
    projectEnvironment.listEntries({
      environmentId: props.environmentId,
      input: { cwd: props.cwd },
    }),
  )
  const entriesData = entriesQuery.data as ProjectListEntriesResult | null
  const handlePreviewFile = useCallback(
    (relativePath: string) =>
    {
      preloadWorkspaceFileContents({
        cwd: props.cwd,
        environmentId: props.environmentId,
        relativePath,
        theme: highlightTheme,
      })
    },
    [highlightTheme, props.cwd, props.environmentId],
  )
  const nativeHeaderRightBarButtonItems = useMemo(
    () =>
      [
        {
          accessibilityLabel: 'Refresh files',
          icon: { name: 'arrow.clockwise', type: 'sfSymbol' as const },
          identifier: 'thread-file-navigator-refresh',
          onPress: entriesQuery.refresh,
          sharesBackground: false,
          tintColor: foregroundColor,
          type: 'button' as const,
          width: 44,
        },
      ] as ComponentProps<typeof ScreenStackHeaderConfig>['headerRightBarButtonItems'],
    [entriesQuery.refresh, foregroundColor],
  )

  const fileTree = (
    <FileTreeBrowser
      entries={entriesData?.entries ?? []}
      error={entriesQuery.error}
      isPending={entriesQuery.isPending}
      searchQuery={searchQuery}
      selectedPath={props.selectedPath}
      onPreviewFile={handlePreviewFile}
      onRefresh={entriesQuery.refresh}
      onSelectFile={props.onSelectFile}
    />
  )

  return (
    <View className="flex-1 border-l border-border bg-sheet">
      <ScreenStack style={{ flex: 1 }}>
        <Screen
          activityState={2}
          enabled
          isNativeStack
          screenId="thread-file-navigator-native"
          scrollEdgeEffects={headerScrollEdgeEffects}
          style={{ backgroundColor: sheetColor, flex: 1 }}
        >
          {fileTree}
          <ScreenStackHeaderConfig
            backgroundColor="rgba(0,0,0,0)"
            color={foregroundColor}
            headerRightBarButtonItems={nativeHeaderRightBarButtonItems}
            hideBackButton
            hideShadow={false}
            navigationItemStyle="editor"
            subtitle={props.projectName}
            title="Files"
            titleColor={foregroundColor}
            titleFontSize={17}
            titleFontWeight="700"
            translucent
          >
            <ScreenStackHeaderSearchBarView>
              <SearchBar
                allowToolbarIntegration
                autoCapitalize="none"
                barTintColor={sheetColor}
                hideNavigationBar={false}
                hideWhenScrolling={false}
                obscureBackground={false}
                onCancelButtonPress={() =>
                {
                  setSearchQuery('')
                }}
                onChangeText={(event: NativeSyntheticEvent<{ readonly text?: string }>) =>
                {
                  setSearchQuery(event.nativeEvent.text ?? '')
                }}
                placement="integratedButton"
                placeholder="Search files"
                textColor={foregroundColor}
                tintColor={foregroundColor}
              />
            </ScreenStackHeaderSearchBarView>
          </ScreenStackHeaderConfig>
        </Screen>
      </ScreenStack>
    </View>
  )
}
