import { describe, expect, it } from 'vite-plus/test'

import { fileContentRevision } from '../../../../../apps/web/src/components/files/fileContentRevision'

describe('fileContentRevision', () =>
{
  it('changes for same-length edits', () =>
  {
    expect(fileContentRevision('nodeVersion')).not.toBe(fileContentRevision('nodeVeasdrs'))
  })
})
