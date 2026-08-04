// packages/shared/vite.config.ts
// runs this package's suite from the repo-root tests tree

import 'vite-plus/test/config'
import { defineConfig, mergeConfig } from 'vite-plus'

import baseConfig from '../../vite.config.ts'

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      dir: '../../tests/packages/shared',
    },
  }),
)
