// tests/apps/web/hooks/useThreadActions.test.ts
// verifies optional unpin confirmation decisions and failures

import { describe, expect, it, vi } from 'vite-plus/test'

import { requestThreadUnpinConfirmation } from '../../../../apps/web/src/hooks/useThreadActions'

describe('requestThreadUnpinConfirmation', () =>
{
  it('does not ask when confirmation is disabled', async () =>
  {
    const confirm = vi.fn(async () => false)
    expect(
      await requestThreadUnpinConfirmation({ enabled: false, title: 'Pinned', confirm }),
    ).toMatchObject({ _tag: 'Success', value: true })
    expect(confirm).not.toHaveBeenCalled()
  })

  it('proceeds when no confirmation dialog is available', async () =>
  {
    expect(
      await requestThreadUnpinConfirmation({ enabled: true, title: 'Pinned', confirm: null }),
    ).toMatchObject({ _tag: 'Success', value: true })
  })

  it.each([true, false])('returns the accepted or cancelled decision: %s', async (accepted) =>
  {
    const confirm = vi.fn(async () => accepted)
    const result = await requestThreadUnpinConfirmation({
      enabled: true,
      title: 'Release prep',
      confirm,
    })

    expect(confirm).toHaveBeenCalledWith(
      'Unpin thread "Release prep"?\nThis will move the thread out of your pinned section.',
    )
    expect(result).toMatchObject({ _tag: 'Success', value: accepted })
  })

  it('keeps dialog failures observable by the action caller', async () =>
  {
    const result = await requestThreadUnpinConfirmation({
      enabled: true,
      title: 'Pinned',
      confirm: () => Promise.reject(new Error('dialog unavailable')),
    })

    expect(result._tag).toBe('Failure')
  })
})
