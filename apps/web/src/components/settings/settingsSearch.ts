// apps/web/src/components/settings/settingsSearch.ts
// index current settings controls for bounded sidebar search

export const SETTINGS_NAV_PATHS = [
  '/settings/general',
  '/settings/keybindings',
  '/settings/providers',
  '/settings/integrations',
  '/settings/source-control',
  '/settings/connections',
  '/settings/beta',
  '/settings/import',
  '/settings/archived',
] as const

export type SettingsPath = (typeof SETTINGS_NAV_PATHS)[number] | '/settings/diagnostics'

export const SETTINGS_SECTION_LABELS: Readonly<Record<SettingsPath, string>> = {
  '/settings/general': 'General',
  '/settings/keybindings': 'Keybindings',
  '/settings/providers': 'Providers',
  '/settings/integrations': 'Integrations',
  '/settings/source-control': 'Source Control',
  '/settings/connections': 'Connections',
  '/settings/beta': 'Beta',
  '/settings/import': 'Import sessions',
  '/settings/archived': 'Archive',
  '/settings/diagnostics': 'Diagnostics',
}

export const SETTINGS_SEARCH_INPUT_ID = 'settings-search-input'

// dom ids a search result can scroll to. only panels that render one of these ids
// get intra-page scrolling; every other entry just opens its settings route.
export const SETTINGS_ANCHORS = {
  connectionsThisEnvironment: 'settings-connections-this-environment',
  connectionsAuthorizedClients: 'settings-connections-authorized-clients',
  connectionsRemoteEnvironments: 'settings-connections-remote-environments',
} as const

export type SettingsSearchItem = {
  readonly id: string
  readonly title: string
  readonly to: SettingsPath
  // dom id to scroll to once the route renders. omitted entries land at the top of
  // their panel, which is correct but not precise.
  readonly anchorId?: string
  // extra match terms for settings whose visible title does not contain the word
  // people actually search for (theme names, "shortcuts", "api key", ...)
  readonly keywords?: ReadonlyArray<string>
}

// ! hand-maintained index of the settings surface. nothing fails when a panel
// retitles, moves or removes a setting; the entry silently goes stale, so this
// list has to be revisited whenever a settings panel changes.
export const SETTINGS_SEARCH_ITEMS: ReadonlyArray<SettingsSearchItem> = [
  {
    id: 'theme',
    title: 'Theme',
    to: '/settings/general',
    anchorId: 'settings-theme',
    keywords: ['appearance', 'light', 'dark', 'ocean', 'system'],
  },
  {
    id: 'glass-opacity',
    title: 'Glass opacity',
    to: '/settings/general',
    anchorId: 'settings-glass-opacity',
    keywords: ['blur'],
  },
  {
    id: 'project-grouping',
    title: 'Project Grouping',
    to: '/settings/general',
    anchorId: 'settings-project-grouping',
  },
  {
    id: 'time-format',
    title: 'Time format',
    to: '/settings/general',
    anchorId: 'settings-time-format',
    keywords: ['clock'],
  },
  {
    id: 'usage-display',
    title: 'Usage display',
    to: '/settings/general',
    anchorId: 'settings-usage-display',
    keywords: ['provider', 'limits', 'quota', 'percent'],
  },
  { id: 'word-wrap', title: 'Word wrap', to: '/settings/general', anchorId: 'settings-word-wrap' },
  {
    id: 'hide-whitespace-changes',
    title: 'Hide whitespace changes',
    to: '/settings/general',
    anchorId: 'settings-hide-whitespace-changes',
  },
  {
    id: 'assistant-output',
    title: 'Assistant output',
    to: '/settings/general',
    anchorId: 'settings-assistant-output',
    keywords: ['streaming'],
  },
  {
    id: 'provider-update-checks',
    title: 'Provider update checks',
    to: '/settings/general',
    anchorId: 'settings-provider-update-checks',
  },
  {
    id: 'auto-open-task-panel',
    title: 'Auto-open task panel',
    to: '/settings/general',
    anchorId: 'settings-auto-open-task-panel',
  },
  {
    id: 'new-threads',
    title: 'New threads',
    to: '/settings/general',
    anchorId: 'settings-new-threads',
    keywords: ['worktree', 'workspace mode'],
  },
  {
    id: 'start-from-origin',
    title: 'Start from origin',
    to: '/settings/general',
    anchorId: 'settings-new-threads',
  },
  {
    id: 'add-project-starts-in',
    title: 'Add project starts in',
    to: '/settings/general',
    anchorId: 'settings-add-project-starts-in',
  },
  {
    id: 'archive-confirmation',
    title: 'Archive confirmation',
    to: '/settings/general',
    anchorId: 'settings-archive-confirmation',
  },
  {
    id: 'delete-confirmation',
    title: 'Delete confirmation',
    to: '/settings/general',
    anchorId: 'settings-delete-confirmation',
  },
  {
    id: 'text-generation-model',
    title: 'Text generation model',
    to: '/settings/general',
    anchorId: 'settings-text-generation-model',
  },
  {
    id: 'update-track',
    title: 'Update track',
    to: '/settings/general',
    anchorId: 'settings-about',
    keywords: ['nightly', 'stable', 'version'],
  },
  {
    id: 'desktop-notifications',
    title: 'Desktop notifications',
    to: '/settings/general',
    anchorId: 'settings-general',
    keywords: ['alerts'],
  },
  {
    id: 'keybindings',
    title: 'Keybindings',
    to: '/settings/keybindings',
    anchorId: 'settings-keybindings',
    keywords: ['shortcuts', 'hotkeys'],
  },
  {
    id: 'providers',
    title: 'Providers',
    to: '/settings/providers',
    anchorId: 'settings-providers',
    keywords: [
      'instances',
      'api key',
      'models',
      'accent color',
      'codex',
      'claude',
      'cursor',
      'grok',
      'opencode',
      'coral',
      'gemini',
      'antigravity',
    ],
  },
  {
    id: 'browser',
    title: 'Browser',
    to: '/settings/integrations',
    anchorId: 'browser',
    keywords: ['integrations', 'preview'],
  },
  {
    id: 'agent-browser-access',
    title: 'Agent browser access',
    to: '/settings/integrations',
    anchorId: 'browser',
    keywords: ['browser tools', 'permissions'],
  },
  {
    id: 'default-viewport',
    title: 'Default viewport',
    to: '/settings/integrations',
    anchorId: 'browser',
    keywords: ['browser', 'responsive', 'width', 'height', 'devices'],
  },
  {
    id: 'default-zoom',
    title: 'Default zoom',
    to: '/settings/integrations',
    anchorId: 'browser',
    keywords: ['browser', 'scale'],
  },
  {
    id: 'default-appearance',
    title: 'Default appearance',
    to: '/settings/integrations',
    anchorId: 'browser',
    keywords: ['browser', 'light', 'dark', 'color scheme'],
  },
  {
    id: 'auto-show-browser-panel',
    title: 'Auto-show browser panel',
    to: '/settings/integrations',
    anchorId: 'browser',
    keywords: ['preview'],
  },
  {
    id: 'version-control',
    title: 'Version Control',
    to: '/settings/source-control',
    keywords: ['git', 'repositories'],
  },
  {
    id: 'source-control-providers',
    title: 'Source Control Providers',
    to: '/settings/source-control',
    keywords: ['github', 'pull request'],
  },
  {
    id: 'source-control-writing-style',
    title: 'Source control writing style',
    to: '/settings/source-control',
    anchorId: 'settings-source-control-writing-style',
    keywords: ['commit message'],
  },
  {
    id: 'follow-change-request-templates',
    title: 'Follow change request templates',
    to: '/settings/source-control',
    anchorId: 'settings-follow-change-request-templates',
  },
  {
    id: 'source-control-writer-model',
    title: 'Source control writer model',
    to: '/settings/source-control',
    anchorId: 'settings-source-control-writer-model',
  },
  {
    id: 'architecture-analysis',
    title: 'Architecture analysis',
    to: '/settings/source-control',
    keywords: ['automatic', 'on demand', 'repository map'],
  },
  {
    id: 'connections-this-environment',
    title: 'This environment',
    to: '/settings/connections',
    anchorId: SETTINGS_ANCHORS.connectionsThisEnvironment,
    keywords: ['network access', 'endpoints', 'tailscale', 'wsl', 'administrative access'],
  },
  {
    id: 'connections-authorized-clients',
    title: 'Authorized clients',
    to: '/settings/connections',
    anchorId: SETTINGS_ANCHORS.connectionsAuthorizedClients,
    keywords: ['pairing', 'qr', 'sessions', 'revoke'],
  },
  {
    id: 'connections-remote-environments',
    title: 'Remote environments',
    to: '/settings/connections',
    anchorId: SETTINGS_ANCHORS.connectionsRemoteEnvironments,
    keywords: ['ssh', 'backend', 'remote link'],
  },
  { id: 'sidebar-v2', title: 'Sidebar v2', to: '/settings/beta', anchorId: 'settings-sidebar-v2' },
  {
    id: 'auto-settle-inactive-threads',
    title: 'Auto-settle inactive threads',
    to: '/settings/beta',
    anchorId: 'settings-sidebar-v2',
  },
  {
    id: 'auto-settle-merged-threads',
    title: 'Auto-settle merged threads',
    to: '/settings/beta',
    anchorId: 'settings-sidebar-v2',
  },
  {
    id: 'import-sessions',
    title: 'Import sessions',
    to: '/settings/import',
    anchorId: 'settings-import-sessions',
    keywords: ['codex', 'claude', 'transcripts'],
  },
  { id: 'archived-threads', title: 'Archived threads', to: '/settings/archived' },
  {
    id: 'diagnostics',
    title: 'Diagnostics',
    to: '/settings/diagnostics',
    keywords: ['traces', 'logs'],
  },
  {
    id: 'live-processes',
    title: 'Live Processes',
    to: '/settings/diagnostics',
    anchorId: 'settings-live-processes',
    keywords: ['cpu', 'memory', 'process', 'pid'],
  },
  {
    id: 'resource-history',
    title: 'Resource History',
    to: '/settings/diagnostics',
    anchorId: 'settings-resource-history',
    keywords: ['cpu', 'memory', 'samples'],
  },
  {
    id: 'trace-diagnostics',
    title: 'Trace Diagnostics',
    to: '/settings/diagnostics',
    anchorId: 'settings-trace-diagnostics',
    keywords: ['logs', 'spans', 'failures'],
  },
]

// fold case and accents so "Thème"/"THEME" both match, and collapse runs of
// whitespace so a stray double space still hits.
function normalizeSearchText(value: string): string
{
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim()
}

function matchesKeyword(item: SettingsSearchItem, normalizedQuery: string): boolean
{
  return (
    item.keywords?.some((keyword) => normalizeSearchText(keyword).includes(normalizedQuery)) ??
    false
  )
}

// title hits come before keyword-only hits; within each tier the catalog order (which
// follows the sidebar) decides, so results stay predictable as you type.
export function searchSettings(
  query: string,
  items: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS,
): ReadonlyArray<SettingsSearchItem>
{
  const normalizedQuery = normalizeSearchText(query)
  if (normalizedQuery.length === 0) return []

  const titleHits: Array<SettingsSearchItem> = []
  const keywordHits: Array<SettingsSearchItem> = []
  for (const item of items)
  {
    if (normalizeSearchText(item.title).includes(normalizedQuery))
    {
      titleHits.push(item)
    }
    else if (matchesKeyword(item, normalizedQuery))
    {
      keywordHits.push(item)
    }
  }
  return [...titleHits, ...keywordHits]
}
