// tests/apps/server/provider/testFixtures/openCodeCliOrderingMock.mjs
// records OpenCode CLI inventory ordering while modeling its shared SQLite lock

import * as NodeFS from 'node:fs'
import * as NodeTimersPromises from 'node:timers/promises'

const logPath = process.env.T3_TEST_OPENCODE_ORDER_LOG
const lockPath = process.env.T3_TEST_OPENCODE_LOCK_PATH
if (!logPath || !lockPath)
{
  throw new Error('OpenCode ordering fixture paths are required.')
}

const command = process.argv.slice(2).join(' ')
NodeFS.appendFileSync(logPath, `start ${command}\n`)

let lock
try
{
  lock = NodeFS.openSync(lockPath, 'wx')
}
catch (error)
{
  NodeFS.appendFileSync(logPath, `locked ${command}\n`)
  throw error
}

try
{
  await NodeTimersPromises.setTimeout(40)
  if (process.argv[2] === 'models')
  {
    process.stdout.write(
      'openai/gpt-test\n{"id":"gpt-test","providerID":"openai","name":"GPT Test"}\n',
    )
  }
  else if (process.argv[2] === 'debug')
  {
    process.stdout.write('[]')
  }
}
finally
{
  NodeFS.closeSync(lock)
  NodeFS.unlinkSync(lockPath)
  NodeFS.appendFileSync(logPath, `end ${command}\n`)
}
