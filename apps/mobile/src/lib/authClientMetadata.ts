// apps/mobile/src/lib/authClientMetadata.ts
// expose auth client metadata

import type { AuthClientPresentationMetadata } from '@t3tools/contracts'

export function authClientMetadata(): AuthClientPresentationMetadata
{
  return {
    label: '456code Mobile',
    deviceType: 'mobile',
    os: 'iOS',
  }
}
