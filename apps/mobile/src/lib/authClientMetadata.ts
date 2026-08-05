// apps/mobile/src/lib/authClientMetadata.ts
// expose auth client metadata

import type { AuthClientPresentationMetadata } from '@t3tools/contracts'
import { Platform } from 'react-native'

export function authClientMetadata(): AuthClientPresentationMetadata
{
  return {
    label: '456code Mobile',
    deviceType: 'mobile',
    ...(Platform.OS === 'ios' ? { os: 'iOS' } : Platform.OS === 'android' ? { os: 'Android' } : {}),
  }
}
