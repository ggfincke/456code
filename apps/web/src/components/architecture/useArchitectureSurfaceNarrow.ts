// apps/web/src/components/architecture/useArchitectureSurfaceNarrow.ts
// observes a native architecture resource so its details can become a narrow sheet

import { useEffect, useState, type RefCallback } from 'react'

const NARROW_ARCHITECTURE_SURFACE_WIDTH = 640

export function useArchitectureSurfaceNarrow<T extends HTMLElement = HTMLDivElement>(
  narrowOverride?: boolean,
): readonly [RefCallback<T>, boolean]
{
  const [element, setElement] = useState<T | null>(null)
  const [measuredNarrow, setMeasuredNarrow] = useState(false)

  useEffect(() =>
  {
    if (element === null || narrowOverride !== undefined) return

    const update = (width: number): void =>
      setMeasuredNarrow(width < NARROW_ARCHITECTURE_SURFACE_WIDTH)
    update(element.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver((entries) =>
    {
      const entry = entries[0]
      if (entry !== undefined) update(entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [element, narrowOverride])

  return [setElement, narrowOverride ?? measuredNarrow]
}
