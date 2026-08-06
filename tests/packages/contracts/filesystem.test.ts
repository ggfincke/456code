// tests/packages/contracts/filesystem.test.ts
// verify filesystem browse error behavior

import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vite-plus/test'

import { FilesystemBrowseError } from '../../../packages/contracts/src/filesystem.ts'

describe('FilesystemBrowseError', () =>
{
  it('derives a stable message from browse context while retaining the cause', () =>
  {
    const cause = new Error('sensitive filesystem detail')
    // message construction moved to the server consumers that own the wording;
    // contracts is schema-only and carries whatever message it is given (megacore U-139)
    const error = new FilesystemBrowseError({
      cwd: '/workspace',
      partialPath: './src/mai',
      failure: 'read_directory_failed',
      parentPath: '/workspace/src',
      message: "Failed to browse filesystem path './src/mai' from '/workspace'.",
      cause,
    })

    expect(error.message).toBe("Failed to browse filesystem path './src/mai' from '/workspace'.")
    expect(error.message).not.toContain(cause.message)
    expect(error.cause).toBe(cause)
  })

  it('decodes legacy message-only errors during rolling upgrades', () =>
  {
    const decodeError = Schema.decodeUnknownSync(FilesystemBrowseError)
    const error = decodeError({
      _tag: 'FilesystemBrowseError',
      message: 'Legacy filesystem browse failure.',
    })

    expect(error.message).toBe('Legacy filesystem browse failure.')
    expect(error.partialPath).toBeUndefined()
    expect(error.failure).toBeUndefined()
  })
})
