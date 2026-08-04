// apps/mobile/src/lib/native-glass-capability.ts
// determine whether native liquid glass

export function supportsNativeLiquidGlass(
  platform: string,
  nativeCapabilityAvailable: boolean,
): boolean
{
  return platform === 'ios' && nativeCapabilityAvailable
}
