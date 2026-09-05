// apps/web/src/routes/settings.usage.tsx
// mounts the usage and pricing settings panel

import { createFileRoute } from '@tanstack/react-router'

import { UsageSettingsPanel } from '../components/settings/UsageSettingsPanel'

export const Route = createFileRoute('/settings/usage')({
  component: UsageSettingsPanel,
})
