// packages/contracts/src/architecturePath.ts
// leaf posix relative-path schema and blast-path list bound

import * as Schema from 'effect/Schema'

export const ARCHITECTURE_BLAST_PATH_LIMIT = 400
export const ARCHITECTURE_RELATIVE_PATH_MAX_LENGTH = 1_024

export const ArchitectureRelativePath = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(ARCHITECTURE_RELATIVE_PATH_MAX_LENGTH),
  Schema.makeFilter((value) =>
  {
    if (value.startsWith('/') || value.includes('\\'))
    {
      return 'Architecture source paths must be repository-relative POSIX paths.'
    }
    if (value.includes('\u0000'))
    {
      return 'Architecture source paths must not contain NUL bytes.'
    }
    return value
      .split('/')
      .every((segment) => segment !== '' && segment !== '.' && segment !== '..')
      ? true
      : 'Architecture source paths must not contain empty, dot, or parent segments.'
  }),
)
export type ArchitectureRelativePath = typeof ArchitectureRelativePath.Type
