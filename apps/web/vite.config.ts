// apps/web/vite.config.ts
// configure web Vite+ behavior

import tailwindcss from '@tailwindcss/vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { defineProject, type TestProjectInlineConfiguration } from 'vite-plus/test/config'
import 'vite-plus/test/config'
import { defineConfig } from 'vite-plus'
import pkg from './package.json' with { type: 'json' }

import * as NodeURL from 'node:url'

import { loadRepoEnv } from '../../scripts/lib/public-config'

// tsconfigPaths only applies "~/*" to files it considers part of this package,
// so the relocated tests under repo-root tests/apps/web can't resolve it. An
// explicit alias mirrors apps/web/tsconfig.json's paths for every importer,
// which also keeps vi.mock("~/…") ids identical to the ids the sources import.
const webSrcDir = NodeURL.fileURLToPath(new URL('./src', import.meta.url))

const repoEnv = loadRepoEnv()
Object.assign(process.env, repoEnv)

const port = Number(process.env.PORT ?? 5733)
const host = process.env.HOST?.trim() || 'localhost'
const configuredWsUrl = process.env.VITE_WS_URL?.trim()
const configuredRelayUrl = repoEnv.VITE_T3CODE_RELAY_URL?.trim() || ''
const configuredRelayTracingUrl = repoEnv.VITE_RELAY_OTLP_TRACES_URL?.trim() || ''
const configuredRelayTracingDataset = repoEnv.VITE_RELAY_OTLP_TRACES_DATASET?.trim() || ''
const configuredRelayTracingToken = repoEnv.VITE_RELAY_OTLP_TRACES_TOKEN?.trim() || ''
const configuredHostedAppChannel = process.env.VITE_HOSTED_APP_CHANNEL?.trim() || ''
const configuredAppVersion = process.env.APP_VERSION?.trim() || pkg.version
const configuredHostedAppUrl = (() =>
{
  const explicitHostedAppUrl = process.env.VITE_HOSTED_APP_URL?.trim()
  if (explicitHostedAppUrl)
  {
    return explicitHostedAppUrl
  }
  if (process.env.VERCEL_ENV === 'production' && process.env.VERCEL_PROJECT_PRODUCTION_URL)
  {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  }
  if (process.env.VERCEL_URL)
  {
    return `https://${process.env.VERCEL_URL}`
  }
  return undefined
})()
const sourcemapEnv = process.env.T3CODE_WEB_SOURCEMAP?.trim().toLowerCase()

// vite 8.1's experimental bundled dev mode: serves rolldown-bundled chunks in
// dev for much faster startup/reload on large module graphs, with HMR served
// as hot patches. Opt-in while experimental: T3CODE_BUNDLED_DEV=1 pnpm dev:web
const bundledDevEnv = process.env.T3CODE_BUNDLED_DEV?.trim().toLowerCase()
const bundledDev = bundledDevEnv === '1' || bundledDevEnv === 'true'

const buildSourcemap: boolean | 'hidden' =
  sourcemapEnv === '0' || sourcemapEnv === 'false'
    ? false
    : sourcemapEnv === 'hidden'
      ? 'hidden'
      : true

const unitTestProject = {
  extends: true,
  test: {
    name: 'unit',
    dir: '../../tests/apps/web',
    include: ['**/*.test.{ts,tsx}'],
    // the web runtime suite exercises auth bootstrap, saved environments,
    // and websocket subscription lifecycles. Under the full monorepo test
    // run, those async tests can exceed Vitest's default 5s budget.
    hookTimeout: 15_000,
    testTimeout: 15_000,
  },
} satisfies TestProjectInlineConfiguration

function resolveDevProxyTarget(wsUrl: string | undefined): string | undefined
{
  if (!wsUrl)
  {
    return undefined
  }

  try
  {
    const url = new URL(wsUrl)
    if (url.protocol === 'ws:')
    {
      url.protocol = 'http:'
    }
    else if (url.protocol === 'wss:')
    {
      url.protocol = 'https:'
    }
    url.pathname = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  }
  catch
  {
    return undefined
  }
}

const devProxyTarget = resolveDevProxyTarget(configuredWsUrl)

export default defineConfig(() =>
{
  return {
    plugins: [
      tanstackRouter(),
      react(),
      babel({
        // we need to be explicit about the parser options after moving to @vitejs/plugin-react v6.0.0
        // this is because the babel plugin only automatically parses typescript and jsx based on relative paths (e.g. "**/*.ts")
        // whereas the previous version of the plugin parsed all files with a .ts extension.
        // this is causing our packages/ directory to fail to parse, as they are not relative to the CWD.
        parserOpts: { plugins: ['typescript', 'jsx'] },
        presets: [reactCompilerPreset()],
      }),
      tailwindcss(),
    ],
    optimizeDeps: {
      include: [
        '@pierre/diffs',
        '@pierre/diffs/editor',
        '@pierre/diffs/react',
        '@pierre/diffs/worker/worker.js',
        'effect/Array',
        'effect/Order',
        'react-dom/client',
      ],
    },
    define: {
      // in dev mode, tell the web app where the WebSocket server lives
      'import.meta.env.VITE_WS_URL': JSON.stringify(configuredWsUrl ?? ''),
      'import.meta.env.VITE_T3CODE_RELAY_URL': JSON.stringify(configuredRelayUrl),
      'import.meta.env.VITE_RELAY_OTLP_TRACES_URL': JSON.stringify(configuredRelayTracingUrl),
      'import.meta.env.VITE_RELAY_OTLP_TRACES_DATASET': JSON.stringify(
        configuredRelayTracingDataset,
      ),
      'import.meta.env.VITE_RELAY_OTLP_TRACES_TOKEN': JSON.stringify(configuredRelayTracingToken),
      'import.meta.env.VITE_HOSTED_APP_URL': JSON.stringify(configuredHostedAppUrl ?? ''),
      'import.meta.env.VITE_HOSTED_APP_CHANNEL': JSON.stringify(configuredHostedAppChannel),
      'import.meta.env.APP_VERSION': JSON.stringify(configuredAppVersion),
    },
    resolve: {
      tsconfigPaths: true,
      dedupe: ['react', 'react-dom'],
      alias: [{ find: /^~\//, replacement: `${webSrcDir}/` }],
    },
    experimental: {
      bundledDev,
    },
    server: {
      host,
      port,
      strictPort: true,
      ...(devProxyTarget
        ? {
            proxy: {
              '/.well-known': {
                target: devProxyTarget,
                changeOrigin: true,
              },
              '/api': {
                target: devProxyTarget,
                changeOrigin: true,
              },
              '/attachments': {
                target: devProxyTarget,
                changeOrigin: true,
              },
            },
          }
        : {}),
      hmr: {
        // explicit config so Vite's HMR WebSocket connects reliably
        // inside Electron's BrowserWindow. Vite 8 uses console.debug for
        // connection logs — enable "Verbose" in DevTools to see them.
        protocol: 'ws',
        host,
        clientPort: port,
      },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: buildSourcemap,
    },
    test: {
      projects: [defineProject(unitTestProject)],
    },
  }
})
