// apps/web/src/themePalette.ts
// derive bounded palettes and apply known role colors to the web client

import 'culori/css'
import { converter, parse } from 'culori/fn'

import {
  THEME_COLOR_ROLES,
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemeColors,
} from '@t3tools/shared/themePalettes'

const T3_CODE_LIGHT_THEME_COLORS: ThemeColors = {
  canvas: '#fcfcfc',
  chrome: '#fcfcfc',
  toolbar: '#fcfcfc',
  toolbarForeground: '#27272a',
  toolbarBorder: '#e4e4e7',
  toolbarControl: '#ffffff',
  toolbarControlForeground: '#27272a',
  toolbarControlHover: '#f4f4f5',
  surface: '#ffffff',
  surfaceRaised: '#fcfcfc',
  surfaceOverlay: '#ffffff',
  text: '#27272a',
  textMuted: '#71717b',
  border: '#e4e4e7',
  input: '#d4d4d8',
  focus: '#1b4ed8',
  accent: '#1b4ed8',
  accentForeground: '#ffffff',
  secondary: '#fafafa',
  secondaryForeground: '#27272a',
  muted: '#fafafa',
  mutedForeground: '#71717b',
  placeholder: '#71717b',
  secondaryLabel: '#71717b',
  iconMuted: '#71717b',
  error: '#fb2c36',
  errorForeground: '#c10007',
  errorSurface: '#fcebec',
  warning: '#fe9a00',
  warningForeground: '#bb4d00',
  warningSurface: '#fcf4e8',
  update: '#1b4ed8',
  updateForeground: '#1b4ed8',
  updateSurface: '#e0e6f7',
  accentSurface: '#f4f4f5',
  accentSurfaceForeground: '#18181b',
  messageSurface: '#f4f4f5',
  messageForeground: '#27272a',
  messageAction: '#1b4ed8',
  messageActionForeground: '#ffffff',
  messageActionHover: '#3160db',
  codeBackground: '#ffffff',
  codeForeground: '#27272a',
  sidebar: '#fafafa',
  sidebarForeground: '#27272a',
  sidebarMutedForeground: '#71717b',
  sidebarControlSurface: '#f4f4f5',
  sidebarRowHover: '#fcfcfc',
  sidebarRowActive: '#ffffff',
  sidebarRowSelected: '#ffffff',
  sidebarBorder: '#e4e4e7',
  terminalBackground: '#fcfcfc',
  terminalForeground: '#27272a',
  terminalCursor: '#26384e',
  terminalSelection: '#d0d6dd',
  terminalScrollbar: '#d6d6d6',
  terminalScrollbarHover: '#bdbdbd',
}
const T3_CODE_DARK_THEME_COLORS: ThemeColors = {
  canvas: '#0a0a0a',
  chrome: '#0a0a0a',
  toolbar: '#0a0a0a',
  toolbarForeground: '#f5f5f5',
  toolbarBorder: '#191919',
  toolbarControl: '#191919',
  toolbarControlForeground: '#f5f5f5',
  toolbarControlHover: '#141414',
  surface: '#111111',
  surfaceRaised: '#141414',
  surfaceOverlay: '#191919',
  text: '#f5f5f5',
  textMuted: '#818181',
  border: '#191919',
  input: '#1e1e1e',
  focus: '#366ffb',
  accent: '#366ffb',
  accentForeground: '#ffffff',
  secondary: '#141414',
  secondaryForeground: '#f5f5f5',
  muted: '#141414',
  mutedForeground: '#818181',
  placeholder: '#818181',
  secondaryLabel: '#818181',
  iconMuted: '#818181',
  error: '#fb414a',
  errorForeground: '#ff6467',
  errorSurface: '#301214',
  warning: '#fe9a00',
  warningForeground: '#ffb900',
  warningSurface: '#312108',
  update: '#366ffb',
  updateForeground: '#366ffb',
  updateSurface: '#121c35',
  accentSurface: '#141414',
  accentSurfaceForeground: '#f5f5f5',
  messageSurface: '#141414',
  messageForeground: '#f5f5f5',
  messageAction: '#366ffb',
  messageActionForeground: '#ffffff',
  messageActionHover: '#3265e3',
  codeBackground: '#111111',
  codeForeground: '#f5f5f5',
  sidebar: '#000000',
  sidebarForeground: '#f1f3f7',
  sidebarMutedForeground: '#a3a3a3',
  sidebarControlSurface: '#0a0a0a',
  sidebarRowHover: '#131313',
  sidebarRowActive: '#1a1b1b',
  sidebarRowSelected: '#111111',
  sidebarBorder: '#141414',
  terminalBackground: '#0a0a0a',
  terminalForeground: '#f5f5f5',
  terminalCursor: '#b4cbff',
  terminalSelection: '#343a47',
  terminalScrollbar: '#222222',
  terminalScrollbarHover: '#363636',
}

export function getStandardThemeColors(appearance: ThemeAppearance): ThemeColors
{
  const colors = appearance === 'dark' ? T3_CODE_DARK_THEME_COLORS : T3_CODE_LIGHT_THEME_COLORS
  return Object.fromEntries(
    THEME_COLOR_ROLES.map((role) => [role, toCanonicalThemeColor(colors[role])!]),
  ) as Record<ThemeColorRole, string>
}

type ThemeRgbColor = { r: number; g: number; b: number }
type ThemeOklch = { L: number; C: number; h: number }
const THEME_LIGHT_FOREGROUND: ThemeRgbColor = { r: 245, g: 245, b: 245 }
const THEME_DARK_FOREGROUND: ThemeRgbColor = { r: 39, g: 39, b: 42 }
const THEME_WHITE_FOREGROUND: ThemeRgbColor = { r: 255, g: 255, b: 255 }
const THEME_BLACK_FOREGROUND: ThemeRgbColor = { r: 0, g: 0, b: 0 }
const STANDARD_LIGHT_MUTED_CONTRAST = 4.705
const STANDARD_DARK_MUTED_CONTRAST = 5.082
const STANDARD_STATUS_COLORS = {
  light: {
    error: '#fb2c36',
    errorForeground: '#c10007',
    warning: '#fe9a00',
    warningForeground: '#bb4d00',
  },
  dark: {
    error: '#fb414a',
    errorForeground: '#ff6467',
    warning: '#fe9a00',
    warningForeground: '#ffb900',
  },
} as const

type ParsedThemeColor = { color: ThemeOklch; alpha: number }
const convertToOklch = converter('oklch')

function parseThemeColor(value: unknown): ParsedThemeColor | null
{
  if (typeof value !== 'string' || value.length > 64) return null
  const input = value.trim()
  const parsed = parse(input)
  if (!parsed) return null
  const color = convertToOklch(parsed)
  const lightness = color.l ?? 0
  const chroma = color.c ?? 0
  const hue = color.h ?? 0
  const alpha = /\/\s*none\s*\)$/i.test(input) ? 0 : (color.alpha ?? 1)
  if (![lightness, chroma, hue, alpha].every(Number.isFinite)) return null
  return {
    color: {
      L: Math.min(1, Math.max(0, lightness)),
      C: Math.max(0, chroma),
      h: ((hue % 360) + 360) % 360,
    },
    alpha: Math.min(1, Math.max(0, alpha)),
  }
}

function formatThemeColorNumber(value: number, precision: number): string
{
  const rounded = Math.abs(value) < 10 ** -precision / 2 ? 0 : value
  return rounded.toFixed(precision).replace(/(?:\.0+|(?:(\.[0-9]*?)0+))$/, '$1')
}

function formatOklchThemeColor(color: ThemeOklch, alpha = 1): string
{
  const normalizedHue = color.C < 0.0000005 ? 0 : ((color.h % 360) + 360) % 360
  const body = `${formatThemeColorNumber(color.L, 6)} ${formatThemeColorNumber(color.C, 6)} ${formatThemeColorNumber(normalizedHue, 3)}`
  return alpha < 1 ? `oklch(${body} / ${formatThemeColorNumber(alpha, 4)})` : `oklch(${body})`
}

function themeRgbToThemeColor(color: ThemeRgbColor): string
{
  return formatOklchThemeColor(themeRgbToOklch(color))
}

function themeOklchToThemeColor(color: ThemeOklch): string
{
  return themeRgbToThemeColor(themeOklchToRgb(color))
}

export function toCanonicalThemeColor(value: unknown): string | null
{
  const parsed = parseThemeColor(value)
  return parsed ? formatOklchThemeColor(parsed.color, parsed.alpha) : null
}

function parseThemeRgbColor(value: string, fallback: ThemeRgbColor): ThemeRgbColor
{
  const parsed = parseThemeColor(value)
  return parsed ? themeOklchToRgb(parsed.color) : fallback
}

function mixThemeRgbColors(
  base: ThemeRgbColor,
  overlay: ThemeRgbColor,
  amount: number,
): ThemeRgbColor
{
  return {
    r: base.r + (overlay.r - base.r) * amount,
    g: base.g + (overlay.g - base.g) * amount,
    b: base.b + (overlay.b - base.b) * amount,
  }
}

function themeRelativeLuminance(color: ThemeRgbColor): number
{
  const linearize = (channel: number) =>
  {
    const normalized = channel / 255
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  }

  return 0.2126 * linearize(color.r) + 0.7152 * linearize(color.g) + 0.0722 * linearize(color.b)
}

function srgbChannelToLinear(channel: number): number
{
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function linearChannelToSrgb(channel: number): number
{
  const c = channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055
  return Math.round(Math.min(1, Math.max(0, c)) * 255)
}

function themeRgbToOklch(color: ThemeRgbColor): ThemeOklch
{
  const r = srgbChannelToLinear(color.r)
  const g = srgbChannelToLinear(color.g)
  const b = srgbChannelToLinear(color.b)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return { L, C: Math.hypot(a, bb), h: (Math.atan2(bb, a) * 180) / Math.PI }
}

function oklchToRgbUnclamped({ L, C, h }: ThemeOklch): { r: number; g: number; b: number }
{
  const hr = (h * Math.PI) / 180
  const a = C * Math.cos(hr)
  const bb = C * Math.sin(hr)
  const l = (L + 0.3963377774 * a + 0.2158037573 * bb) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * bb) ** 3
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  }
}

function themeOklchToRgb(color: ThemeOklch): ThemeRgbColor
{
  let { C } = color
  for (let step = 0; step < 12; step += 1)
  {
    const linear = oklchToRgbUnclamped({ ...color, C })
    const inGamut = [linear.r, linear.g, linear.b].every(
      (channel) => channel >= -0.0001 && channel <= 1.0001,
    )
    if (inGamut)
    {
      return {
        r: linearChannelToSrgb(linear.r),
        g: linearChannelToSrgb(linear.g),
        b: linearChannelToSrgb(linear.b),
      }
    }
    C *= 0.82
  }
  const linear = oklchToRgbUnclamped({ ...color, C: 0 })
  return {
    r: linearChannelToSrgb(linear.r),
    g: linearChannelToSrgb(linear.g),
    b: linearChannelToSrgb(linear.b),
  }
}

function solveOklchLightness(
  base: ThemeOklch,
  against: ThemeRgbColor,
  minContrast: number,
  direction: 'lighter' | 'darker',
): ThemeOklch
{
  let low = direction === 'lighter' ? base.L : 0
  let high = direction === 'lighter' ? 1 : base.L
  let candidate = { ...base }
  if (themeContrastRatio(themeOklchToRgb(candidate), against) >= minContrast) return candidate
  for (let step = 0; step < 18; step += 1)
  {
    const mid = (low + high) / 2
    candidate = { ...base, L: mid }
    const contrast = themeContrastRatio(themeOklchToRgb(candidate), against)
    if (contrast >= minContrast)
    {
      if (direction === 'lighter') high = mid
      else low = mid
    }
    else
    {
      if (direction === 'lighter') low = mid
      else high = mid
    }
  }
  return { ...base, L: direction === 'lighter' ? high : low }
}

function standardStatusColors(canvas: ThemeRgbColor): {
  error: string
  errorForeground: string
  errorSurface: string
  warning: string
  warningForeground: string
  warningSurface: string
}
{
  const appearance: ThemeAppearance = themeRelativeLuminance(canvas) < 0.179 ? 'dark' : 'light'
  const standard = STANDARD_STATUS_COLORS[appearance]
  const surfaceMix = appearance === 'dark' ? 0.16 : 0.08
  const surfaceOf = (value: string) =>
    mixThemeRgbColors(canvas, parseThemeRgbColor(value, canvas), surfaceMix)
  const readableOn = (foreground: string, surface: ThemeRgbColor) =>
    themeOklchToThemeColor(
      solveOklchLightness(
        themeRgbToOklch(parseThemeRgbColor(foreground, canvas)),
        surface,
        4.6,
        appearance === 'dark' ? 'lighter' : 'darker',
      ),
    )
  const errorSurface = surfaceOf(standard.error)
  const warningSurface = surfaceOf(standard.warning)
  return {
    error: toCanonicalThemeColor(standard.error)!,
    errorForeground: readableOn(standard.errorForeground, errorSurface),
    errorSurface: themeRgbToThemeColor(errorSurface),
    warning: toCanonicalThemeColor(standard.warning)!,
    warningForeground: readableOn(standard.warningForeground, warningSurface),
    warningSurface: themeRgbToThemeColor(warningSurface),
  }
}

function themeContrastRatio(first: ThemeRgbColor, second: ThemeRgbColor): number
{
  const firstLuminance = themeRelativeLuminance(first)
  const secondLuminance = themeRelativeLuminance(second)
  const lighter = Math.max(firstLuminance, secondLuminance)
  const darker = Math.min(firstLuminance, secondLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

function readableThemeForeground(background: ThemeRgbColor): ThemeRgbColor
{
  const lightContrast = themeContrastRatio(background, THEME_LIGHT_FOREGROUND)
  const darkContrast = themeContrastRatio(background, THEME_DARK_FOREGROUND)
  if (Math.max(lightContrast, darkContrast) >= 4.5)
  {
    return lightContrast >= darkContrast ? THEME_LIGHT_FOREGROUND : THEME_DARK_FOREGROUND
  }

  return themeContrastRatio(background, THEME_WHITE_FOREGROUND) >=
    themeContrastRatio(background, THEME_BLACK_FOREGROUND)
    ? THEME_WHITE_FOREGROUND
    : THEME_BLACK_FOREGROUND
}

function readableThemeText(
  background: ThemeRgbColor,
  foreground: ThemeRgbColor,
  amount: number,
  minimumRatio: number,
): ThemeRgbColor
{
  const softened = mixThemeRgbColors(foreground, background, amount)
  if (themeContrastRatio(softened, background) >= minimumRatio) return softened
  let readable = foreground
  let lowerAmount = 0
  let upperAmount = amount
  for (let index = 0; index < 12; index += 1)
  {
    const candidateAmount = (lowerAmount + upperAmount) / 2
    const candidate = mixThemeRgbColors(foreground, background, candidateAmount)
    if (themeContrastRatio(candidate, background) >= minimumRatio)
    {
      readable = candidate
      lowerAmount = candidateAmount
    }
    else
    {
      upperAmount = candidateAmount
    }
  }
  return readable
}

function standardMutedThemeText(
  background: ThemeRgbColor,
  foreground: ThemeRgbColor,
): ThemeRgbColor
{
  const target =
    themeRelativeLuminance(background) < 0.179
      ? STANDARD_DARK_MUTED_CONTRAST
      : STANDARD_LIGHT_MUTED_CONTRAST
  return readableThemeText(background, foreground, 1, target)
}

// preserve both seeds while deriving a contrast-solved OKLCH surface ramp
export function createManagedThemeColors(
  appearance: ThemeAppearance,
  backgroundValue: string,
  accentValue: string,
): ThemeColors
{
  const defaults = getStandardThemeColors(appearance)
  const canvasRgb = parseThemeRgbColor(
    backgroundValue,
    appearance === 'dark' ? { r: 10, g: 10, b: 10 } : { r: 252, g: 252, b: 252 },
  )
  const accentRgb = parseThemeRgbColor(
    accentValue,
    parseThemeRgbColor(defaults.accent, { r: 27, g: 78, b: 216 }),
  )
  const canvas = themeRgbToOklch(canvasRgb)
  const accent = themeRgbToOklch(accentRgb)
  const dark = themeRelativeLuminance(canvasRgb) < 0.179
  const hue = accent.C < 0.02 ? canvas.h : accent.h
  const tintC = Math.min(0.045, Math.max(0.008, accent.C * 0.22))
  const step = dark ? 1 : -1

  const surfaceAt = (deltaL: number, chroma = tintC): ThemeOklch => ({
    L: Math.min(0.98, Math.max(0.05, canvas.L + step * deltaL)),
    C: chroma,
    h: hue,
  })
  const themeColor = (color: ThemeOklch) => themeOklchToThemeColor(color)

  const textBase: ThemeOklch = {
    L: dark ? 0.95 : 0.2,
    C: Math.min(0.035, accent.C * 0.25),
    h: hue,
  }
  const text = solveOklchLightness(textBase, canvasRgb, 7, dark ? 'lighter' : 'darker')
  const textRgb = themeOklchToRgb(text)
  const textMutedRgb = standardMutedThemeText(canvasRgb, textRgb)

  const action: ThemeOklch = {
    L: Math.min(0.85, Math.max(0.35, accent.L + (dark ? 0.06 : -0.02))),
    C: Math.max(accent.C * 0.9, 0.06),
    h: (hue + 50) % 360,
  }
  const actionRgb = themeOklchToRgb(action)
  const actionForeground = readableThemeForeground(actionRgb)
  const accentForeground = readableThemeForeground(accentRgb)

  const sidebar = surfaceAt(0.045, tintC * 1.4)
  const sidebarRgb = themeOklchToRgb(sidebar)
  const surface = surfaceAt(0.015)
  const surfaceRaised = surfaceAt(0.05)
  const surfaceRaisedRgb = themeOklchToRgb(surfaceRaised)
  const surfaceOverlay = surfaceAt(0.075)
  const border = surfaceAt(dark ? 0.16 : 0.12, Math.min(0.07, accent.C * 0.35))
  const input = surfaceAt(dark ? 0.21 : 0.16, Math.min(0.08, accent.C * 0.4))
  const secondary = surfaceAt(dark ? 0.1 : 0.06, Math.min(0.09, accent.C * 0.5))
  const secondaryRgb = themeOklchToRgb(secondary)
  const muted = surfaceAt(dark ? 0.06 : 0.04, Math.min(0.06, accent.C * 0.35))
  const mutedRgb = themeOklchToRgb(muted)
  const accentSurface = surfaceAt(dark ? 0.13 : 0.08, Math.min(0.11, accent.C * 0.55))
  const accentSurfaceRgb = themeOklchToRgb(accentSurface)
  const messageSurface = surfaceAt(dark ? 0.16 : 0.1, Math.min(0.13, accent.C * 0.6))
  const messageSurfaceRgb = themeOklchToRgb(messageSurface)
  const codeBackground = surfaceAt(0.035, tintC * 0.8)
  const updateSurface = surfaceAt(dark ? 0.14 : 0.09, Math.min(0.12, accent.C * 0.55))

  const foregroundOn = (surfaceRgb: ThemeRgbColor): string =>
    themeOklchToThemeColor(
      solveOklchLightness(textBase, surfaceRgb, 4.6, dark ? 'lighter' : 'darker'),
    )
  const mutedForeground = foregroundOn(mutedRgb)
  const placeholder = foregroundOn(surfaceRaisedRgb)

  const actionHover: ThemeOklch = { ...action, L: action.L + (dark ? 0.06 : -0.06) }

  return {
    ...defaults,
    ...standardStatusColors(canvasRgb),
    canvas: themeRgbToThemeColor(canvasRgb),
    chrome: themeRgbToThemeColor(canvasRgb),
    toolbar: themeRgbToThemeColor(canvasRgb),
    toolbarForeground: themeRgbToThemeColor(textRgb),
    toolbarBorder: themeColor(surfaceAt(dark ? 0.14 : 0.1, Math.min(0.08, accent.C * 0.4))),
    toolbarControl: themeColor(surfaceAt(dark ? 0.09 : 0.05, tintC * 1.3)),
    toolbarControlForeground: themeRgbToThemeColor(textRgb),
    toolbarControlHover: themeColor(surfaceAt(dark ? 0.14 : 0.09, tintC * 1.6)),
    surface: themeColor(surface),
    surfaceRaised: themeColor(surfaceRaised),
    surfaceOverlay: themeColor(surfaceOverlay),
    text: themeRgbToThemeColor(textRgb),
    textMuted: themeRgbToThemeColor(textMutedRgb),
    border: themeColor(border),
    input: themeColor(input),
    focus: themeRgbToThemeColor(accentRgb),
    accent: themeRgbToThemeColor(accentRgb),
    accentForeground: themeRgbToThemeColor(accentForeground),
    secondary: themeColor(secondary),
    secondaryForeground: foregroundOn(secondaryRgb),
    muted: themeColor(muted),
    mutedForeground,
    placeholder,
    secondaryLabel: themeRgbToThemeColor(textMutedRgb),
    iconMuted: themeRgbToThemeColor(textMutedRgb),
    update: themeRgbToThemeColor(accentRgb),
    updateForeground: foregroundOn(themeOklchToRgb(updateSurface)),
    updateSurface: themeColor(updateSurface),
    accentSurface: themeColor(accentSurface),
    accentSurfaceForeground: foregroundOn(accentSurfaceRgb),
    messageSurface: themeColor(messageSurface),
    messageForeground: foregroundOn(messageSurfaceRgb),
    messageAction: themeRgbToThemeColor(actionRgb),
    messageActionForeground: themeRgbToThemeColor(actionForeground),
    messageActionHover: themeColor(actionHover),
    codeBackground: themeColor(codeBackground),
    codeForeground: themeRgbToThemeColor(textRgb),
    sidebar: themeColor(sidebar),
    sidebarForeground: foregroundOn(sidebarRgb),
    sidebarMutedForeground: themeRgbToThemeColor(standardMutedThemeText(sidebarRgb, textRgb)),
    sidebarControlSurface: themeColor(surfaceAt(dark ? 0.1 : 0.07, tintC * 1.5)),
    sidebarRowHover: themeColor(surfaceAt(dark ? 0.08 : 0.06, Math.min(0.08, accent.C * 0.45))),
    sidebarRowActive: themeColor(surfaceAt(dark ? 0.12 : 0.09, Math.min(0.1, accent.C * 0.55))),
    sidebarRowSelected: themeColor(surfaceAt(dark ? 0.14 : 0.1, Math.min(0.11, accent.C * 0.6))),
    sidebarBorder: themeColor(surfaceAt(dark ? 0.17 : 0.12, Math.min(0.08, accent.C * 0.4))),
    terminalBackground: themeRgbToThemeColor(canvasRgb),
    terminalForeground: themeRgbToThemeColor(textRgb),
    terminalCursor: themeRgbToThemeColor(accentRgb),
    terminalSelection: themeColor(surfaceAt(dark ? 0.18 : 0.12, Math.min(0.12, accent.C * 0.55))),
    terminalScrollbar: themeColor(surfaceAt(dark ? 0.22 : 0.16, tintC)),
    terminalScrollbarHover: themeColor(surfaceAt(dark ? 0.3 : 0.22, tintC)),
  }
}

export function applyThemeColorOverrides(
  base: ThemeColors,
  overrides?: Readonly<Record<string, string>>,
): ThemeColors
{
  const colors = { ...base }
  for (const role of THEME_COLOR_ROLES)
  {
    const color = toCanonicalThemeColor(overrides?.[role])
    if (color !== null) colors[role] = color
  }
  return colors
}

const APP_THEME_VARIABLES: Readonly<Record<ThemeColorRole, string>> = {
  canvas: '--app-theme-canvas',
  chrome: '--app-theme-chrome',
  toolbar: '--app-theme-toolbar',
  toolbarForeground: '--app-theme-toolbar-foreground',
  toolbarBorder: '--app-theme-toolbar-border',
  toolbarControl: '--app-theme-toolbar-control',
  toolbarControlForeground: '--app-theme-toolbar-control-foreground',
  toolbarControlHover: '--app-theme-toolbar-control-hover',
  surface: '--app-theme-surface',
  surfaceRaised: '--app-theme-surface-raised',
  surfaceOverlay: '--app-theme-surface-overlay',
  text: '--app-theme-text',
  textMuted: '--app-theme-text-muted',
  border: '--app-theme-border',
  input: '--app-theme-input',
  focus: '--app-theme-focus',
  accent: '--app-theme-accent',
  accentForeground: '--app-theme-accent-foreground',
  secondary: '--app-theme-secondary',
  secondaryForeground: '--app-theme-secondary-foreground',
  muted: '--app-theme-muted',
  mutedForeground: '--app-theme-muted-foreground',
  placeholder: '--app-theme-placeholder',
  secondaryLabel: '--app-theme-secondary-label',
  iconMuted: '--app-theme-icon-muted',
  error: '--app-theme-error',
  errorForeground: '--app-theme-error-foreground',
  errorSurface: '--app-theme-error-surface',
  warning: '--app-theme-warning',
  warningForeground: '--app-theme-warning-foreground',
  warningSurface: '--app-theme-warning-surface',
  update: '--app-theme-update',
  updateForeground: '--app-theme-update-foreground',
  updateSurface: '--app-theme-update-surface',
  accentSurface: '--app-theme-accent-surface',
  accentSurfaceForeground: '--app-theme-accent-surface-foreground',
  messageSurface: '--app-theme-message-surface',
  messageForeground: '--app-theme-message-foreground',
  messageAction: '--app-theme-message-action',
  messageActionForeground: '--app-theme-message-action-foreground',
  messageActionHover: '--app-theme-message-action-hover',
  codeBackground: '--app-theme-code-background',
  codeForeground: '--app-theme-code-foreground',
  sidebar: '--app-theme-sidebar',
  sidebarForeground: '--app-theme-sidebar-foreground',
  sidebarMutedForeground: '--app-theme-sidebar-muted-foreground',
  sidebarControlSurface: '--app-theme-sidebar-control-surface',
  sidebarRowHover: '--app-theme-sidebar-row-hover',
  sidebarRowActive: '--app-theme-sidebar-row-active',
  sidebarRowSelected: '--app-theme-sidebar-row-selected',
  sidebarBorder: '--app-theme-sidebar-border',
  terminalBackground: '--app-theme-terminal-background',
  terminalForeground: '--app-theme-terminal-foreground',
  terminalCursor: '--app-theme-terminal-cursor',
  terminalSelection: '--app-theme-terminal-selection-background',
  terminalScrollbar: '--app-theme-terminal-scrollbar',
  terminalScrollbarHover: '--app-theme-terminal-scrollbar-hover',
}

export function applyThemeColors(colors: ThemeColors | null): void
{
  if (typeof document === 'undefined') return
  const root = document.documentElement
  let hasColors = false
  for (const role of THEME_COLOR_ROLES)
  {
    const color = toCanonicalThemeColor(colors?.[role])
    if (color !== null)
    {
      root.style.setProperty(APP_THEME_VARIABLES[role], color)
      hasColors = true
    }
    else root.style.removeProperty(APP_THEME_VARIABLES[role])
  }
  if (hasColors) root.dataset.environmentTheme = 'true'
  else delete root.dataset.environmentTheme
}
