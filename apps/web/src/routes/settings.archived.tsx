// apps/web/src/routes/settings.archived.tsx
// render the settings archived route

import { createFileRoute } from '@tanstack/react-router'

import { ArchivedThreadsPanel } from '../components/settings/SettingsPanels'

export const Route = createFileRoute('/settings/archived')({
  component: ArchivedThreadsPanel,
})
