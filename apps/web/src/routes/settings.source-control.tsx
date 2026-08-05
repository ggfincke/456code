// apps/web/src/routes/settings.source-control.tsx
// render the settings source control route

import { createFileRoute } from '@tanstack/react-router'

import { SourceControlSettingsPanel } from '../components/settings/SourceControlSettings'

export const Route = createFileRoute('/settings/source-control')({
  component: SourceControlSettingsPanel,
})
