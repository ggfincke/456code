import { describe, expect, it } from 'vite-plus/test'

import { fileBreadcrumbs } from '../../../../../apps/web/src/components/files/filePath'

describe('fileBreadcrumbs', () =>
{
  it('builds project, directory, and file crumbs and normalizes separators', () =>
  {
    expect(fileBreadcrumbs('t3code', 'apps/web/src/main.tsx')).toEqual([
      { label: 't3code', path: '', kind: 'project' },
      { label: 'apps', path: 'apps', kind: 'directory' },
      { label: 'web', path: 'apps/web', kind: 'directory' },
      { label: 'src', path: 'apps/web/src', kind: 'directory' },
      { label: 'main.tsx', path: 'apps/web/src/main.tsx', kind: 'file' },
    ])
    expect(fileBreadcrumbs('workspace', '/src//index.ts').map((crumb) => crumb.label)).toEqual([
      'workspace',
      'src',
      'index.ts',
    ])
  })
})
