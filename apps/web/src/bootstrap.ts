// apps/web/src/bootstrap.ts
// load the application after the bundled-dev refresh preamble

import { showBootError } from './lib/bootError'

// dynamic loading keeps shared chunks behind the refresh preamble and exposes startup failures
void import('./main').then(({ startup }) => startup).catch(showBootError)
