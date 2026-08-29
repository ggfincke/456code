// tests/apps/mobile/plugins/withIosPodsDeploymentTargetFloor.test.ts
// verify generated CocoaPods deployment target compatibility

import * as NodeModule from 'node:module'
import { describe, expect, it } from 'vite-plus/test'

const require = NodeModule.createRequire(import.meta.url)
const { addIosPodsDeploymentTargetFloor, IOS_PODS_DEPLOYMENT_TARGET_FLOOR } =
  require('../../../../apps/mobile/plugins/withIosPodsDeploymentTargetFloor.cjs') as {
    addIosPodsDeploymentTargetFloor: (podfile: string) => string
    IOS_PODS_DEPLOYMENT_TARGET_FLOOR: string
  }

const PODFILE = `target '456code' do
  post_install do |installer|
    react_native_post_install(installer)
  end
end
`

describe('iOS Pods deployment target floor', () =>
{
  it('raises only explicit targets below the Xcode-supported floor', () =>
  {
    const result = addIosPodsDeploymentTargetFloor(PODFILE)

    expect(IOS_PODS_DEPLOYMENT_TARGET_FLOOR).toBe('15.0')
    expect(result).toContain('Gem::Version.correct?(deployment_target)')
    expect(result).toContain("Gem::Version.new(deployment_target) < Gem::Version.new('15.0')")
    expect(result).toContain(
      "build_configuration.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '15.0'",
    )
    expect(result).toContain('react_native_post_install(installer)')
  })

  it('injects the post-install repair once', () =>
  {
    const result = addIosPodsDeploymentTargetFloor(PODFILE)

    expect(addIosPodsDeploymentTargetFloor(result)).toBe(result)
  })

  it('fails when Expo no longer generates the expected post-install hook', () =>
  {
    expect(() => addIosPodsDeploymentTargetFloor("target '456code' do\nend\n")).toThrow(
      'post_install is missing',
    )
  })
})
