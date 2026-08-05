// tests/apps/server/mdx/WorkspaceMdxDocument.test.ts
// verifies safe workspace mdx compilation and host sanitization

import * as NodeServices from '@effect/platform-node/NodeServices'
import { ThreadId } from '@t3tools/contracts'
import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'

import * as ServerConfig from '../../../../apps/server/src/config.ts'
import { readWorkspaceMdxDocument } from '../../../../apps/server/src/mdx/WorkspaceMdxDocument.ts'
import * as VcsDriverRegistry from '../../../../apps/server/src/vcs/VcsDriverRegistry.ts'
import * as VcsProcess from '../../../../apps/server/src/vcs/VcsProcess.ts'
import * as WorkspaceEntries from '../../../../apps/server/src/workspace/WorkspaceEntries.ts'
import * as WorkspaceFileSystem from '../../../../apps/server/src/workspace/WorkspaceFileSystem.ts'
import * as WorkspacePaths from '../../../../apps/server/src/workspace/WorkspacePaths.ts'

const WorkspaceLayer = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
)

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(WorkspaceLayer),
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: 't3-workspace-mdx-test-',
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
)

const threadId = ThreadId.make('thread-mdx-test')
const MDX_EXECUTION_SENTINEL = '__t3_workspace_mdx_execution_sentinel__'
const MDX_DIAGNOSTIC_SECRET = 'Bearer_SUPERSECRET'
const MDX_SCHEMA_SECRET = 'frontmatter-schema-secret'

const makeTempDir = Effect.gen(function* ()
{
  const fileSystem = yield* FileSystem.FileSystem
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: 't3code-workspace-mdx-',
  })
})

const writeFile = Effect.fn('WorkspaceMdxDocumentTest.writeFile')(function* (
  cwd: string,
  relativePath: string,
  contents: string | Uint8Array,
)
{
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const absolutePath = path.join(cwd, relativePath)
  yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true })
  if (typeof contents === 'string')
  {
    yield* fileSystem.writeFileString(absolutePath, contents)
  }
  else
  {
    yield* fileSystem.writeFile(absolutePath, contents)
  }
})

it.layer(TestLayer, { excludeTestServices: true })('WorkspaceMdxDocument', (it) =>
{
  describe('readWorkspaceMdxDocument', () =>
  {
    it.effect('returns the versioned closed document with normalized host references', () =>
      Effect.gen(function* ()
      {
        const workspaceRoot = yield* makeTempDir
        const source = [
          '---',
          'title: Safe overview',
          '---',
          '# Overview',
          '',
          '[Guide](../README.md)',
          '',
          '![Diagram](./architecture.png)',
          '',
          '<Callout type="warning" title="Review">',
          'Check the affected modules.',
          '</Callout>',
          '',
          '<FileReference path="src/../docs/guide.ts" line={12} label="guide" />',
          '<SymbolReference id="symbol:guide" path="src/index.ts" line={4} />',
          '<DiffReference id="diff:proposal-1" label="proposal" />',
          '<ArchitectureImpact id="impact:proposal-1">',
          'Three modules.',
          '</ArchitectureImpact>',
        ].join('\n')
        yield* writeFile(workspaceRoot, 'docs/overview.mdx', source)

        const result = yield* readWorkspaceMdxDocument({
          threadId,
          workspaceRoot,
          relativePath: 'docs/overview.mdx',
        })

        expect(result).toMatchObject({
          transportVersion: 1,
          relativePath: 'docs/overview.mdx',
          byteLength: Buffer.byteLength(source),
          source,
          document: {
            version: 1,
            frontmatter: { title: 'Safe overview' },
          },
        })
        expect(result.document.diagnostics).toEqual([])

        const components = result.document.root.children.filter((node) => node.type === 'component')
        expect(components.map((node) => node.name)).toEqual([
          'Callout',
          'FileReference',
          'SymbolReference',
          'DiffReference',
          'ArchitectureImpact',
        ])
        expect(components[1]).toMatchObject({
          name: 'FileReference',
          props: { path: 'docs/guide.ts', line: 12, label: 'guide' },
        })
      }),
    )

    it.effect('keeps unsafe syntax inert and strips invalid host targets from the document', () =>
      Effect.gen(function* ()
      {
        const workspaceRoot = yield* makeTempDir
        const source = [
          '# Unsafe inputs',
          '',
          `export const shouldNeverRun = (globalThis.${MDX_EXECUTION_SENTINEL} = "executed")`,
          '',
          "<Unknown payload={{ authorization: 'Bearer secret' }} />",
          '',
          '<FileReference path="/etc/passwd" />',
          '<DiffReference id="../../etc/passwd" />',
          '',
          "<script>alert('not executable')</script>",
          '',
          '[unsafe](javascript:alert(1))',
          '',
          '![external](https://example.com/tracker.png)',
        ].join('\n')
        yield* writeFile(workspaceRoot, 'unsafe.mdx', source)

        const result = yield* readWorkspaceMdxDocument({
          threadId,
          workspaceRoot,
          relativePath: 'unsafe.mdx',
        })
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        const serializedDocument = JSON.stringify(result.document)

        expect(
          result.document.diagnostics.some((diagnostic) => diagnostic.severity === 'error'),
        ).toBe(true)
        expect(
          result.document.diagnostics.some(
            (diagnostic) => diagnostic.source === '456code' && diagnostic.code === 'T3MDX002',
          ),
        ).toBe(true)
        expect(serializedDocument).not.toContain('unknownComponent')
        expect(serializedDocument).not.toContain('/etc/passwd')
        expect(serializedDocument).not.toContain('Bearer secret')
        expect(serializedDocument).not.toContain('javascript:')
        expect(serializedDocument).not.toContain('tracker.png')
        expect(Reflect.get(globalThis, MDX_EXECUTION_SENTINEL)).toBeUndefined()
      }),
    )

    it.effect('publishes bounded diagnostics without rejected source payloads', () =>
      Effect.gen(function* ()
      {
        const workspaceRoot = yield* makeTempDir
        const source = [
          '---',
          `value: *${MDX_DIAGNOSTIC_SECRET}`,
          '---',
          '# Invalid frontmatter',
        ].join('\n')
        yield* writeFile(workspaceRoot, 'diagnostic.mdx', source)

        const result = yield* readWorkspaceMdxDocument({
          threadId,
          workspaceRoot,
          relativePath: 'diagnostic.mdx',
        })
        const diagnostic = result.document.diagnostics.find(
          (candidate) => candidate.code === 'MDXF020',
        )
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        const serializedDocument = JSON.stringify(result.document)

        expect(diagnostic).toMatchObject({
          ruleId: 'safe-document/invalid-frontmatter',
          message: 'Frontmatter is invalid.',
          source: 'mdx-forge',
        })
        expect(diagnostic).not.toHaveProperty('data')
        expect(serializedDocument).not.toContain(MDX_DIAGNOSTIC_SECRET)
      }),
    )

    it.effect('keeps invalid compiler output details out of transport errors', () =>
      Effect.gen(function* ()
      {
        const workspaceRoot = yield* makeTempDir
        const frontmatter = Array.from(
          { length: 513 },
          (_, index) => `key_${index}: ${index === 512 ? MDX_SCHEMA_SECRET : index}`,
        )
        const source = ['---', ...frontmatter, '---', '# Too many fields'].join('\n')
        yield* writeFile(workspaceRoot, 'schema-limit.mdx', source)

        const error = yield* readWorkspaceMdxDocument({
          threadId,
          workspaceRoot,
          relativePath: 'schema-limit.mdx',
        }).pipe(Effect.flip)
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        const serializedError = JSON.stringify(error)

        expect(error).toMatchObject({
          _tag: 'ProjectReadMdxDocumentError',
          failure: 'invalid_compiler_output',
        })
        expect(error).not.toHaveProperty('cause')
        expect(serializedError).not.toContain(MDX_SCHEMA_SECRET)
      }),
    )

    it.effect('rejects non-MDX files and files larger than the workspace read boundary', () =>
      Effect.gen(function* ()
      {
        const workspaceRoot = yield* makeTempDir
        yield* writeFile(workspaceRoot, 'notes.md', '# Markdown\n')
        const splitUtf8 = Buffer.concat([Buffer.alloc(1024 * 1024 - 1, 0x61), Buffer.from('💡')])
        yield* writeFile(workspaceRoot, 'large.mdx', splitUtf8)

        const extensionError = yield* readWorkspaceMdxDocument({
          threadId,
          workspaceRoot,
          relativePath: 'notes.md',
        }).pipe(Effect.flip)
        const sizeError = yield* readWorkspaceMdxDocument({
          threadId,
          workspaceRoot,
          relativePath: 'large.mdx',
        }).pipe(Effect.flip)

        expect(extensionError).toMatchObject({
          _tag: 'ProjectReadMdxDocumentError',
          failure: 'unsupported_extension',
        })
        expect(sizeError).toMatchObject({
          _tag: 'ProjectReadMdxDocumentError',
          failure: 'file_too_large',
        })
      }),
    )
  })
})
