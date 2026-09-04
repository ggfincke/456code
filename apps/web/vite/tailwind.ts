// apps/web/vite/tailwind.ts
// adapt Tailwind dev hooks to Vite's experimental bundled mode

import tailwindcss from '@tailwindcss/vite'

export function tailwindPlugins(bundledDev: boolean)
{
  const plugins = tailwindcss()
  if (bundledDev)
  {
    for (const plugin of plugins)
    {
      // bundled dev tracks watched dependencies without this incompatible module-node hook
      delete plugin.hotUpdate
    }
  }
  return plugins
}
