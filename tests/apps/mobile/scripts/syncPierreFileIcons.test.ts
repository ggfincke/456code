// tests/apps/mobile/scripts/syncPierreFileIcons.test.ts
// verifies pierre icon drift checks and failure-safe pair publication

import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'

import { describe, expect, it } from 'vite-plus/test'

import {
  PIERRE_CUSTOM_FILE_ICON_BY_FILE_NAME,
  PIERRE_MOBILE_CUSTOM_ICON_BY_TOKEN,
} from '@t3tools/shared/pierreFileIcons'
import {
  publishStagedOutputs,
  recoverInterruptedPublication,
  validatePierreIconCatalog,
  verifyGeneratedOutputContract,
} from '../../../../apps/mobile/modules/code456-markdown-text/scripts/sync-pierre-file-icons.mjs'

function withTemporaryDirectory(run: (directory: string) => void): void
{
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'pierre-icons-test-'))
  try
  {
    run(directory)
  }
  finally
  {
    NodeFS.rmSync(directory, { recursive: true, force: true })
  }
}

function recoveryRecord(
  targetOutputDirectory: string,
  targetGeneratedModulePath: string,
  phase: string,
)
{
  return {
    version: 1,
    outputDirectory: targetOutputDirectory,
    generatedModulePath: targetGeneratedModulePath,
    stagedOutputDirectory: NodePath.join(
      NodePath.dirname(targetOutputDirectory),
      '.pierre-file-icons.stage',
    ),
    stagedGeneratedModulePath: NodePath.join(
      NodePath.dirname(targetGeneratedModulePath),
      '.markdownFileIcons.generated.ts.stage',
    ),
    backupOutputDirectory: NodePath.join(
      NodePath.dirname(targetOutputDirectory),
      '.pierre-file-icons.backup',
    ),
    backupGeneratedModulePath: NodePath.join(
      NodePath.dirname(targetGeneratedModulePath),
      '.markdownFileIcons.generated.ts.backup',
    ),
    phase,
  }
}

describe('Pierre icon generation contract', () =>
{
  it('rejects catalog references to missing custom symbols', () =>
  {
    expect(() =>
      validatePierreIconCatalog({
        customSprite: '<svg><symbol id="known"></symbol></svg>',
        byFileName: PIERRE_CUSTOM_FILE_ICON_BY_FILE_NAME,
        mobileCustomIcons: PIERRE_MOBILE_CUSTOM_ICON_BY_TOKEN,
      }),
    ).toThrow('references missing symbol')
  })

  it('detects generated manifest drift without changing the output', () =>
  {
    withTemporaryDirectory((directory) =>
    {
      const output = NodePath.join(directory, 'file-icons')
      const generatedModule = NodePath.join(directory, 'markdownFileIcons.generated.ts')
      NodeFS.mkdirSync(output)
      NodeFS.writeFileSync(NodePath.join(output, 'pierre_one.png'), 'one')
      NodeFS.writeFileSync(generatedModule, 'generated\n')

      verifyGeneratedOutputContract({
        targetOutputDirectory: output,
        targetGeneratedModulePath: generatedModule,
        expectedPngFileNames: ['pierre_one.png'],
        expectedGeneratedSource: 'generated\n',
        expectedPngSnapshot: undefined,
      })

      NodeFS.writeFileSync(NodePath.join(output, 'unexpected.png'), 'unexpected')
      expect(() =>
        verifyGeneratedOutputContract({
          targetOutputDirectory: output,
          targetGeneratedModulePath: generatedModule,
          expectedPngFileNames: ['pierre_one.png'],
          expectedGeneratedSource: 'generated\n',
          expectedPngSnapshot: undefined,
        }),
      ).toThrow('Pierre icon manifest drift')
      expect(NodeFS.readFileSync(NodePath.join(output, 'pierre_one.png'), 'utf8')).toBe('one')
    })
  })

  it('restores both old targets after failure between pair publications', () =>
  {
    withTemporaryDirectory((directory) =>
    {
      const sourceOutput = NodePath.join(directory, 'source/file-icons')
      const sourceModule = NodePath.join(directory, 'source/markdownFileIcons.generated.ts')
      const targetOutput = NodePath.join(directory, 'target/assets/file-icons')
      const targetModule = NodePath.join(directory, 'target/src/markdownFileIcons.generated.ts')
      const marker = NodePath.join(directory, 'target/.pierre-file-icons-recovery.json')
      const expectedFileNames = ['pierre_one.png']

      NodeFS.mkdirSync(sourceOutput, { recursive: true })
      NodeFS.mkdirSync(targetOutput, { recursive: true })
      NodeFS.mkdirSync(NodePath.dirname(targetModule), { recursive: true })
      NodeFS.writeFileSync(NodePath.join(sourceOutput, 'pierre_one.png'), 'new png')
      NodeFS.writeFileSync(sourceModule, 'new module\n')
      NodeFS.writeFileSync(NodePath.join(targetOutput, 'pierre_one.png'), 'old png')
      NodeFS.writeFileSync(targetModule, 'old module\n')

      expect(() =>
        publishStagedOutputs({
          sourceOutputDirectory: sourceOutput,
          sourceGeneratedModulePath: sourceModule,
          targetOutputDirectory: targetOutput,
          targetGeneratedModulePath: targetModule,
          markerPath: marker,
          expectedPngFileNames: expectedFileNames,
          expectedGeneratedSource: 'invalid staged module\n',
          failurePoint: undefined,
        }),
      ).toThrow('Staged Pierre generated module is invalid')
      expect(NodeFS.readFileSync(NodePath.join(targetOutput, 'pierre_one.png'), 'utf8')).toBe(
        'old png',
      )
      expect(NodeFS.readFileSync(targetModule, 'utf8')).toBe('old module\n')
      expect(NodeFS.existsSync(marker)).toBe(false)

      expect(() =>
        publishStagedOutputs({
          sourceOutputDirectory: sourceOutput,
          sourceGeneratedModulePath: sourceModule,
          targetOutputDirectory: targetOutput,
          targetGeneratedModulePath: targetModule,
          markerPath: marker,
          expectedPngFileNames: expectedFileNames,
          expectedGeneratedSource: 'new module\n',
          failurePoint: 'after-icons',
        }),
      ).toThrow('Injected failure after Pierre icon publication')

      expect(NodeFS.readFileSync(NodePath.join(targetOutput, 'pierre_one.png'), 'utf8')).toBe(
        'old png',
      )
      expect(NodeFS.readFileSync(targetModule, 'utf8')).toBe('old module\n')
      expect(NodeFS.existsSync(marker)).toBe(false)
      expect(NodeFS.readdirSync(NodePath.join(directory, 'target/assets'))).toEqual(['file-icons'])
      expect(NodeFS.readdirSync(NodePath.join(directory, 'target/src'))).toEqual([
        'markdownFileIcons.generated.ts',
      ])
    })
  })

  it('resolves recovery markers on either side of the commit point', () =>
  {
    withTemporaryDirectory((directory) =>
    {
      const interruptedRoot = NodePath.join(directory, 'interrupted')
      const interruptedOutput = NodePath.join(interruptedRoot, 'assets/file-icons')
      const interruptedModule = NodePath.join(interruptedRoot, 'src/markdownFileIcons.generated.ts')
      const interruptedMarker = NodePath.join(interruptedRoot, '.pierre-file-icons-recovery.json')
      const interrupted = recoveryRecord(interruptedOutput, interruptedModule, 'icons-published')
      NodeFS.mkdirSync(interruptedOutput, { recursive: true })
      NodeFS.mkdirSync(interrupted.backupOutputDirectory, { recursive: true })
      NodeFS.mkdirSync(NodePath.dirname(interruptedModule), { recursive: true })
      NodeFS.writeFileSync(NodePath.join(interruptedOutput, 'pierre_one.png'), 'new png')
      NodeFS.writeFileSync(
        NodePath.join(interrupted.backupOutputDirectory, 'pierre_one.png'),
        'old png',
      )
      NodeFS.writeFileSync(interruptedModule, 'old module\n')
      NodeFS.writeFileSync(interrupted.stagedGeneratedModulePath, 'new module\n')
      NodeFS.writeFileSync(interruptedMarker, JSON.stringify(interrupted))

      expect(
        recoverInterruptedPublication({
          targetOutputDirectory: interruptedOutput,
          targetGeneratedModulePath: interruptedModule,
          markerPath: interruptedMarker,
        }),
      ).toBe('rolled-back')
      expect(NodeFS.readFileSync(NodePath.join(interruptedOutput, 'pierre_one.png'), 'utf8')).toBe(
        'old png',
      )
      expect(NodeFS.readFileSync(interruptedModule, 'utf8')).toBe('old module\n')
      expect(NodeFS.existsSync(interruptedMarker)).toBe(false)

      const committedRoot = NodePath.join(directory, 'committed')
      const committedOutput = NodePath.join(committedRoot, 'assets/file-icons')
      const committedModule = NodePath.join(committedRoot, 'src/markdownFileIcons.generated.ts')
      const committedMarker = NodePath.join(committedRoot, '.pierre-file-icons-recovery.json')
      const committed = recoveryRecord(committedOutput, committedModule, 'committed')
      NodeFS.mkdirSync(committedOutput, { recursive: true })
      NodeFS.mkdirSync(committed.backupOutputDirectory, { recursive: true })
      NodeFS.mkdirSync(NodePath.dirname(committedModule), { recursive: true })
      NodeFS.writeFileSync(NodePath.join(committedOutput, 'pierre_one.png'), 'new png')
      NodeFS.writeFileSync(
        NodePath.join(committed.backupOutputDirectory, 'pierre_one.png'),
        'old png',
      )
      NodeFS.writeFileSync(committedModule, 'new module\n')
      NodeFS.writeFileSync(committed.backupGeneratedModulePath, 'old module\n')
      NodeFS.writeFileSync(committedMarker, JSON.stringify(committed))

      expect(
        recoverInterruptedPublication({
          targetOutputDirectory: committedOutput,
          targetGeneratedModulePath: committedModule,
          markerPath: committedMarker,
        }),
      ).toBe('committed')
      expect(NodeFS.readFileSync(NodePath.join(committedOutput, 'pierre_one.png'), 'utf8')).toBe(
        'new png',
      )
      expect(NodeFS.readFileSync(committedModule, 'utf8')).toBe('new module\n')
      expect(NodeFS.existsSync(committedMarker)).toBe(false)
      expect(NodeFS.existsSync(committed.backupOutputDirectory)).toBe(false)
      expect(NodeFS.existsSync(committed.backupGeneratedModulePath)).toBe(false)
    })
  })
})
