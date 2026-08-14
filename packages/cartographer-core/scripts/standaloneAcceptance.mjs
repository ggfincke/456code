// packages/cartographer-core/scripts/standaloneAcceptance.mjs
// verifies distribution artifacts, tracked links & the built cli

import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'

const repoRoot = new URL('..', import.meta.url)
const repoRootPath = NodePath.resolve(NodeURL.fileURLToPath(repoRoot))

function requirePath(path)
{
  if (!NodeFS.existsSync(path))
  {
    throw new Error(`required distribution artifact is missing: ${path}`)
  }
}

function verifyTrackedLinks()
{
  const records = NodeChildProcess.execFileSync('git', ['ls-files', '-s', '-z'], {
    cwd: repoRootPath,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)

  for (const record of records)
  {
    const match = /^(\d{6}) [0-9a-f]+ \d\t([\s\S]+)$/.exec(record)
    if (!match || match[1] !== '120000')
    {
      continue
    }

    const path = NodePath.join(repoRootPath, match[2])
    try
    {
      NodeFS.lstatSync(path)
    }
    catch (error)
    {
      if (error?.code === 'ENOENT')
      {
        continue
      }
      throw error
    }
    const target = NodeFS.readlinkSync(path)
    if (NodePath.isAbsolute(target))
    {
      throw new Error(`tracked symlink uses an absolute target: ${match[2]}`)
    }
    if (!NodeFS.existsSync(path))
    {
      throw new Error(`tracked symlink is dangling: ${match[2]}`)
    }
  }
}

function verifyCliSmoke()
{
  const fixtureRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'cartographer-standalone-'))
  try
  {
    NodeFS.mkdirSync(NodePath.join(fixtureRoot, 'src'))
    NodeFS.writeFileSync(
      NodePath.join(fixtureRoot, 'src', 'index.ts'),
      "// src/index.ts\n// fixture entrypoint\n\nexport { answer } from './util.js'\n",
    )
    NodeFS.writeFileSync(
      NodePath.join(fixtureRoot, 'src', 'util.ts'),
      '// src/util.ts\n// fixture value\n\nexport const answer = 42\n',
    )
    NodeFS.writeFileSync(
      NodePath.join(fixtureRoot, 'tsconfig.json'),
      `${JSON.stringify(
        {
          compilerOptions: {
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            target: 'ES2022',
            strict: true,
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      )}\n`,
    )

    NodeChildProcess.execFileSync(
      process.execPath,
      [NodePath.join(repoRootPath, 'dist', 'cli', 'index.js'), 'build', fixtureRoot],
      {
        cwd: repoRootPath,
        stdio: 'inherit',
      },
    )

    const artifactRoot = NodePath.join(fixtureRoot, '.cartographer')
    for (const name of ['graph.json', 'atlas-index.json', 'graph.db'])
    {
      requirePath(NodePath.join(artifactRoot, name))
    }

    const graph = JSON.parse(NodeFS.readFileSync(NodePath.join(artifactRoot, 'graph.json'), 'utf8'))
    if (graph.nodes.length !== 2 || graph.edges.length !== 1)
    {
      throw new Error(
        `built CLI smoke produced ${graph.nodes.length} nodes and ${graph.edges.length} edges`,
      )
    }
  }
  finally
  {
    NodeFS.rmSync(fixtureRoot, { recursive: true, force: true })
  }
}

for (const path of [
  NodePath.join(repoRootPath, 'LICENSE'),
  NodePath.join(repoRootPath, 'dist', 'cli', 'index.js'),
  NodePath.join(repoRootPath, 'dist', 'mcp', 'server.js'),
])
{
  requirePath(path)
}

verifyTrackedLinks()
verifyCliSmoke()
console.log('standalone distribution acceptance passed')
