// tests/packages/cartographer-core/analyzeTrees.test.ts
// deterministic static tree analysis, readiness & path isolation

import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vite-plus/test'
import {
  runAnalyzeTrees,
  type AnalysisReadyManifest,
} from '../../../packages/cartographer-core/src/cli/commands/analyzeTrees.ts'
import { trackedTempRoot } from './helpers/trackedTempRoot.ts'

const tempRoots = trackedTempRoot('carto-analyze-trees-')
const tempDir = tempRoots.create
const BASE_REF = '1'.repeat(40)
const PROPOSED_REF = '2'.repeat(40)
const ANALYZER_VERSION = `sha256:${'3'.repeat(64)}`
const STAGING_PREFIX = '.cartographer-analyze-trees-'

afterAll(tempRoots.cleanup)

interface TreePair
{
  output: string
  base: string
  proposed: string
}

function treePair(): TreePair
{
  const output = tempDir()
  const base = NodePath.join(output, 'base')
  const proposed = NodePath.join(output, 'proposed')
  for (const root of [base, proposed])
  {
    NodeFS.mkdirSync(NodePath.join(root, 'src'), { recursive: true })
    NodeFS.writeFileSync(
      NodePath.join(root, 'src', 'a.ts'),
      "import { b } from './b.js'\nexport const a = b\n",
    )
    NodeFS.writeFileSync(NodePath.join(root, 'src', 'b.ts'), 'export const b = 1\n')
  }
  NodeFS.writeFileSync(
    NodePath.join(proposed, 'src', 'a.ts'),
    "import { c } from './c.js'\nexport const a = c\n",
  )
  NodeFS.writeFileSync(NodePath.join(proposed, 'src', 'c.ts'), 'export const c = 2\n')
  return { output, base, proposed }
}

function analysisValues(output: string)
{
  return {
    out: output,
    'base-ref': BASE_REF,
    'proposed-ref': PROPOSED_REF,
    'analyzer-version': ANALYZER_VERSION,
    'implementation-changed-file-count': '2',
  }
}

function artifact(pair: TreePair, name: string): string
{
  return NodeFS.readFileSync(NodePath.join(pair.output, name), 'utf-8')
}

function stagingDirectories(output: string): string[]
{
  return NodeFS.readdirSync(output)
    .filter((name) => name.startsWith(STAGING_PREFIX))
    .sort()
}

describe('analyze-trees', () =>
{
  it('writes deterministic static artifacts and one exact readiness line', async () =>
  {
    const first = treePair()
    const second = treePair()
    const fakeBin = tempDir()
    const gitMarker = NodePath.join(tempDir(), 'git-called')
    const projectCodeMarker = NodePath.join(tempDir(), 'project-code-called')
    const fakeGit = NodePath.join(fakeBin, 'git')
    NodeFS.writeFileSync(
      fakeGit,
      '#!/bin/sh\nprintf called >> "$CARTOGRAPHER_GIT_MARKER"\nexit 97\n',
    )
    NodeFS.chmodSync(fakeGit, 0o755)
    const projectPlugin =
      '// project-plugin.cjs\n' +
      '// must never execute during static analysis\n' +
      `require('node:fs').writeFileSync(${JSON.stringify(projectCodeMarker)}, 'called')\n`
    for (const pair of [first, second])
    {
      for (const root of [pair.base, pair.proposed])
      {
        NodeFS.writeFileSync(NodePath.join(root, 'project-plugin.cjs'), projectPlugin)
        NodeFS.writeFileSync(
          NodePath.join(root, 'tsconfig.json'),
          JSON.stringify({
            compilerOptions: {
              plugins: [{ name: './project-plugin.cjs' }],
            },
          }),
        )
      }
    }
    const originalPath = process.env.PATH
    const originalMarker = process.env.CARTOGRAPHER_GIT_MARKER
    process.env.PATH = `${fakeBin}:${originalPath ?? ''}`
    process.env.CARTOGRAPHER_GIT_MARKER = gitMarker
    const stdout: string[] = []
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) =>
    {
      stdout.push(String(chunk))
      return true
    })

    let firstManifest: AnalysisReadyManifest
    let secondManifest: AnalysisReadyManifest
    try
    {
      firstManifest = await runAnalyzeTrees(
        first.base,
        first.proposed,
        analysisValues(first.output),
      )
      secondManifest = await runAnalyzeTrees(
        second.base,
        second.proposed,
        analysisValues(second.output),
      )
    }
    finally
    {
      write.mockRestore()
      process.env.PATH = originalPath
      if (originalMarker === undefined)
      {
        delete process.env.CARTOGRAPHER_GIT_MARKER
      }
      else
      {
        process.env.CARTOGRAPHER_GIT_MARKER = originalMarker
      }
    }

    const expectedManifest: AnalysisReadyManifest = {
      type: 'cartographer.analysis-ready',
      version: 2,
      analyzerVersion: ANALYZER_VERSION,
      baseGraph: 'base.graph.json',
      proposedGraph: 'proposed.graph.json',
      impact: 'impact.json',
      impactProjection: 'impact-projection.json',
    }
    expect(firstManifest).toEqual(expectedManifest)
    expect(secondManifest).toEqual(expectedManifest)
    expect(stdout.join('')).toBe(
      `${JSON.stringify(expectedManifest)}\n${JSON.stringify(expectedManifest)}\n`,
    )
    expect(NodeFS.existsSync(gitMarker)).toBe(false)
    expect(NodeFS.existsSync(projectCodeMarker)).toBe(false)

    for (const name of [
      'base.graph.json',
      'proposed.graph.json',
      'impact.json',
      'impact-projection.json',
    ])
    {
      expect(artifact(first, name)).toBe(artifact(second, name))
    }
    const baseGraph = JSON.parse(artifact(first, 'base.graph.json'))
    const impact = JSON.parse(artifact(first, 'impact.json'))
    const impactProjection = JSON.parse(artifact(first, 'impact-projection.json'))
    expect(baseGraph).toMatchObject({
      repoRoot: '.',
      generatedAt: '1970-01-01T00:00:00.000Z',
      gitRef: BASE_REF,
      scope: '.',
    })
    expect(baseGraph.coChanges).toBeUndefined()
    expect(impact).toMatchObject({
      baseGitRef: BASE_REF,
      headGitRef: PROPOSED_REF,
      addedNodes: ['src/c.ts'],
      removedNodes: [],
      changed: true,
    })
    expect(impactProjection).toMatchObject({
      version: 1,
      kind: 'impact-diff',
      authority: 'verified',
      resultState: 'graph',
      baseGitRef: BASE_REF,
      headGitRef: PROPOSED_REF,
      implementationChangedFileCount: 2,
      totals: {
        changedFiles: { total: 2, returned: 0, omitted: 2 },
      },
    })
  })

  it('excludes outside-target symlinks without following or mutating them', async () =>
  {
    const first = treePair()
    const second = treePair()
    const firstOutside = NodePath.join(tempDir(), 'first-outside.ts')
    const secondOutside = NodePath.join(tempDir(), 'second-outside.ts')
    const firstLink = NodePath.join(first.proposed, 'src', 'outside.ts')
    const secondLink = NodePath.join(second.proposed, 'src', 'outside.ts')
    NodeFS.writeFileSync(firstOutside, 'export const outside = "first"\n')
    NodeFS.writeFileSync(secondOutside, 'export const outside = "second"\n')
    NodeFS.symlinkSync(firstOutside, firstLink)
    NodeFS.symlinkSync(secondOutside, secondLink)

    await runAnalyzeTrees(first.base, first.proposed, analysisValues(first.output))
    await runAnalyzeTrees(second.base, second.proposed, analysisValues(second.output))

    for (const name of [
      'base.graph.json',
      'proposed.graph.json',
      'impact.json',
      'impact-projection.json',
    ])
    {
      expect(artifact(first, name)).toBe(artifact(second, name))
    }
    const proposedGraph = JSON.parse(artifact(first, 'proposed.graph.json'))
    expect(proposedGraph.nodes.map((node: { id: string }) => node.id)).not.toContain(
      'src/outside.ts',
    )
    expect(NodeFS.lstatSync(firstLink).isSymbolicLink()).toBe(true)
    expect(NodeFS.lstatSync(secondLink).isSymbolicLink()).toBe(true)
    expect(NodeFS.readFileSync(firstOutside, 'utf-8')).toBe('export const outside = "first"\n')
    expect(NodeFS.readFileSync(secondOutside, 'utf-8')).toBe('export const outside = "second"\n')
  })

  it('seals an implementation-only change as exact no-impact', async () =>
  {
    const pair = treePair()
    NodeFS.rmSync(NodePath.join(pair.proposed, 'src'), { recursive: true })
    NodeFS.cpSync(NodePath.join(pair.base, 'src'), NodePath.join(pair.proposed, 'src'), {
      recursive: true,
    })

    await runAnalyzeTrees(pair.base, pair.proposed, {
      ...analysisValues(pair.output),
      'implementation-changed-file-count': '1',
    })

    const impactProjection = JSON.parse(artifact(pair, 'impact-projection.json'))
    expect(impactProjection).toMatchObject({
      authority: 'verified',
      resultState: 'no-impact',
      implementationChangedFileCount: 1,
      nodes: [],
      edges: [],
      totals: {
        changedFiles: { total: 1, returned: 0, omitted: 1 },
      },
    })
  })

  it('keeps staging under the output owner and cleans it on success or failure', async () =>
  {
    const successful = treePair()
    const success = runAnalyzeTrees(
      successful.base,
      successful.proposed,
      analysisValues(successful.output),
    )
    const activeSuccessStaging = stagingDirectories(successful.output)
    expect(activeSuccessStaging).toHaveLength(1)
    expect(
      NodePath.relative(
        successful.output,
        NodePath.join(successful.output, activeSuccessStaging[0]!),
      ),
    ).toBe(activeSuccessStaging[0])
    await success
    expect(stagingDirectories(successful.output)).toEqual([])

    const failed = treePair()
    NodeFS.mkdirSync(NodePath.join(failed.output, 'base.graph.json'))
    const failure = runAnalyzeTrees(failed.base, failed.proposed, analysisValues(failed.output))
    expect(stagingDirectories(failed.output)).toHaveLength(1)
    await expect(failure).rejects.toThrow()
    expect(stagingDirectories(failed.output)).toEqual([])
  })

  it('rejects oversized combined output before publishing any artifact', async () =>
  {
    const pair = treePair()
    const analysis = runAnalyzeTrees(pair.base, pair.proposed, analysisValues(pair.output), {
      maxOutputBytes: 1,
    })
    expect(stagingDirectories(pair.output)).toHaveLength(1)
    await expect(analysis).rejects.toThrow('analysis artifacts exceed the 1-byte output limit')
    expect(stagingDirectories(pair.output)).toEqual([])
    for (const name of [
      'base.graph.json',
      'proposed.graph.json',
      'impact.json',
      'impact-projection.json',
    ])
    {
      expect(NodeFS.existsSync(NodePath.join(pair.output, name))).toBe(false)
    }
  })

  it('rejects overlapping roots and output paths that enter a source tree', async () =>
  {
    const pair = treePair()
    const nestedOutput = NodePath.join(pair.base, 'artifacts')
    NodeFS.mkdirSync(nestedOutput)
    await expect(
      runAnalyzeTrees(pair.base, pair.proposed, analysisValues(nestedOutput)),
    ).rejects.toThrow('analysis output must be outside')

    await expect(
      runAnalyzeTrees(pair.base, pair.base, analysisValues(pair.output)),
    ).rejects.toThrow('base and proposed roots must be separate')

    await expect(
      runAnalyzeTrees(pair.base, pair.proposed, {
        ...analysisValues(pair.output),
        'analyzer-version': 'sha256:short',
      }),
    ).rejects.toThrow('invalid --analyzer-version')

    const target = tempDir()
    const outputLink = NodePath.join(tempDir(), 'output-link')
    NodeFS.symlinkSync(target, outputLink)
    await expect(
      runAnalyzeTrees(pair.base, pair.proposed, analysisValues(outputLink)),
    ).rejects.toThrow('must be a real directory')
  })
})
