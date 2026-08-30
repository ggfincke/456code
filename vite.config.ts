// vite.config.ts
// coordinate repository-wide Vite+ tests, lint, staged checks, & sidecar formatting

import 'vite-plus/test/config'
import { defineConfig } from 'vite-plus'
import * as NodeURL from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '~': NodeURL.fileURLToPath(new URL('./apps/web/src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    exclude: [
      '**/.repos/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-electron/**',
      '**/.{idea,git,cache,output,temp}/**',
    ],
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
  staged: {
    // partition staged formatting and comment checks by supported language
    '*': 'node scripts/format-repository.ts --staged',
    '*.{cjs,js,jsx,mjs,ts,tsx}': 'node scripts/check-js-comments.ts',
    '*.{bash,kt,kts,py,sh,swift,zsh}': 'python3 scripts/check_comment_style.py --check --headers',
  },
  fmt: {
    ignorePatterns: [
      '.reference',
      '.repos/**',
      '.plans',
      'dev-docs',
      '.alchemy',
      'dist',
      'dist-electron',
      'node_modules',
      'pnpm-lock.yaml',
      '*.tsbuildinfo',
      '**/routeTree.gen.ts',
      'apps/mobile/ios/**',
      'apps/web/public/mockServiceWorker.js',
      'apps/web/src/lib/vendor/qrcodegen.ts',
      'apps/mobile/uniwind-types.d.ts',
      '*.icon/**',
      '**/*.cjs',
      '**/*.js',
      '**/*.jsx',
      '**/*.mjs',
      '**/*.ts',
      '**/*.tsx',
    ],
    sortPackageJson: {},
    overrides: [
      {
        files: ['.devcontainer/devcontainer.json'],
        options: {
          trailingComma: 'none',
        },
      },
    ],
  },
  lint: {
    ignorePatterns: [
      '.repos',
      '.repos/**',
      'dist',
      'dist-electron',
      'node_modules',
      'pnpm-lock.yaml',
      '*.tsbuildinfo',
      '**/routeTree.gen.ts',
      '**/*.generated.ts',
      '**/*.generated.tsx',
      '**/_generated/**',
      'apps/mobile/ios/**',
      'apps/mobile/uniwind-types.d.ts',
      'packages/shared/src/qrCode.ts',
    ],
    plugins: ['eslint', 'oxc', 'react', 'unicorn', 'typescript'],
    jsPlugins: ['./oxlint-plugin-456code/index.ts'],
    categories: {
      correctness: 'warn',
      suspicious: 'warn',
      perf: 'warn',
    },
    rules: {
      'unicorn/no-array-sort': 'off',
      'unicorn/consistent-function-scoping': 'off',
      'oxc/no-map-spread': 'off',
      'react-in-jsx-scope': 'off',
      'react-hooks/exhaustive-deps': 'off',
      'eslint/no-shadow': 'off',
      'eslint/no-await-in-loop': 'off',
      'eslint/no-underscore-dangle': 'off',
      'typescript/consistent-return': 'off',
      'typescript/no-base-to-string': 'off',
      'typescript/no-duplicate-type-constituents': 'off',
      'typescript/no-floating-promises': 'off',
      'typescript/no-implied-eval': 'off',
      'typescript/no-meaningless-void-operator': 'off',
      'typescript/no-redundant-type-constituents': 'off',
      'typescript/no-unnecessary-boolean-literal-compare': 'off',
      'typescript/no-unnecessary-type-conversion': 'off',
      'typescript/no-unnecessary-type-arguments': 'off',
      'typescript/no-unnecessary-type-assertion': 'off',
      'typescript/no-unnecessary-type-parameters': 'off',
      'typescript/no-unsafe-type-assertion': 'off',
      'typescript/await-thenable': 'off',
      'typescript/require-array-sort-compare': 'off',
      'typescript/restrict-template-expressions': 'off',
      'typescript/unbound-method': 'off',
      'eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@t3tools/client-runtime',
              message:
                'Import from an explicit @t3tools/client-runtime/* subpath. The package has no root export.',
            },
          ],
          patterns: [
            {
              group: [
                '@t3tools/cartographer-core/*',
                '!@t3tools/cartographer-core/contracts',
                '!@t3tools/cartographer-core/server',
              ],
              message: 'Use only the contracts or server Cartographer subpath exports.',
            },
          ],
        },
      ],
      '456code/no-global-process-runtime': 'error',
      '456code/no-inline-schema-compile': 'warn',
      '456code/no-manual-effect-runtime-in-tests': 'error',
      '456code/no-mobile-uniwind-theme-escape-hatches': 'error',
      '456code/namespace-node-imports': 'error',
      '456code/block-doc-comments': 'error',
      '456code/comment-tags': 'error',
      '456code/file-header': 'error',
      '456code/no-inline-prose': 'error',
      '456code/no-unicode-arrow': 'error',
      '456code/plain-comment-case': 'error',
    },
    options: {
      // revisit once Oxlint's tsgolint path can integrate with @effect/tsgo diagnostics
      typeAware: false,
      typeCheck: false,
    },
  },
})
