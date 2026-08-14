// packages/cartographer-core/scripts/cleanDist.mjs
// removes stale compiler output before rebuilding the core package

import * as NodeFS from 'node:fs'
import * as NodeURL from 'node:url'

const distUrl = new URL('../dist/', import.meta.url)

NodeFS.rmSync(NodeURL.fileURLToPath(distUrl), { recursive: true, force: true })
