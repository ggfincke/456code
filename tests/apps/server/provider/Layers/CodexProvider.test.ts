// tests/apps/server/provider/Layers/CodexProvider.test.ts
// verifies Codex probing, model capabilities, and account usage normalization
import { assert, it } from '@effect/vitest'
import * as Deferred from 'effect/Deferred'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Queue from 'effect/Queue'
import * as Schema from 'effect/Schema'
import * as Sink from 'effect/Sink'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'
import { CodexSettings } from '@t3tools/contracts'

import {
  applyPreferredCodexDefaultModel,
  appendCustomCodexModels,
  checkCodexProviderStatus,
  mapCodexAccountUsage,
  mapCodexModelCapabilities,
  parseCodexModelListResponse,
  resolveCodexAccountUsage,
} from '../../../../../apps/server/src/provider/Layers/CodexProvider.ts'

it('classifies explicit Codex upgrades while keeping defaults, unknown models, and custom entries current', () =>
{
  const model = (slug: string) => ({
    id: slug,
    model: slug,
    displayName: slug,
    description: '',
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: 'medium' as const,
    supportedReasoningEfforts: [],
  })
  const models = appendCustomCodexModels(
    applyPreferredCodexDefaultModel(
      parseCodexModelListResponse({
        data: [
          { ...model('superseded'), upgrade: ' future ' },
          { ...model('superseded-info'), upgradeInfo: { model: 'future' } },
          model('future'),
          { ...model('self'), upgrade: ' self ' },
          { ...model('blank'), upgrade: ' ' },
          { ...model('provider-default'), isDefault: true, upgrade: 'future' },
          { ...model('gpt-5.6-sol'), upgrade: 'future' },
        ],
        nextCursor: null,
      }),
    ),
    [' superseded ', 'custom-old-model'],
  )
  assert.deepStrictEqual(
    models.filter((entry) => entry.isLegacy).map((entry) => entry.slug),
    ['superseded', 'superseded-info'],
  )
  assert.strictEqual(models.filter((entry) => entry.slug === 'superseded').length, 1)
  assert.strictEqual(models.find((entry) => entry.slug === 'gpt-5.6-sol')?.isDefault, true)
  assert.strictEqual(models.at(-1)?.isCustom, true)
  assert.strictEqual(models.at(-1)?.isLegacy, undefined)
})

const makeStalledUsageSpawner = Effect.fn('makeStalledUsageSpawner')(function* ()
{
  const stdout = yield* Queue.unbounded<Uint8Array>()
  const rateLimitsRequested = yield* Deferred.make<void>()
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  let remainder = ''

  const respond = (id: unknown, result: unknown) =>
    Queue.offer(stdout, encoder.encode(`${JSON.stringify({ id, result })}\n`))

  const stdin = Sink.forEach((chunk: Uint8Array) =>
  {
    remainder += decoder.decode(chunk, { stream: true })
    const lines = remainder.split('\n')
    remainder = lines.pop() ?? ''

    return Effect.forEach(
      lines,
      (line) =>
      {
        const message = JSON.parse(line) as { readonly id?: unknown; readonly method?: unknown }
        switch (message.method)
        {
          case 'initialize':
            return respond(message.id, {
              userAgent: 'codex-cli/1.0.0',
              codexHome: process.cwd(),
              platformFamily: 'unix',
              platformOs: 'test',
            })
          case 'account/read':
            return respond(message.id, {
              account: { type: 'chatgpt', email: 'dev@example.com', planType: 'plus' },
              requiresOpenaiAuth: false,
            })
          case 'skills/list':
            return respond(message.id, { data: [] })
          case 'model/list':
            return respond(message.id, { data: [] })
          case 'account/rateLimits/read':
            return Deferred.succeed(rateLimitsRequested, undefined)
          default:
            return Effect.void
        }
      },
      { discard: true },
    )
  })

  const handle = ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.never,
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin,
    stdout: Stream.fromQueue(stdout),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  })

  return {
    rateLimitsRequested,
    spawner: ChildProcessSpawner.make(() => Effect.succeed(handle)),
  }
})

it('normalizes and de-duplicates Codex account usage windows', () =>
{
  const mirrored = {
    limitId: 'codex',
    limitName: 'Codex',
    primary: { usedPercent: 62, windowDurationMins: 300, resetsAt: 1_800_000_000 },
    secondary: { usedPercent: 84, windowDurationMins: 10_080, resetsAt: 1_800_500_000 },
  } as const
  const usage = mapCodexAccountUsage(
    {
      rateLimits: mirrored,
      rateLimitsByLimitId: {
        codex: mirrored,
        reviews: {
          limitId: 'reviews',
          limitName: 'Code reviews',
          primary: { usedPercent: 120, windowDurationMins: 1_440, resetsAt: null },
        },
      },
    },
    '2026-04-10T00:00:00.000Z',
  )

  assert.deepStrictEqual(usage, {
    status: 'available',
    observedAt: '2026-04-10T00:00:00.000Z',
    windows: [
      {
        id: 'account:primary',
        label: '5h',
        usedPercent: 62,
        resetsAt: '2027-01-15T08:00:00.000Z',
      },
      {
        id: 'account:secondary',
        label: 'Week',
        usedPercent: 84,
        resetsAt: '2027-01-21T02:53:20.000Z',
      },
      {
        id: 'reviews:primary',
        label: '1d',
        scopeLabel: 'Code reviews',
        usedPercent: 100,
        resetsAt: null,
      },
    ],
  })
})

it('keeps a missing Codex rate-limit response non-fatal to account status', () =>
{
  const usage = resolveCodexAccountUsage(
    {
      account: {
        account: { type: 'chatgpt', email: 'dev@example.com', planType: 'plus' },
        requiresOpenaiAuth: true,
      },
      rateLimits: undefined,
      version: '1.0.0',
      models: [],
      skills: [],
    },
    '2026-04-10T00:00:00.000Z',
  )

  assert.deepStrictEqual(usage, {
    status: 'unavailable',
    observedAt: '2026-04-10T00:00:00.000Z',
    message: 'Codex plan usage is temporarily unavailable.',
  })
})

it.effect('keeps the Codex snapshot ready when the usage request stalls', () =>
  Effect.gen(function* ()
  {
    const { rateLimitsRequested, spawner } = yield* makeStalledUsageSpawner()
    const settings = yield* Schema.decodeEffect(CodexSettings)({ binaryPath: 'codex' })
    const statusFiber = yield* checkCodexProviderStatus(settings).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.forkScoped,
    )

    yield* Deferred.await(rateLimitsRequested)
    yield* TestClock.adjust(Duration.seconds(4))
    const status = yield* Fiber.join(statusFiber)

    assert.strictEqual(status.status, 'ready')
    assert.strictEqual(status.auth.status, 'authenticated')
    assert.strictEqual(status.accountUsage?.status, 'unavailable')
  }),
)

it('maps current Codex model capability fields', () =>
{
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: 'super-high',
    description: 'Test model',
    displayName: 'GPT Test',
    hidden: false,
    id: 'gpt-test',
    isDefault: true,
    model: 'gpt-test',
    defaultServiceTier: 'flex',
    serviceTiers: [
      {
        id: 'priority',
        name: 'Fast',
        description: 'Lower latency responses.',
      },
      {
        id: 'flex',
        name: 'Flex',
        description: 'Lower-cost asynchronous routing.',
      },
    ],
    supportedReasoningEfforts: [
      {
        description: 'Maximum reasoning',
        reasoningEffort: 'super-high',
      },
    ],
  })

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: 'reasoningEffort',
      label: 'Reasoning',
      type: 'select',
      options: [{ id: 'super-high', label: 'super-high', isDefault: true }],
      currentValue: 'super-high',
    },
    {
      id: 'serviceTier',
      label: 'Service Tier',
      type: 'select',
      options: [
        { id: 'default', label: 'Standard' },
        {
          id: 'priority',
          label: 'Fast',
          description: 'Lower latency responses.',
        },
        {
          id: 'flex',
          label: 'Flex',
          description: 'Lower-cost asynchronous routing.',
          isDefault: true,
        },
      ],
      currentValue: 'flex',
    },
  ])
})

it('uses standard routing when the catalog has no default service tier', () =>
{
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ['fast'],
    defaultReasoningEffort: 'medium',
    defaultServiceTier: null,
    description: 'Test model',
    displayName: 'GPT Test',
    hidden: false,
    id: 'gpt-test',
    isDefault: true,
    model: 'gpt-test',
    serviceTiers: [
      {
        id: 'priority',
        name: 'Fast',
        description: '1.5x speed, increased usage',
      },
    ],
    supportedReasoningEfforts: [],
  })

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: 'serviceTier',
      label: 'Service Tier',
      type: 'select',
      options: [
        { id: 'default', label: 'Standard', isDefault: true },
        {
          id: 'priority',
          label: 'Fast',
          description: '1.5x speed, increased usage',
        },
      ],
      currentValue: 'default',
    },
  ])
})

it('marks the most preferred available model as default', () =>
{
  const models = applyPreferredCodexDefaultModel([
    { slug: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', isCustom: false, capabilities: null },
    { slug: 'gpt-5.4', name: 'GPT-5.4', isCustom: false, isDefault: true, capabilities: null },
  ])

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: 'gpt-5.6-terra', isDefault: true },
      { slug: 'gpt-5.4', isDefault: undefined },
    ],
  )
})

it('prefers sol over terra when both are available', () =>
{
  const models = applyPreferredCodexDefaultModel([
    { slug: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', isCustom: false, capabilities: null },
    { slug: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', isCustom: false, capabilities: null },
  ])

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, 'gpt-5.6-sol')
})

it("keeps Codex's own default when no preferred model is available", () =>
{
  const models = applyPreferredCodexDefaultModel([
    { slug: 'gpt-5.5', name: 'GPT-5.5', isCustom: false, capabilities: null },
    { slug: 'gpt-5.4', name: 'GPT-5.4', isCustom: false, isDefault: true, capabilities: null },
  ])

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, 'gpt-5.4')
})

it('ignores custom models that shadow a preferred slug', () =>
{
  const models = applyPreferredCodexDefaultModel([
    { slug: 'gpt-5.6-sol', name: 'gpt-5.6-sol', isCustom: true, capabilities: null },
    { slug: 'gpt-5.4', name: 'GPT-5.4', isCustom: false, isDefault: true, capabilities: null },
  ])

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, 'gpt-5.4')
})
