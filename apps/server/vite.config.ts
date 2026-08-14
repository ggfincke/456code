// apps/server/vite.config.ts
// configure server Vite+ behavior

import 'vite-plus/test/config'
import { defineConfig, mergeConfig } from 'vite-plus'

import baseConfig from '../../vite.config.ts'
import packageJson from './package.json' with { type: 'json' }

const bundledPackagePrefixes = [
  '@pierre/diffs',
  '@t3tools/',
  'effect-acp',
  'effect-codex-app-server',
]

export function shouldBundleCliDependency(id: string): boolean
{
  if (id === '@t3tools/cartographer-core' || id.startsWith('@t3tools/cartographer-core/'))
  {
    return false
  }
  return bundledPackagePrefixes.some((prefix) => id.startsWith(prefix))
}

const cliBuildChannel = packageJson.version.includes('-nightly.') ? 'nightly' : 'latest'

export default mergeConfig(
  baseConfig,
  defineConfig({
    run: {
      tasks: {
        build: {
          command: 'node scripts/cli.ts build',
          dependsOn: ['@t3tools/cartographer-core#build', '@t3tools/web#build'],
          cache: false,
        },
      },
    },
    pack: {
      entry: ['src/bin.ts'],
      outDir: 'dist',
      sourcemap: true,
      clean: true,
      deps: {
        alwaysBundle: shouldBundleCliDependency,
        onlyBundle: false,
      },
      banner: {
        js: '#!/usr/bin/env node\n',
      },
      define: {
        __T3CODE_BUILD_CHANNEL__: JSON.stringify(cliBuildChannel),
      },
    },
    test: {
      dir: '../../tests/apps/server',
      // the server suite exercises sqlite, git, temp worktrees, and orchestration
      // runtimes heavily. Running files in parallel introduces load-sensitive flakes.
      fileParallelism: false,
      // server integration tests exercise sqlite, git, and orchestration together.
      // under package-wide runs they can exceed the default budget on loaded CI hosts.
      hookTimeout: 120_000,
      testTimeout: 120_000,
    },
  }),
)
