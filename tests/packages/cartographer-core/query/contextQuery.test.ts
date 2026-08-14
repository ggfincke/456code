// tests/packages/cartographer-core/query/contextQuery.test.ts
// typed graph loading failures and loaded-context query delegation

import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'

import { afterAll, describe, expect, it } from 'vite-plus/test'

import { diffGraphs } from '../../../../packages/cartographer-core/src/analyze/diff.ts'
import {
  ContextQueryError,
  loadContextQuery,
  queryContextDiff,
  queryContextImpact,
} from '../../../../packages/cartographer-core/src/query/contextQuery.ts'
import {
  GRAPH_SCHEMA_VERSION,
  type CartographerGraph,
  type GraphJourneyStop,
} from '../../../../packages/cartographer-core/src/contracts/types.ts'

const tempRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'carto-context-query-'))

afterAll(() => NodeFS.rmSync(tempRoot, { recursive: true, force: true }))

function graph(files: string[], edges: Array<[string, string]>): CartographerGraph
{
  return {
    version: GRAPH_SCHEMA_VERSION,
    repoRoot: '/repo',
    mode: 'imports',
    generatedAt: '2026-08-07T00:00:00.000Z',
    scope: 'src',
    nodes: files.map((id) => ({ id, kind: 'file', label: id, group: 'src' })),
    edges: edges.map(([from, to], index) => ({
      id: `e${index}`,
      from,
      to,
      kind: 'imports',
    })),
    groups: files.length > 0 ? [{ id: 'src', label: 'src', fileCount: files.length }] : [],
    metrics: { cycles: 0, orphans: 0, maxFanIn: 0, maxFanOut: 0 },
  }
}

function write(name: string, value: unknown): string
{
  const path = NodePath.join(tempRoot, name)
  NodeFS.writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
  return path
}

function captureError(action: () => unknown): ContextQueryError
{
  try
  {
    action()
  }
  catch (error)
  {
    expect(error).toBeInstanceOf(ContextQueryError)
    return error as ContextQueryError
  }
  throw new Error('expected ContextQueryError')
}

describe('loadContextQuery', () =>
{
  it('loads v4 json, normalizes it, and builds reusable relationships', () =>
  {
    const path = write('valid.json', graph(['a.ts', 'b.ts'], [['a.ts', 'b.ts']]))

    const context = loadContextQuery(path)

    expect(context.graph.version).toBe(GRAPH_SCHEMA_VERSION)
    expect(context.relations.importsOf.get('a.ts')).toEqual(['b.ts'])
    expect(context.relations.importedBy.get('b.ts')).toEqual(['a.ts'])
  })

  it('distinguishes unsupported schema versions from corrupt shapes', () =>
  {
    const unsupported = write('unsupported.json', { version: 3 })
    const corrupt = [
      { version: GRAPH_SCHEMA_VERSION, nodes: [], edges: [], groups: [] },
      { ...graph([], []), nodes: [{ id: 'missing-node-fields' }] },
      {
        ...graph(['duplicate.ts'], []),
        nodes: [
          { id: 'duplicate.ts', kind: 'file', label: 'first', group: 'src' },
          { id: 'duplicate.ts', kind: 'file', label: 'second', group: 'src' },
        ],
      },
      {
        ...graph(['source.ts'], []),
        edges: [
          {
            id: 'dangling-edge',
            from: 'source.ts',
            to: 'missing.ts',
            kind: 'imports',
          },
        ],
      },
      {
        ...graph(['source.ts'], []),
        edges: [
          {
            id: 'first-import',
            from: 'source.ts',
            to: 'source.ts',
            kind: 'imports',
          },
          {
            id: 'duplicate-import',
            from: 'source.ts',
            to: 'source.ts',
            kind: 'imports',
          },
        ],
      },
      { ...graph(['source.ts'], []), gitRef: '' },
      {
        ...graph(['source.ts'], []),
        nodes: [{ id: '', kind: 'file', label: 'source.ts', group: 'src' }],
      },
      {
        ...graph(['source.ts'], []),
        nodes: [
          {
            id: 'source.ts',
            kind: 'file',
            label: 'source.ts',
            group: 'src',
            exports: [{ name: '' }],
          },
        ],
      },
      {
        ...graph(['source.ts'], []),
        edges: [
          {
            id: 'empty-violation',
            from: 'source.ts',
            to: 'source.ts',
            kind: 'imports',
            violations: [''],
          },
        ],
      },
      {
        ...graph(['source.ts'], []),
        rules: [
          {
            id: '',
            from: 'src/**',
            to: 'packages/**',
            verdict: 'forbid',
            severity: 'error',
          },
        ],
      },
      { ...graph([], []), edges: { not: 'an array' } },
    ]

    expect(captureError(() => loadContextQuery(unsupported)).code).toBe('unsupported-version')
    for (const [index, value] of corrupt.entries())
    {
      const path = write(`corrupt-${index}.json`, value)
      expect(captureError(() => loadContextQuery(path)).code).toBe('graph-invalid')
    }
  })

  it('maps missing, unreadable, and malformed graph files to typed failures', () =>
  {
    const malformed = write('malformed.json', '{')

    expect(captureError(() => loadContextQuery(NodePath.join(tempRoot, 'missing.json'))).code).toBe(
      'graph-not-found',
    )
    expect(captureError(() => loadContextQuery(tempRoot)).code).toBe('graph-read-failed')
    expect(captureError(() => loadContextQuery(malformed)).code).toBe('graph-invalid')
  })

  it('rejects malformed graph v4 cross-field references', () =>
  {
    const base = graph(['source.ts'], [['source.ts', 'source.ts']])
    const node = base.nodes[0]!
    const edge = base.edges[0]!
    const stops = [
      {
        at: 'source.ts',
        title: 'first',
        timing: 'immediate' as const,
        resolved: ['source.ts'],
        resolvedTotal: 1,
      },
      {
        at: 'source.ts',
        title: 'second',
        timing: 'deferred' as const,
        resolved: ['source.ts'],
        resolvedTotal: 1,
        hopDistance: 0,
        hopVia: ['source.ts'],
      },
    ]
    const malformed: Array<[string, CartographerGraph]> = [
      ['node-group', { ...base, nodes: [{ ...node, group: 'missing' }] }],
      ['node-system', { ...base, nodes: [{ ...node, system: 'missing' }] }],
      [
        'duplicate-system',
        {
          ...base,
          systems: [
            { id: 'system', label: 'first', fileCount: 1, source: 'authored' },
            { id: 'system', label: 'second', fileCount: 0, source: 'fallback' },
          ],
        },
      ],
      ['edge-rule', { ...base, edges: [{ ...edge, violations: ['missing'] }] }],
      [
        'edge-type-symbol',
        { ...base, edges: [{ ...edge, symbols: ['value'], typeSymbols: ['missing'] }] },
      ],
      [
        'journey-resolved',
        {
          ...base,
          journeys: [
            {
              id: 'journey',
              title: 'journey',
              stops: [{ ...stops[0]!, resolved: ['missing'] }, stops[1]!],
            },
          ],
        },
      ],
      [
        'journey-hop',
        {
          ...base,
          journeys: [
            {
              id: 'journey',
              title: 'journey',
              stops: [stops[0]!, { ...stops[1]!, hopVia: ['missing'] }],
            },
          ],
        },
      ],
      [
        'runtime-resolved',
        {
          ...base,
          runtimes: [
            {
              key: 'runtime',
              label: 'runtime',
              roots: ['src/**'],
              resolved: ['missing'],
              resolvedTotal: 1,
            },
          ],
        },
      ],
      [
        'co-change',
        { ...base, coChanges: [{ a: 'source.ts', b: 'missing', count: 3, strength: 0.5 }] },
      ],
    ]

    for (const [name, value] of malformed)
    {
      expect(captureError(() => loadContextQuery(write(`${name}.json`, value))).code).toBe(
        'graph-invalid',
      )
    }
  })

  it('rejects malformed journey and runtime resolution evidence', () =>
  {
    const base = graph(['source.ts'], [])
    const first: GraphJourneyStop = {
      at: 'source.ts',
      title: 'first',
      timing: 'immediate',
      resolved: ['source.ts'],
      resolvedTotal: 1,
    }
    const second: GraphJourneyStop = {
      at: 'source.ts',
      title: 'second',
      timing: 'deferred',
      resolved: ['source.ts'],
      resolvedTotal: 1,
      hopDistance: 0,
      hopVia: ['source.ts'],
    }
    const withJourney = (stops: GraphJourneyStop[]): CartographerGraph => ({
      ...base,
      journeys: [{ id: 'journey', title: 'journey', stops }],
    })
    const { resolved: _firstResolved, ...firstWithoutResolved } = first
    const {
      resolved: _firstResolvedForStale,
      resolvedTotal: _firstResolvedTotalForStale,
      ...firstWithoutResolution
    } = first
    const { hopVia: _secondHopVia, ...secondWithoutHopVia } = second
    const { hopDistance: _secondHopDistance, ...secondWithoutHopDistance } = second
    const malformed: Array<[string, CartographerGraph]> = [
      ['journey-neither', withJourney([firstWithoutResolved, second])],
      ['journey-empty-resolution', withJourney([{ ...first, resolved: [] }, second])],
      ['journey-stale-resolution', withJourney([{ ...first, stale: true }, second])],
      [
        'journey-total-without-resolution',
        withJourney([{ ...firstWithoutResolved, stale: true }, second]),
      ],
      ['journey-orphan-distance', withJourney([first, secondWithoutHopVia])],
      ['journey-orphan-path', withJourney([first, secondWithoutHopDistance])],
      ['journey-negative-distance', withJourney([first, { ...second, hopDistance: -1 }])],
      ['journey-fractional-distance', withJourney([first, { ...second, hopDistance: 0.5 }])],
      [
        'journey-path-length',
        withJourney([first, { ...second, hopVia: ['source.ts', 'source.ts'] }]),
      ],
      [
        'journey-first-hop',
        withJourney([{ ...first, hopDistance: 0, hopVia: ['source.ts'] }, second]),
      ],
      ['journey-depth-and-hop', withJourney([first, { ...second, hopDepthExceeded: true }])],
      ['journey-hop-from-stale', withJourney([{ ...firstWithoutResolution, stale: true }, second])],
      [
        'runtime-neither',
        { ...base, runtimes: [{ key: 'runtime', label: 'runtime', roots: ['src/**'] }] },
      ],
      [
        'runtime-empty-resolution',
        {
          ...base,
          runtimes: [{ key: 'runtime', label: 'runtime', roots: ['src/**'], resolved: [] }],
        },
      ],
      [
        'runtime-stale-resolution',
        {
          ...base,
          runtimes: [
            {
              key: 'runtime',
              label: 'runtime',
              roots: ['src/**'],
              resolved: ['source.ts'],
              resolvedTotal: 1,
              stale: true,
            },
          ],
        },
      ],
    ]

    for (const [name, value] of malformed)
    {
      expect(captureError(() => loadContextQuery(write(`${name}.json`, value))).code).toBe(
        'graph-invalid',
      )
    }
  })

  it('accepts hop witnesses outside bounded resolution evidence', () =>
  {
    const value = graph(['a.ts', 'b.ts', 'c.ts', 'd.ts'], [['b.ts', 'd.ts']])
    value.journeys = [
      {
        id: 'bounded-witnesses',
        title: 'bounded witnesses',
        stops: [
          {
            at: '*.ts',
            title: 'first',
            timing: 'immediate',
            resolved: ['a.ts'],
            resolvedTotal: 2,
          },
          {
            at: '*.ts',
            title: 'second',
            timing: 'deferred',
            resolved: ['c.ts'],
            resolvedTotal: 2,
            hopDistance: 1,
            hopVia: ['b.ts', 'd.ts'],
          },
        ],
      },
    ]

    expect(loadContextQuery(write('bounded-witnesses.json', value)).graph.journeys).toEqual(
      value.journeys,
    )
  })

  it('rejects journey hops without matching authored endpoints and import edges', () =>
  {
    const withHop = (edges: Array<[string, string]>, firstAt: string): CartographerGraph =>
    {
      const value = graph(['a.ts', 'b.ts', 'c.ts', 'd.ts'], edges)
      value.journeys = [
        {
          id: 'fabricated-hop',
          title: 'fabricated hop',
          stops: [
            {
              at: firstAt,
              title: 'first',
              timing: 'immediate',
              resolved: ['a.ts'],
              resolvedTotal: 2,
            },
            {
              at: '*.ts',
              title: 'second',
              timing: 'deferred',
              resolved: ['c.ts'],
              resolvedTotal: 2,
              hopDistance: 1,
              hopVia: ['b.ts', 'd.ts'],
            },
          ],
        },
      ]
      return value
    }

    expect(
      captureError(() => loadContextQuery(write('missing-hop-edge.json', withHop([], '*.ts'))))
        .code,
    ).toBe('graph-invalid')
    expect(
      captureError(() =>
        loadContextQuery(
          write('mismatched-hop-endpoint.json', withHop([['b.ts', 'd.ts']], 'a.ts')),
        ),
      ).code,
    ).toBe('graph-invalid')
  })

  it('rejects resolution evidence that does not match the authored pattern', () =>
  {
    const base = graph(['a.ts', 'b.ts'], [])
    const fabricatedStop: CartographerGraph = {
      ...base,
      journeys: [
        {
          id: 'fabricated-stop',
          title: 'fabricated stop',
          stops: [
            {
              at: 'b.ts',
              title: 'first',
              timing: 'immediate',
              resolved: ['a.ts'],
              resolvedTotal: 1,
            },
            {
              at: 'b.ts',
              title: 'second',
              timing: 'deferred',
              resolved: ['b.ts'],
              resolvedTotal: 1,
            },
          ],
        },
      ],
    }
    const fabricatedRuntime: CartographerGraph = {
      ...base,
      runtimes: [
        { key: 'runtime', label: 'runtime', roots: ['b.ts'], resolved: ['a.ts'], resolvedTotal: 1 },
      ],
    }

    expect(
      captureError(() => loadContextQuery(write('fabricated-stop.json', fabricatedStop))).code,
    ).toBe('graph-invalid')
    expect(
      captureError(() => loadContextQuery(write('fabricated-runtime.json', fabricatedRuntime)))
        .code,
    ).toBe('graph-invalid')
  })
})

describe('loaded context queries', () =>
{
  it('maps impact target failures without masking valid bounded results', () =>
  {
    const context = loadContextQuery(
      write('impact.json', graph(['consumer.ts', 'provider.ts'], [['consumer.ts', 'provider.ts']])),
    )

    expect(
      queryContextImpact(context, {
        target: 'provider.ts',
        limitPerDirection: 1,
      }).upstream,
    ).toEqual({ items: ['consumer.ts'], total: 1, omitted: 0 })
    expect(
      captureError(() =>
        queryContextImpact(context, {
          target: 'missing.ts',
          limitPerDirection: 1,
        }),
      ).code,
    ).toBe('target-not-found')
  })

  it('delegates structural comparison across two loaded contexts', () =>
  {
    const base = loadContextQuery(write('base.json', graph(['a.ts'], [])))
    const head = loadContextQuery(write('head.json', graph(['a.ts', 'b.ts'], [['b.ts', 'a.ts']])))

    expect(queryContextDiff(base, head)).toEqual(diffGraphs(base.graph, head.graph))
    expect(queryContextDiff(base, head).addedNodes).toEqual(['b.ts'])
  })
})
