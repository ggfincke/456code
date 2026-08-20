// apps/web/src/routes/settings.integrations.tsx
// render the settings integrations route

import { createFileRoute } from '@tanstack/react-router'

import { IntegrationsSettingsPanel } from '../components/settings/SettingsPanels'

function SettingsIntegrationsRoute()
{
  return <IntegrationsSettingsPanel />
}

export const Route = createFileRoute('/settings/integrations')({
  component: SettingsIntegrationsRoute,
})
