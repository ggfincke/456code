// apps/web/src/routes/settings.providers.tsx
// render the settings providers route

import { createFileRoute } from '@tanstack/react-router'

import { ProviderSettingsPanel } from '../components/settings/SettingsPanels'

function SettingsProvidersRoute()
{
  return <ProviderSettingsPanel />
}

export const Route = createFileRoute('/settings/providers')({
  component: SettingsProvidersRoute,
})
