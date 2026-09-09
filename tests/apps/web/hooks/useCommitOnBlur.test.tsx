// tests/apps/web/hooks/useCommitOnBlur.test.tsx
// preserve input method composition before committing a settings field

// @vitest-environment happy-dom

import { act, useLayoutEffect, type ChangeEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vite-plus/test'

import { useCommitOnBlur } from '../../../../apps/web/src/hooks/useCommitOnBlur'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

it('keeps IME confirmation focused and commits the completed draft only on normal Enter', async () =>
{
  const commit = vi.fn()
  let props: ReturnType<typeof useCommitOnBlur> | undefined
  function Harness()
  {
    const inputProps = useCommitOnBlur('old', commit)
    useLayoutEffect(() =>
    {
      props = inputProps
    }, [inputProps])
    return <input aria-label="Provider name" {...inputProps} />
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try
  {
    await act(async () => root.render(<Harness />))
    const input = container.querySelector('input')!
    await act(async () => input.focus())
    await act(async () =>
      props?.onChange({ target: { value: '日本語' } } as ChangeEvent<HTMLInputElement>),
    )
    for (const init of [{ isComposing: true }, { keyCode: 229 }])
    {
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
        ...init,
      })
      await act(async () =>
      {
        input.dispatchEvent(event)
      })
      expect(event.defaultPrevented).toBe(false)
      expect(document.activeElement).toBe(input)
      expect(commit).not.toHaveBeenCalled()
    }
    await act(async () =>
    {
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      )
    })
    expect(document.activeElement).not.toBe(input)
    expect(commit).toHaveBeenCalledExactlyOnceWith('日本語')
  }
  finally
  {
    await act(async () => root.unmount())
    container.remove()
  }
})
