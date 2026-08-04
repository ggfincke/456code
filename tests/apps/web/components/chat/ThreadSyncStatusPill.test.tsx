// tests/apps/web/components/chat/ThreadSyncStatusPill.test.tsx
// covers thread synchronization status rendering

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vite-plus/test'

import { ThreadSyncStatusPill } from '../../../../../apps/web/src/components/chat/ThreadSyncStatusPill'

describe('ThreadSyncStatusPill', () =>
{
  it('renders with role="status"', () =>
  {
    const markup = renderToStaticMarkup(<ThreadSyncStatusPill phase="loading" />)

    expect(markup).toContain('role="status"')
  })
})
