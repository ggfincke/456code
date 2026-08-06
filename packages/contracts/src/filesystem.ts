// packages/contracts/src/filesystem.ts
// define filesystem contracts

import * as Schema from 'effect/Schema'
import { TrimmedNonEmptyString } from './baseSchemas.ts'

const FILESYSTEM_PATH_MAX_LENGTH = 512

export const FilesystemBrowseInput = Schema.Struct({
  partialPath: TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH)),
  cwd: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH))),
})
export type FilesystemBrowseInput = typeof FilesystemBrowseInput.Type

export const FilesystemBrowseEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  fullPath: TrimmedNonEmptyString,
})
export type FilesystemBrowseEntry = typeof FilesystemBrowseEntry.Type

export const FilesystemBrowseResult = Schema.Struct({
  parentPath: TrimmedNonEmptyString,
  entries: Schema.Array(FilesystemBrowseEntry),
})
export type FilesystemBrowseResult = typeof FilesystemBrowseResult.Type

export const FilesystemBrowseFailure = Schema.Literals([
  'windows_path_unsupported',
  'current_project_required',
  'read_directory_failed',
])
export type FilesystemBrowseFailure = typeof FilesystemBrowseFailure.Type

export class FilesystemBrowseError extends Schema.TaggedErrorClass<FilesystemBrowseError>()(
  'FilesystemBrowseError',
  {
    partialPath: Schema.optional(TrimmedNonEmptyString),
    cwd: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(FilesystemBrowseFailure),
    parentPath: Schema.optional(TrimmedNonEmptyString),
    platform: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
)
{}
