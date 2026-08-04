// tests/apps/desktop/ssh/DesktopSshEnvironment.test.ts
// verify ssh environment behavior

import * as NodeHttpClient from '@effect/platform-node/NodeHttpClient'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import * as NetService from '@t3tools/shared/Net'
import { SshPasswordPromptError } from '@t3tools/ssh/errors'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'

import * as DesktopSshEnvironment from '../../../../apps/desktop/src/ssh/DesktopSshEnvironment.ts'
import * as DesktopSshPasswordPrompts from '../../../../apps/desktop/src/ssh/DesktopSshPasswordPrompts.ts'

function makeTempHomeDir()
{
  return Effect.gen(function* ()
  {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.makeTempDirectoryScoped({ prefix: 't3-ssh-env-test-' })
  })
}

describe('sshEnvironment', () =>
{
  it('maps prompt presentation failures to the SSH password-prompt wrapper message', () =>
  {
    const cause = new DesktopSshPasswordPrompts.DesktopSshPromptPresentationError({
      requestId: 'prompt-1',
      destination: 'devbox',
      operation: 'send-prompt-request',
      cause: new Error('renderer send failed'),
    })

    assert.equal(
      DesktopSshEnvironment.toSshPasswordPromptError(cause).message,
      '456code window is not available for SSH authentication.',
    )
  })

  it('treats password prompt timeouts as cancellable authentication prompts', () =>
  {
    assert.equal(
      DesktopSshEnvironment.isDesktopSshPasswordPromptCancellation(
        new SshPasswordPromptError({
          message: 'SSH authentication timed out for devbox.',
          cause: new DesktopSshPasswordPrompts.DesktopSshPromptTimedOutError({
            requestId: 'prompt-1',
            destination: 'devbox',
          }),
        }),
      ),
      true,
    )
  })

  // package owns include/known_hosts discovery; desktop only pins layer wiring
  it.effect('wires desktop host discovery through the ssh package runtime', () =>
    Effect.gen(function* ()
    {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const homeDir = yield* makeTempHomeDir()
      const sshDir = path.join(homeDir, '.ssh')
      yield* fs.makeDirectory(sshDir, { recursive: true })
      yield* fs.writeFileString(
        path.join(sshDir, 'config'),
        ['Host devbox', '  HostName devbox.example.com', ''].join('\n'),
      )

      const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment
      const hosts = yield* sshEnvironment.discoverHosts({ homeDir })
      assert.deepEqual(hosts, [
        {
          alias: 'devbox',
          hostname: 'devbox',
          username: null,
          port: null,
          source: 'ssh-config',
        },
      ])
    }).pipe(
      Effect.provide(
        DesktopSshEnvironment.layer().pipe(
          Layer.provideMerge(
            Layer.succeed(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, {
              request: () => Effect.die('unexpected password prompt request'),
              resolve: () => Effect.die('unexpected password prompt resolution'),
            }),
          ),
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(NodeHttpClient.layerUndici),
          Layer.provideMerge(NetService.layer),
        ),
      ),
      Effect.scoped,
    ),
  )
})
