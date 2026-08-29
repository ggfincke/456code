// apps/mobile/plugins/withIosPodsDeploymentTargetFloor.cjs
// keep generated CocoaPods targets compatible with the supported Xcode range

const fs = require('node:fs')
const path = require('node:path')

const { withDangerousMod } = require('expo/config-plugins')

const IOS_PODS_DEPLOYMENT_TARGET_FLOOR = '15.0'
const MARKER = '# code456: keep generated Pods within Xcode deployment support'
const DEPLOYMENT_TARGET_REPAIR = `${MARKER}
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |build_configuration|
        deployment_target = build_configuration.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
        next unless deployment_target && Gem::Version.correct?(deployment_target)
        next unless Gem::Version.new(deployment_target) < Gem::Version.new('${IOS_PODS_DEPLOYMENT_TARGET_FLOOR}')

        build_configuration.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${IOS_PODS_DEPLOYMENT_TARGET_FLOOR}'
      end
    end
`

function addIosPodsDeploymentTargetFloor(podfile)
{
  if (podfile.includes(MARKER))
  {
    return podfile
  }

  const postInstallStart = 'post_install do |installer|\n'
  if (!podfile.includes(postInstallStart))
  {
    throw new Error('Unable to set the iOS Pods deployment target floor: post_install is missing.')
  }

  return podfile.replace(postInstallStart, `${postInstallStart}${DEPLOYMENT_TARGET_REPAIR}`)
}

module.exports = function withIosPodsDeploymentTargetFloor(config)
{
  return withDangerousMod(config, [
    'ios',
    (nextConfig) =>
    {
      const podfilePath = path.join(nextConfig.modRequest.platformProjectRoot, 'Podfile')
      const podfile = fs.readFileSync(podfilePath, 'utf8')
      const nextPodfile = addIosPodsDeploymentTargetFloor(podfile)

      if (nextPodfile !== podfile)
      {
        fs.writeFileSync(podfilePath, nextPodfile, 'utf8')
      }
      return nextConfig
    },
  ])
}

module.exports.addIosPodsDeploymentTargetFloor = addIosPodsDeploymentTargetFloor
module.exports.IOS_PODS_DEPLOYMENT_TARGET_FLOOR = IOS_PODS_DEPLOYMENT_TARGET_FLOOR
