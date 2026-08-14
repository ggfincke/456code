// apps/web/src/components/chat/ProviderStatusBanner.tsx
// render provider status banner

import { type ServerProvider } from '@t3tools/contracts'
import { memo } from 'react'
import { InfoIcon, XIcon } from 'lucide-react'
import { cn } from '~/lib/utils'
import { formatProviderDriverKindLabel } from '../../providerModels'
import { Tooltip, TooltipPopup, TooltipTrigger } from '../ui/tooltip'

// a token that expires mid-thread never reaches the server's provider probe:
// the CLI is still installed and its cached auth status stays `authenticated`,
// so the only client-visible signal is the session's `lastError` text. Match
// conservatively — a false positive swaps a precise error for generic re-auth
// guidance, so only phrasings that are unambiguously about authentication
// promote to the re-auth banner.
const PROVIDER_AUTH_ERROR_PATTERNS: ReadonlyArray<RegExp> = [
  /\b401\b/u,
  /\bunauthenticated\b/iu,
  /\bunauthorized\b/iu,
  /\bre-?authenticat/iu,
  /\bauthentication (?:failed|expired|error|required)\b/iu,
  /\bnot authenticated\b/iu,
  /\b(?:credentials|api key|token|session|login) (?:has |have )?expired\b/iu,
  /\binvalid api key\b/iu,
  /\b(?:log|sign) ?in again\b/iu,
]

// whether a session/turn error reads as a provider authentication failure.
export function isProviderAuthFailureMessage(message: string | null | undefined): boolean
{
  return message ? PROVIDER_AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(message)) : false
}

export function shouldPromoteThreadErrorToProviderReAuth(
  status: ServerProvider | null,
  visibleThreadError: string | null,
): boolean
{
  return status !== null && isProviderAuthFailureMessage(visibleThreadError)
}

export function getProviderStatusBannerKey(
  status: ServerProvider | null,
  reAuthRequired = false,
): string | null
{
  if (!status || (!reAuthRequired && (status.status === 'ready' || status.status === 'disabled')))
  {
    return null
  }
  return [
    status.instanceId,
    status.status,
    status.auth.status,
    status.message ?? '',
    reAuthRequired ? 'reauth' : '',
  ].join('\u0000')
}

export function shouldShowProviderStatusBanner(
  status: ServerProvider | null,
  dismissedBannerKey: string | null,
  reAuthRequired = false,
): boolean
{
  const bannerKey = getProviderStatusBannerKey(status, reAuthRequired)
  return bannerKey !== null && bannerKey !== dismissedBannerKey
}

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  onDismiss,
  reAuthDetail = null,
  reAuthRequired = false,
  status,
}: {
  onDismiss: () => void
  // raw session error promoted into this banner; kept in the message so the
  // provider's own wording is not lost behind the generic guidance.
  reAuthDetail?: string | null
  // forces the re-auth treatment for a provider the server still reports as
  // healthy — see `isProviderAuthFailureMessage`.
  reAuthRequired?: boolean
  status: ServerProvider | null
})
{
  if (!status || (!reAuthRequired && (status.status === 'ready' || status.status === 'disabled')))
  {
    return null
  }

  const providerName = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver)
  const isUnauthenticated =
    reAuthRequired || (status.status === 'error' && status.auth.status === 'unauthenticated')
  const title = isUnauthenticated
    ? `${providerName} is unauthenticated`
    : `${providerName} provider status`
  const reAuthGuidance = 'Sign in via the CLI to authenticate again.'
  const message = isUnauthenticated
    ? reAuthDetail
      ? `${reAuthGuidance}\n\n${reAuthDetail}`
      : reAuthGuidance
    : (status.message ??
      (status.status === 'error'
        ? `${providerName} provider is unavailable.`
        : `${providerName} provider has limited availability.`))

  return (
    <div className="pointer-events-auto mx-auto w-fit max-w-[calc(100%-2rem)] pt-3">
      <div
        className={cn(
          'relative inline-flex items-center gap-3 rounded-xl border py-3 ps-3.5 pe-10 text-card-foreground text-sm',
          status.status === 'warning' && !reAuthRequired
            ? 'border-warning/32 bg-warning/4 [&_svg]:text-warning'
            : 'border-destructive/32 bg-destructive/4 text-destructive-foreground [&_svg]:text-destructive',
        )}
        role="alert"
      >
        <InfoIcon className="size-4 shrink-0" aria-hidden />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="font-medium">{title}</div>
          <Tooltip>
            <TooltipTrigger
              render={<div className="line-clamp-3 text-muted-foreground">{message}</div>}
            />
            <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
              {message}
            </TooltipPopup>
          </Tooltip>
        </div>
        <button
          type="button"
          aria-label={`Dismiss ${providerName} provider ${reAuthRequired ? 'authentication' : status.status}`}
          className="absolute top-2 right-2 inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-foreground/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onDismiss}
        >
          <XIcon aria-hidden className="size-3.5" />
        </button>
      </div>
    </div>
  )
})
