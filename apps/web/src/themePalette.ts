// apps/web/src/themePalette.ts
// derive bounded palettes and apply known role colors to the web client

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
  return appearance === 'dark' ? T3_CODE_DARK_THEME_COLORS : T3_CODE_LIGHT_THEME_COLORS
}

type ThemeRgbColor = { r: number; g: number; b: number }
type ThemeHslColor = { h: number; s: number; l: number }
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

export function toCanonicalThemeColor(value: unknown): string | null
{
  if (typeof value !== 'string' || value.length > 64) return null
  const input = value.trim()
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(input)
    ? input.toLowerCase()
    : null
}

function parseThemeRgbColor(value: string, fallback: ThemeRgbColor): ThemeRgbColor
{
  const match = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i)
  if (!match) return fallback

  const raw = match[1]
  if (!raw) return fallback
  const hex =
    raw.length <= 4
      ? raw
          .slice(0, 3)
          .split('')
          .map((part) => part.repeat(2))
          .join('')
      : raw.slice(0, 6)
  if (hex.length !== 6) return fallback

  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  }
}

function themeRgbToHexColor(color: ThemeRgbColor): string
{
  return `#${[color.r, color.g, color.b]
    .map((channel) =>
      Math.round(Math.min(255, Math.max(0, channel)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}

function themeRgbToHsl(color: ThemeRgbColor): ThemeHslColor
{
  const red = color.r / 255
  const green = color.g / 255
  const blue = color.b / 255
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const delta = max - min
  const lightness = (max + min) / 2

  if (delta === 0) return { h: 0, s: 0, l: lightness }

  const saturation = delta / (1 - Math.abs(2 * lightness - 1))
  let hue = 0
  if (max === red) hue = ((green - blue) / delta) % 6
  else if (max === green) hue = (blue - red) / delta + 2
  else hue = (red - green) / delta + 4

  return { h: (hue * 60 + 360) % 360, s: saturation, l: lightness }
}

function themeHslToRgb(color: ThemeHslColor): ThemeRgbColor
{
  const hue = ((color.h % 360) + 360) % 360
  const chroma = (1 - Math.abs(2 * color.l - 1)) * color.s
  const hueSector = hue / 60
  const secondary = chroma * (1 - Math.abs((hueSector % 2) - 1))
  const match = color.l - chroma / 2
  const [red, green, blue] =
    hueSector < 1
      ? [chroma, secondary, 0]
      : hueSector < 2
        ? [secondary, chroma, 0]
        : hueSector < 3
          ? [0, chroma, secondary]
          : hueSector < 4
            ? [0, secondary, chroma]
            : hueSector < 5
              ? [secondary, 0, chroma]
              : [chroma, 0, secondary]

  return { r: (red + match) * 255, g: (green + match) * 255, b: (blue + match) * 255 }
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
    themeRgbToHexColor(
      themeOklchToRgb(
        solveOklchLightness(
          themeRgbToOklch(parseThemeRgbColor(foreground, canvas)),
          surface,
          4.6,
          appearance === 'dark' ? 'lighter' : 'darker',
        ),
      ),
    )
  const errorSurface = surfaceOf(standard.error)
  const warningSurface = surfaceOf(standard.warning)
  return {
    ...standard,
    errorForeground: readableOn(standard.errorForeground, errorSurface),
    errorSurface: themeRgbToHexColor(errorSurface),
    warningForeground: readableOn(standard.warningForeground, warningSurface),
    warningSurface: themeRgbToHexColor(warningSurface),
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

function managedThemeBackground(value: string, appearance: ThemeAppearance): ThemeRgbColor
{
  const selected = parseThemeRgbColor(
    value,
    appearance === 'dark' ? { r: 24, g: 15, b: 27 } : { r: 250, g: 245, b: 250 },
  )
  const hsl = themeRgbToHsl(selected)
  return themeHslToRgb({
    h: hsl.h,
    s: Math.min(hsl.s, appearance === 'dark' ? 0.3 : 0.2),
    l:
      appearance === 'dark'
        ? Math.min(0.13, Math.max(0.07, hsl.l))
        : Math.min(0.985, Math.max(0.94, hsl.l)),
  })
}

function managedThemeAccent(
  value: string,
  appearance: ThemeAppearance,
  background: ThemeRgbColor,
): ThemeRgbColor
{
  const selected = parseThemeRgbColor(value, { r: 168, g: 67, b: 112 })
  const hsl = themeRgbToHsl(selected)
  const preferredLightness =
    appearance === 'dark'
      ? Math.min(0.72, Math.max(0.42, hsl.l))
      : Math.min(0.58, Math.max(0.35, hsl.l))
  const lightnessRange: readonly [number, number] =
    appearance === 'dark' ? [0.42, 0.82] : [0.22, 0.58]
  const saturation = Math.min(hsl.s, 0.82)
  const candidates = Array.from({ length: 61 }, (_, index) =>
  {
    const lightness =
      lightnessRange[0] + ((lightnessRange[1] - lightnessRange[0]) * index) / (61 - 1)
    const color = themeHslToRgb({ h: hsl.h, s: saturation, l: lightness })
    return { color, lightness, contrast: themeContrastRatio(color, background) }
  })
  const readableCandidates = candidates.filter((candidate) => candidate.contrast >= 4.7)
  const pool = readableCandidates.length > 0 ? readableCandidates : candidates

  return pool.reduce((best, candidate) =>
  {
    const distance = Math.abs(candidate.lightness - preferredLightness)
    const bestDistance = Math.abs(best.lightness - preferredLightness)
    return distance < bestDistance ||
      (distance === bestDistance && candidate.contrast > best.contrast)
      ? candidate
      : best
  }).color
}

export function createManagedThemeColors(
  appearance: ThemeAppearance,
  backgroundValue: string,
  accentValue: string,
  options?: {
    exactSeeds?: boolean
  },
): ThemeColors
{
  const defaults = getStandardThemeColors(appearance)
  const canvas = options?.exactSeeds
    ? parseThemeRgbColor(
        backgroundValue,
        appearance === 'dark' ? { r: 24, g: 15, b: 27 } : { r: 250, g: 245, b: 250 },
      )
    : managedThemeBackground(backgroundValue, appearance)
  const accent = options?.exactSeeds
    ? parseThemeRgbColor(accentValue, { r: 168, g: 67, b: 112 })
    : managedThemeAccent(accentValue, appearance, canvas)
  const text = readableThemeForeground(canvas)
  const textMuted = standardMutedThemeText(canvas, text)
  const chrome = canvas
  const sidebar = mixThemeRgbColors(canvas, accent, 0.08)
  const surfaceRaised = mixThemeRgbColors(canvas, text, appearance === 'dark' ? 0.12 : 0.035)
  const surfaceOverlay = mixThemeRgbColors(canvas, text, appearance === 'dark' ? 0.18 : 0.06)
  const secondary = mixThemeRgbColors(canvas, accent, appearance === 'dark' ? 0.2 : 0.08)
  const muted = mixThemeRgbColors(canvas, accent, appearance === 'dark' ? 0.13 : 0.06)
  const accentSurface = mixThemeRgbColors(canvas, accent, appearance === 'dark' ? 0.3 : 0.14)
  const messageSurface = mixThemeRgbColors(canvas, accent, appearance === 'dark' ? 0.36 : 0.18)
  const toolbarControl = mixThemeRgbColors(chrome, accent, appearance === 'dark' ? 0.2 : 0.08)
  const toolbarBorder = mixThemeRgbColors(chrome, accent, appearance === 'dark' ? 0.35 : 0.14)
  const accentForeground = readableThemeForeground(accent)
  const codeBackground = mixThemeRgbColors(canvas, text, appearance === 'dark' ? 0.06 : 0.025)
  const terminalBackground = canvas
  const messageActionHover = mixThemeRgbColors(
    accent,
    accentForeground === THEME_LIGHT_FOREGROUND || accentForeground === THEME_WHITE_FOREGROUND
      ? THEME_BLACK_FOREGROUND
      : THEME_WHITE_FOREGROUND,
    0.12,
  )
  const updateSurface = mixThemeRgbColors(canvas, accent, appearance === 'dark' ? 0.32 : 0.16)
  const updateForeground = mixThemeRgbColors(
    accent,
    appearance === 'dark' ? THEME_WHITE_FOREGROUND : THEME_BLACK_FOREGROUND,
    0.35,
  )

  return {
    ...defaults,
    ...standardStatusColors(canvas),
    update: themeRgbToHexColor(accent),
    updateForeground: themeRgbToHexColor(updateForeground),
    updateSurface: themeRgbToHexColor(updateSurface),
    canvas: themeRgbToHexColor(canvas),
    chrome: themeRgbToHexColor(chrome),
    toolbar: themeRgbToHexColor(chrome),
    toolbarForeground: themeRgbToHexColor(text),
    toolbarBorder: themeRgbToHexColor(toolbarBorder),
    toolbarControl: themeRgbToHexColor(toolbarControl),
    toolbarControlForeground: themeRgbToHexColor(text),
    toolbarControlHover: themeRgbToHexColor(accentSurface),
    surface: themeRgbToHexColor(canvas),
    surfaceRaised: themeRgbToHexColor(surfaceRaised),
    surfaceOverlay: themeRgbToHexColor(surfaceOverlay),
    text: themeRgbToHexColor(text),
    textMuted: themeRgbToHexColor(textMuted),
    border: themeRgbToHexColor(
      mixThemeRgbColors(
        mixThemeRgbColors(canvas, accent, appearance === 'dark' ? 0.22 : 0.1),
        text,
        0.1,
      ),
    ),
    input: themeRgbToHexColor(
      mixThemeRgbColors(
        mixThemeRgbColors(canvas, accent, appearance === 'dark' ? 0.3 : 0.14),
        text,
        appearance === 'dark' ? 0.14 : 0.13,
      ),
    ),
    focus: themeRgbToHexColor(accent),
    accent: themeRgbToHexColor(accent),
    accentForeground: themeRgbToHexColor(accentForeground),
    secondary: themeRgbToHexColor(secondary),
    secondaryForeground: themeRgbToHexColor(readableThemeForeground(secondary)),
    muted: themeRgbToHexColor(muted),
    mutedForeground: themeRgbToHexColor(textMuted),
    placeholder: themeRgbToHexColor(textMuted),
    secondaryLabel: themeRgbToHexColor(textMuted),
    iconMuted: themeRgbToHexColor(textMuted),
    accentSurface: themeRgbToHexColor(accentSurface),
    accentSurfaceForeground: themeRgbToHexColor(readableThemeForeground(accentSurface)),
    messageSurface: themeRgbToHexColor(messageSurface),
    messageForeground: themeRgbToHexColor(readableThemeForeground(messageSurface)),
    messageAction: themeRgbToHexColor(accent),
    messageActionForeground: themeRgbToHexColor(accentForeground),
    messageActionHover: themeRgbToHexColor(messageActionHover),
    codeBackground: themeRgbToHexColor(codeBackground),
    codeForeground: themeRgbToHexColor(readableThemeForeground(codeBackground)),
    sidebar: themeRgbToHexColor(sidebar),
    sidebarForeground: themeRgbToHexColor(readableThemeForeground(sidebar)),
    sidebarMutedForeground: themeRgbToHexColor(standardMutedThemeText(sidebar, text)),
    sidebarControlSurface: themeRgbToHexColor(
      mixThemeRgbColors(sidebar, text, appearance === 'dark' ? 0.16 : 0.08),
    ),
    sidebarRowHover: themeRgbToHexColor(mixThemeRgbColors(sidebar, accent, 0.12)),
    sidebarRowActive: themeRgbToHexColor(mixThemeRgbColors(sidebar, accent, 0.2)),
    sidebarRowSelected: themeRgbToHexColor(mixThemeRgbColors(sidebar, accent, 0.24)),
    sidebarBorder: themeRgbToHexColor(
      mixThemeRgbColors(sidebar, text, appearance === 'dark' ? 0.35 : 0.12),
    ),
    terminalBackground: themeRgbToHexColor(terminalBackground),
    terminalForeground: themeRgbToHexColor(readableThemeForeground(terminalBackground)),
    terminalCursor: themeRgbToHexColor(accent),
    terminalSelection: themeRgbToHexColor(
      mixThemeRgbColors(canvas, accent, appearance === 'dark' ? 0.35 : 0.18),
    ),
    terminalScrollbar: themeRgbToHexColor(
      mixThemeRgbColors(canvas, text, appearance === 'dark' ? 0.42 : 0.22),
    ),
    terminalScrollbarHover: themeRgbToHexColor(
      mixThemeRgbColors(canvas, text, appearance === 'dark' ? 0.55 : 0.32),
    ),
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
