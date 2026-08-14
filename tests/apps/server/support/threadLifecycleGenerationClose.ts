// tests/apps/server/support/threadLifecycleGenerationClose.ts
// shared exact provider-generation close keys for archive/deletion reactor smokes

import type { ProviderSessionIdentityCapture } from '../../../../apps/server/src/provider/Services/ProviderService.ts'

export function providerGenerationStopKey(
  identity: Pick<
    ProviderSessionIdentityCapture,
    'providerInstanceId' | 'threadId' | 'sessionGeneration'
  >,
): string
{
  return `${identity.providerInstanceId}:${identity.threadId}:${identity.sessionGeneration}`
}

export function expectedProviderGenerationStopKeys(
  identities: ReadonlyArray<
    Pick<ProviderSessionIdentityCapture, 'providerInstanceId' | 'threadId' | 'sessionGeneration'>
  >,
): ReadonlyArray<string>
{
  return identities.map(providerGenerationStopKey)
}
