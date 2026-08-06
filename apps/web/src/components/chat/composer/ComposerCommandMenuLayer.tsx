// apps/web/src/components/chat/composer/ComposerCommandMenuLayer.tsx
// portals the composer command menu above the editor anchor

import { type ReactNode, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'

export function ComposerCommandMenuLayer(props: {
  anchor: HTMLElement | null
  children: ReactNode
})
{
  const [position, setPosition] = useState<{
    bottom: number
    left: number
    maxHeight: number
    width: number
  } | null>(null)

  useLayoutEffect(() =>
  {
    const anchor = props.anchor
    if (!anchor)
    {
      setPosition(null)
      return
    }

    const updatePosition = () =>
    {
      const rect = anchor.getBoundingClientRect()
      setPosition({
        bottom: window.innerHeight - rect.top + 8,
        left: rect.left,
        maxHeight: Math.max(96, rect.top - 24),
        width: rect.width,
      })
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)

    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updatePosition)
    observer?.observe(anchor)

    return () =>
    {
      observer?.disconnect()
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [props.anchor])

  if (!position) return null

  return createPortal(
    <div
      className="pointer-events-auto fixed z-[70]"
      style={{
        bottom: position.bottom,
        left: position.left,
        maxHeight: position.maxHeight,
        width: position.width,
      }}
    >
      {props.children}
    </div>,
    document.body,
  )
}
