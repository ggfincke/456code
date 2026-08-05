// apps/web/src/components/SidebarStageBackdrop.tsx
// render sidebar stage backdrop

import { useAtomValue } from '@effect/atom-react'
import { useId } from 'react'

import { APP_STAGE_LABEL } from '../branding'
import { resolveServerBackedAppStageLabel } from '../branding.logic'
import { primaryServerConfigAtom } from '../state/server'

export type SidebarStageBackdropVariant = 'nightly' | 'dev' | 'alpha'

// a wide viewBox keeps the 96-unit art height at a fixed scale while sidebar resizing reveals
// more horizontal canvas instead of zooming the scene.
const STAGE_BACKDROP_VIEW_BOX = '0 0 8192 96'

export function resolveSidebarStageBackdropVariant(
  stageLabel: string,
): SidebarStageBackdropVariant | null
{
  const normalized = stageLabel.trim().toLowerCase()
  if (normalized === 'nightly') return 'nightly'
  if (normalized === 'dev') return 'dev'
  if (normalized === 'alpha') return 'alpha'
  return null
}

export function useSidebarStageBackdropVariant(): SidebarStageBackdropVariant | null
{
  const primaryServerVersion =
    useAtomValue(primaryServerConfigAtom)?.environment.serverVersion ?? null

  return resolveSidebarStageBackdropVariant(
    resolveServerBackedAppStageLabel({
      primaryServerVersion,
      fallbackStageLabel: APP_STAGE_LABEL,
    }),
  )
}

// stage-channel header art; palettes mirror the per-channel app icons in `assets/`.
export function SidebarStageBackdrop({ variant }: { variant: SidebarStageBackdropVariant })
{
  // the nightly and dev art are atmospheric and read fine under the default fade. The wave is a
  // solid band on fincke.dev, and that fade desaturates it to grey, so it opts into a later one.
  const fadeClassName = variant === 'alpha' ? ' sidebar-stage-backdrop-solid' : ''

  return (
    <div
      aria-hidden
      className={`sidebar-stage-backdrop${fadeClassName} pointer-events-none absolute inset-x-0 top-0 z-0 h-20 select-none overflow-hidden`}
    >
      <StageBackdropArt variant={variant} />
    </div>
  )
}

export function StageBackdropArt({ variant }: { variant: SidebarStageBackdropVariant })
{
  if (variant === 'nightly') return <NightlySkyArt />
  if (variant === 'alpha') return <AlphaWaveArt />
  return <DevBlueprintArt />
}

export function StageBackdropButtonArt({ variant }: { variant: SidebarStageBackdropVariant })
{
  if (variant === 'nightly') return <NightlySkyArt compact />
  if (variant === 'alpha') return <AlphaWaveArt compact />
  return <DevBlueprintArt compact />
}

const NIGHTLY_STARS: ReadonlyArray<{
  cx: number
  cy: number
  r: number
  opacity: number
}> = [
  { cx: 14, cy: 10, r: 0.6, opacity: 0.85 },
  { cx: 38, cy: 22, r: 0.4, opacity: 0.55 },
  { cx: 58, cy: 8, r: 0.5, opacity: 0.7 },
  { cx: 84, cy: 16, r: 0.4, opacity: 0.5 },
  { cx: 104, cy: 7, r: 0.6, opacity: 0.8 },
  { cx: 126, cy: 20, r: 0.4, opacity: 0.55 },
  { cx: 148, cy: 11, r: 0.5, opacity: 0.7 },
  { cx: 170, cy: 24, r: 0.4, opacity: 0.5 },
  { cx: 192, cy: 9, r: 0.6, opacity: 0.8 },
  { cx: 214, cy: 18, r: 0.4, opacity: 0.55 },
  { cx: 236, cy: 8, r: 0.5, opacity: 0.7 },
  { cx: 258, cy: 20, r: 0.45, opacity: 0.6 },
  { cx: 278, cy: 11, r: 0.55, opacity: 0.75 },
  { cx: 26, cy: 34, r: 0.4, opacity: 0.45 },
  { cx: 118, cy: 34, r: 0.4, opacity: 0.45 },
  { cx: 202, cy: 32, r: 0.4, opacity: 0.5 },
  { cx: 268, cy: 34, r: 0.4, opacity: 0.45 },
]

const NIGHTLY_SPARKLES: ReadonlyArray<{ x: number; y: number }> = [
  { x: 70, y: 28 },
  { x: 160, y: 36 },
  { x: 246, y: 26 },
]

function NightlySkyArt({ compact = false }: { compact?: boolean })
{
  const idPrefix = useId().replaceAll(':', '')
  const skyId = `${idPrefix}-stage-night-sky`
  const glowId = `${idPrefix}-stage-night-glow`
  const cloudId = `${idPrefix}-stage-night-cloud`
  const softId = `${idPrefix}-stage-night-soft`
  const starsId = `${idPrefix}-stage-night-stars`
  const glowsId = `${idPrefix}-stage-night-glows`

  return (
    <svg
      className="h-full w-full"
      fill="none"
      preserveAspectRatio="xMinYMin slice"
      viewBox={compact ? '96 0 8192 96' : STAGE_BACKDROP_VIEW_BOX}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient
          id={skyId}
          x1="24"
          y1="0"
          x2="264"
          y2="96"
          gradientUnits="userSpaceOnUse"
          spreadMethod="reflect"
        >
          <stop stopColor="#07152F" />
          <stop offset="0.5" stopColor="#151443" />
          <stop offset="1" stopColor="#32155B" />
        </linearGradient>
        <radialGradient
          id={glowId}
          cx="0"
          cy="0"
          r="1"
          gradientTransform="translate(216 18) rotate(137) scale(120 84)"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#5165D8" stopOpacity="0.4" />
          <stop offset="0.5" stopColor="#283075" stopOpacity="0.16" />
          <stop offset="1" stopColor="#111635" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={cloudId} x1="0" y1="60" x2="288" y2="96" gradientUnits="userSpaceOnUse">
          <stop stopColor="#4EA4FF" stopOpacity="0.5" />
          <stop offset="0.52" stopColor="#696FEA" stopOpacity="0.62" />
          <stop offset="1" stopColor="#A85BEA" stopOpacity="0.5" />
        </linearGradient>
        <filter id={softId} x="-24" y="-24" width="336" height="144" filterUnits="userSpaceOnUse">
          <feGaussianBlur stdDeviation="4" />
        </filter>
        <pattern id={starsId} width="288" height="96" patternUnits="userSpaceOnUse">
          <g fill="#E4EAFF">
            {NIGHTLY_STARS.map((star) => (
              <circle
                key={`${star.cx}-${star.cy}`}
                cx={star.cx}
                cy={star.cy}
                r={star.r}
                fillOpacity={star.opacity}
              />
            ))}
          </g>
          <g stroke="#C8D7FF" strokeLinecap="round" strokeOpacity="0.7" strokeWidth="0.6">
            {NIGHTLY_SPARKLES.map((sparkle) => (
              <g key={`${sparkle.x}-${sparkle.y}`}>
                <path d={`M${sparkle.x - 1.5} ${sparkle.y}H${sparkle.x + 1.5}`} />
                <path d={`M${sparkle.x} ${sparkle.y - 1.5}V${sparkle.y + 1.5}`} />
              </g>
            ))}
          </g>
        </pattern>
        <pattern id={glowsId} width="640" height="96" patternUnits="userSpaceOnUse">
          <rect width="640" height="96" fill={`url(#${glowId})`} />
        </pattern>
      </defs>

      <rect width="100%" height="96" fill={`url(#${skyId})`} />
      <rect width="100%" height="96" fill={`url(#${glowsId})`} />
      <rect width="100%" height="96" fill={`url(#${starsId})`} />

      <g filter={`url(#${softId})`}>
        <path
          d="M-12 88C-12 74 0 63 14 63C18 50 30 41 44 41C58 41 70 49 74 62C79 57 86 54 94 54C110 54 123 66 124 82C132 83 138 88 141 96H-12V88Z"
          fill={`url(#${cloudId})`}
        />
      </g>
      <g filter={`url(#${softId})`}>
        <path
          d="M150 96C151 84 161 75 173 75C176 64 186 57 198 57C210 57 220 64 223 75C231 75 238 80 241 87C250 87 257 91 260 96H150Z"
          fill={`url(#${cloudId})`}
          fillOpacity="0.8"
        />
      </g>
    </svg>
  )
}

// alpha art is the fincke.dev hero wave, taken as-is from that site's DecorativeWave component:
// the same two ribbon paths, the same gradient geometry, and the same `preserveAspectRatio="none"`
// stretch. Because the drawing stretches to fill rather than tiling, sidebar resizing widens the
// ribbons instead of repeating them -- so there is no seam to hide and no generated waveform.
// both windows frame the drawing's opening S -- x=0 to ~470, where the front ribbon's top edge
// falls from y=0 to y=72.5 with a horizontal tangent at each end. That gives the flat entry,
// smooth descent, and flat run-out the wave is recognized by. Later stretches of the drawing are
// either a crest (x=960) or a shallow tail, and reading either as "the wave" gets the shape wrong.
// height sets ribbon weight: each ribbon is ~30 units, so 150 over the 80px band puts them at
// ~16px. The art crosses the wordmark at this framing, which is why the brand renders in white.
const FINCKE_WAVE_FIELD = { x: 0, y: -26, width: 470, height: 150 } as const

// same opening S, cropped tighter for the ~40px composer button, which has no text to clear.
const FINCKE_WAVE_BUTTON_FIELD = { x: 40, y: -20, width: 420, height: 142 } as const

type FinckeWaveField = typeof FINCKE_WAVE_FIELD | typeof FINCKE_WAVE_BUTTON_FIELD

function waveViewBox(field: FinckeWaveField): string
{
  return `${field.x} ${field.y} ${field.width} ${field.height}`
}

const FINCKE_WAVE_BACK =
  'M462 101.335C228.6 101.335 143.4 28.1958 0 28.1958V58.6706C96 58.6706 253.8 131.81 462 131.81C670.2 131.81 869.4 101.335 960 101.335C1084.8 101.335 1330.2 144 1440 144V113.525C1330.2 113.525 1084.8 70.8605 960 70.8605C867 70.8605 624.6 101.335 462 101.335Z'

const FINCKE_WAVE_FRONT =
  'M462 72.5035C228.6 72.5035 143.4 0 0 0V30.2098C96 30.2098 253.8 102.713 462 102.713C670.2 102.713 869.4 72.5035 960 72.5035C1084.8 72.5035 1330.2 114.797 1440 114.797V84.5874C1330.2 84.5874 1084.8 42.2937 960 42.2937C867 42.2937 624.6 72.5035 462 72.5035Z'

function AlphaWaveArt({ compact = false }: { compact?: boolean })
{
  const idPrefix = useId().replaceAll(':', '')
  const backId = `${idPrefix}-stage-alpha-back`
  const frontId = `${idPrefix}-stage-alpha-front`
  const field = compact ? FINCKE_WAVE_BUTTON_FIELD : FINCKE_WAVE_FIELD

  return (
    <svg
      className="stage-wave h-full w-full"
      fill="none"
      preserveAspectRatio="none"
      viewBox={waveViewBox(field)}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient
          id={backId}
          x1="721.524"
          y1="0.0119269"
          x2="716.661"
          y2="310.697"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0.1" style={{ stopColor: 'var(--stage-wave-accent)' }} />
          <stop offset="0.9" style={{ stopColor: 'var(--stage-wave-field)' }} stopOpacity="0.15" />
        </linearGradient>
        <linearGradient
          id={frontId}
          x1="721.524"
          y1="0.00950815"
          x2="718.433"
          y2="247.71"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="1" style={{ stopColor: 'var(--stage-wave-accent)' }} />
        </linearGradient>
      </defs>

      <rect {...field} style={{ fill: 'var(--stage-wave-field)' }} />
      <path d={FINCKE_WAVE_BACK} fill={`url(#${backId})`} />
      <path d={FINCKE_WAVE_FRONT} fill={`url(#${frontId})`} />
    </svg>
  )
}

function DevBlueprintArt({ compact = false }: { compact?: boolean })
{
  const idPrefix = useId().replaceAll(':', '')
  const paperId = `${idPrefix}-stage-bp-paper`
  const glowId = `${idPrefix}-stage-bp-glow`
  const celesteGlowId = `${idPrefix}-stage-bp-glow-celeste`
  const violetGlowId = `${idPrefix}-stage-bp-glow-violet`
  const minorGridId = `${idPrefix}-stage-bp-grid-minor`
  const majorGridId = `${idPrefix}-stage-bp-grid-major`
  const rulerId = `${idPrefix}-stage-bp-ruler`
  const glowsId = `${idPrefix}-stage-bp-glows`
  const annotationsId = `${idPrefix}-stage-bp-annotations`

  return (
    <svg
      className="stage-blueprint h-full w-full"
      fill="none"
      preserveAspectRatio="xMinYMin slice"
      viewBox={compact ? '64 0 8192 96' : STAGE_BACKDROP_VIEW_BOX}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient
          id={paperId}
          x1="60"
          y1="0"
          x2="220"
          y2="96"
          gradientUnits="userSpaceOnUse"
          spreadMethod="reflect"
        >
          <stop style={{ stopColor: 'var(--stage-bp-bottom)' }} />
          <stop offset="0.5" style={{ stopColor: 'var(--stage-bp-mid)' }} />
          <stop offset="1" style={{ stopColor: 'var(--stage-bp-top)' }} />
        </linearGradient>
        <radialGradient
          id={glowId}
          cx="0"
          cy="0"
          r="1"
          gradientTransform="translate(216 14) rotate(137) scale(120 84)"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#D4F6FF" stopOpacity="0.4" />
          <stop offset="0.52" stopColor="#65C8FF" stopOpacity="0.16" />
          <stop offset="1" stopColor="#276AF1" stopOpacity="0" />
        </radialGradient>
        <radialGradient
          id={celesteGlowId}
          cx="0"
          cy="0"
          r="1"
          gradientTransform="translate(474 44) rotate(166) scale(156 92)"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#D2FFFF" stopOpacity="0.34" />
          <stop offset="0.5" stopColor="#48DCF5" stopOpacity="0.18" />
          <stop offset="1" stopColor="#277EF1" stopOpacity="0" />
        </radialGradient>
        <radialGradient
          id={violetGlowId}
          cx="0"
          cy="0"
          r="1"
          gradientTransform="translate(704 18) rotate(145) scale(132 88)"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#D9D8FF" stopOpacity="0.3" />
          <stop offset="0.52" stopColor="#7C8BFF" stopOpacity="0.14" />
          <stop offset="1" stopColor="#3155DF" stopOpacity="0" />
        </radialGradient>
        <pattern id={minorGridId} width="8" height="8" patternUnits="userSpaceOnUse">
          <path d="M8 0H0V8" stroke="#EAF6FF" strokeOpacity="0.14" strokeWidth="0.5" />
        </pattern>
        <pattern id={majorGridId} width="32" height="32" patternUnits="userSpaceOnUse">
          <path d="M32 0H0V32" stroke="#EAF6FF" strokeOpacity="0.26" strokeWidth="0.6" />
        </pattern>
        <pattern id={rulerId} width="32" height="6" patternUnits="userSpaceOnUse">
          <path
            d="M4 0V2.5M12 0V2.5M20 0V4M28 0V2.5"
            stroke="#DDF7FF"
            strokeOpacity="0.5"
            strokeWidth="0.5"
          />
        </pattern>
        <pattern id={glowsId} width="768" height="96" patternUnits="userSpaceOnUse">
          <rect width="768" height="96" fill={`url(#${glowId})`} />
          <rect width="768" height="96" fill={`url(#${celesteGlowId})`} />
          <rect width="768" height="96" fill={`url(#${violetGlowId})`} />
        </pattern>
        <pattern id={annotationsId} width="768" height="96" patternUnits="userSpaceOnUse">
          <g stroke="#DDF7FF" strokeLinecap="round" strokeOpacity="0.6" strokeWidth="0.7">
            <path d="M180 64H264" strokeDasharray="5 4" />
            <path d="M180 61V67M264 61V67" />
            <path d="M276 10V44" strokeDasharray="4 4" strokeOpacity="0.5" />
            <path d="M273 10H279M273 44H279" strokeOpacity="0.5" />
            <path d="M348 30H428" strokeDasharray="3.5 5" strokeOpacity="0.5" />
            <path d="M348 27V33M428 27V33" strokeOpacity="0.5" />
            <path d="M512 48V80" strokeDasharray="5 3" strokeOpacity="0.45" />
            <path d="M509 48H515M509 80H515" strokeOpacity="0.45" />
            <path d="M590 70H724" strokeDasharray="7 4" strokeOpacity="0.55" />
            <path d="M590 67V73M724 67V73" strokeOpacity="0.55" />
          </g>

          <g stroke="#DDF7FF" strokeLinecap="round" strokeOpacity="0.55" strokeWidth="0.6">
            <g>
              <path d="M34 60L38 64M38 60L34 64" />
            </g>
            <g>
              <path d="M228 26H234M231 23V29" />
            </g>
            <g>
              <path d="M143 51H149M146 48V54" />
            </g>
            <g>
              <path d="M316 16L322 22M322 16L316 22" />
            </g>
            <g>
              <path d="M468 70H476M472 66V74" />
            </g>
            <g>
              <path d="M558 28L564 34M564 28L558 34" />
            </g>
            <g>
              <path d="M742 44H750M746 40V48" />
            </g>
          </g>

          <g stroke="#DDF7FF" strokeOpacity="0.35" strokeWidth="0.6">
            <circle cx="196" cy="38" r="13" strokeDasharray="3.5 4" />
            <path d="M196 33V43M191 38H201" strokeOpacity="0.6" strokeWidth="0.4" />
            <circle cx="414" cy="64" r="10" strokeDasharray="2.5 3.5" />
            <path d="M414 60V68M410 64H418" strokeOpacity="0.6" strokeWidth="0.4" />
            <circle cx="648" cy="32" r="15" strokeDasharray="4 5" />
            <path d="M648 26V38M642 32H654" strokeOpacity="0.6" strokeWidth="0.4" />
          </g>
        </pattern>
      </defs>

      <rect width="100%" height="96" fill={`url(#${paperId})`} />
      <rect width="100%" height="96" fill={`url(#${glowsId})`} />
      <rect width="100%" height="96" fill={`url(#${minorGridId})`} />
      <rect width="100%" height="96" fill={`url(#${majorGridId})`} />
      <rect width="100%" height="6" fill={`url(#${rulerId})`} />
      <rect width="100%" height="96" fill={`url(#${annotationsId})`} />
    </svg>
  )
}
