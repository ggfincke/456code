// apps/web/src/components/settings/connections/pairingFields.ts
// parse pairing url and remote host/code fields

import { getPairingTokenFromUrl } from '../../../pairingUrl'
import { readHostedPairingRequest } from '../../../hostedPairing'

export function parsePairingUrlFields(
  input: string,
): { readonly host: string; readonly pairingCode: string } | null
{
  const trimmed = input.trim()
  if (!trimmed) return null

  try
  {
    const urlLikeInput =
      /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//u.test(trimmed) || trimmed.startsWith('//')
        ? trimmed
        : `https://${trimmed}`
    const url = new URL(urlLikeInput, window.location.origin)
    const hostedPairingRequest = readHostedPairingRequest(url)
    if (hostedPairingRequest)
    {
      return {
        host: hostedPairingRequest.host,
        pairingCode: hostedPairingRequest.token,
      }
    }

    const pairingCode = getPairingTokenFromUrl(url)
    if (!pairingCode) return null
    return {
      host: url.origin,
      pairingCode,
    }
  }
  catch
  {
    return null
  }
}

export function parseRemotePairingFields(input: {
  readonly host: string
  readonly pairingCode: string
}): {
  readonly host: string
  readonly pairingCode: string
}
{
  const parsedPairingUrl = parsePairingUrlFields(input.host)
  if (parsedPairingUrl) return parsedPairingUrl

  const host = input.host.trim()
  const pairingCode = input.pairingCode.trim()
  if (!host)
  {
    throw new Error('Enter a backend host.')
  }
  if (!pairingCode)
  {
    throw new Error('Enter a pairing code.')
  }
  return { host, pairingCode }
}
