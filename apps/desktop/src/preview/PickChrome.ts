// apps/desktop/src/preview/PickChrome.ts
// builds annotation picker overlay chrome and style controls

import type { DesktopPreviewAnnotationTheme, PreviewAnnotationRect } from '@t3tools/contracts'

import { computeLabelPosition } from './PickLabelPosition.ts'
import { describeRawElement, OVERLAY_ATTRIBUTE, rectFromDomRect } from './PickGeometry.ts'

export { OVERLAY_ATTRIBUTE }
export const Z_INDEX_OVERLAY = 2147483646
export const PRIMARY = 'var(--t3-primary)'
export const PRIMARY_FILL = 'color-mix(in srgb, var(--t3-primary) 10%, transparent)'
export const MAX_MARQUEE_ELEMENTS = 20
export const CONTENT_LAYER_Z_INDEX = 1
export const CHROME_LAYER_Z_INDEX = 10

export type AnnotationTool = 'select' | 'marquee' | 'draw' | 'erase'

export interface SelectedElement
{
  id: string
  element: Element
  outline: HTMLDivElement
  label: HTMLDivElement
  baselineStyles: Map<string, string>
}

export interface AnnotationSession
{
  id: string
  teardown: (notifyMain: boolean) => void
  applyTheme: (theme: DesktopPreviewAnnotationTheme) => void
}

export const applyAnnotationTheme = (
  host: HTMLElement,
  theme: DesktopPreviewAnnotationTheme | null,
): void =>
{
  if (!theme) return
  host.style.colorScheme = theme.colorScheme
  const variables = {
    '--t3-radius': theme.radius,
    '--t3-background': theme.background,
    '--t3-foreground': theme.foreground,
    '--t3-popover': theme.popover,
    '--t3-popover-foreground': theme.popoverForeground,
    '--t3-primary': theme.primary,
    '--t3-primary-foreground': theme.primaryForeground,
    '--t3-muted': theme.muted,
    '--t3-muted-foreground': theme.mutedForeground,
    '--t3-accent': theme.accent,
    '--t3-accent-foreground': theme.accentForeground,
    '--t3-border': theme.border,
    '--t3-input': theme.input,
    '--t3-ring': theme.ring,
    '--t3-font-sans': theme.fontSans,
    '--t3-font-mono': theme.fontMono,
  }
  for (const [name, value] of Object.entries(variables))
  {
    host.style.setProperty(name, value)
  }
}

export function createBox(color: string, fill: string): HTMLDivElement
{
  const node = document.createElement('div')
  node.setAttribute(OVERLAY_ATTRIBUTE, '')
  node.style.cssText = [
    'position:fixed',
    'pointer-events:none',
    `border:2px solid ${color}`,
    `background:${fill}`,
    'border-radius:3px',
    'box-sizing:border-box',
    'display:none',
    `z-index:${CONTENT_LAYER_Z_INDEX}`,
  ].join(';')
  return node
}

export function positionBox(node: HTMLElement, rect: PreviewAnnotationRect): void
{
  node.style.display = 'block'
  node.style.transform = `translate(${rect.x}px, ${rect.y}px)`
  node.style.width = `${rect.width}px`
  node.style.height = `${rect.height}px`
}

export function createLabel(): HTMLDivElement
{
  const label = document.createElement('div')
  label.setAttribute(OVERLAY_ATTRIBUTE, '')
  label.className =
    'fixed z-1 max-w-70 overflow-hidden rounded-md bg-primary px-2 py-1 font-sans text-xs font-semibold text-primary-foreground shadow-md'
  label.style.cssText = [
    'position:fixed',
    'pointer-events:none',
    'white-space:nowrap',
    'text-overflow:ellipsis',
    `z-index:${CONTENT_LAYER_Z_INDEX}`,
  ].join(';')
  return label
}

export function updateSelectedVisual(target: SelectedElement): void
{
  if (!target.element.isConnected)
  {
    target.outline.style.display = 'none'
    target.label.style.display = 'none'
    return
  }
  const rect = target.element.getBoundingClientRect()
  positionBox(target.outline, rectFromDomRect(rect))
  target.label.textContent = describeRawElement(target.element)
  target.label.style.display = 'block'
  const labelPosition = computeLabelPosition({
    targetLeft: rect.left,
    targetTop: rect.top,
    targetBottom: rect.bottom,
    labelWidth: target.label.offsetWidth,
    labelHeight: target.label.offsetHeight,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  })
  target.label.style.transform = `translate(${labelPosition.x}px, ${labelPosition.y}px)`
}

export function createButton(label: string, title: string): HTMLButtonElement
{
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  button.title = title
  button.className =
    'inline-flex h-7 cursor-pointer items-center justify-center rounded-md border border-transparent px-2 font-sans text-xs font-medium text-foreground outline-none hover:bg-accent disabled:pointer-events-none disabled:opacity-60'
  return button
}

export function styleControl(input: HTMLInputElement | HTMLSelectElement): void
{
  input.setAttribute('aria-label', input.getAttribute('aria-label') ?? 'Style value')
  input.className =
    'h-7 min-w-0 w-full appearance-none rounded-md border border-input bg-background px-2 font-mono text-xs text-foreground shadow-xs outline-none'
}

export function createUnitControl(input: HTMLInputElement): HTMLElement
{
  const wrapper = document.createElement('div')
  wrapper.style.cssText = 'position:relative;min-width:0'
  const unit = document.createElement('span')
  unit.textContent = input.dataset.unit ?? ''
  unit.className =
    'pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 font-mono text-xs text-muted-foreground'
  wrapper.append(input, unit)
  return wrapper
}

export function createField(
  labelText: string,
  input: HTMLInputElement | HTMLSelectElement,
): HTMLLabelElement
{
  const label = document.createElement('label')
  label.className =
    'grid min-h-7 grid-cols-[82px_minmax(0,1fr)] items-center gap-2 font-sans text-xs font-medium text-muted-foreground'
  const text = document.createElement('span')
  text.textContent = labelText
  styleControl(input)
  label.append(
    text,
    input instanceof HTMLInputElement && input.dataset.unit ? createUnitControl(input) : input,
  )
  return label
}

export function createStyleSection(): HTMLElement
{
  const section = document.createElement('section')
  section.className = 'grid gap-1 border-t border-border py-2'
  return section
}

export function createUnitInput(unit: string, placeholder = '0'): HTMLInputElement
{
  const input = document.createElement('input')
  input.type = 'number'
  input.placeholder = placeholder
  input.style.paddingRight = '30px'
  input.dataset.unit = unit
  return input
}
