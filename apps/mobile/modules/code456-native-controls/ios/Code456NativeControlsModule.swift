// apps/mobile/modules/code456-native-controls/ios/Code456NativeControlsModule.swift
// registers iOS native control views
import ExpoModulesCore
import Security

public final class Code456NativeControlsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("Code456NativeControls")

    Function("getShowcasePairingUrl") {
      let arguments = ProcessInfo.processInfo.arguments
      guard
        let flagIndex = arguments.firstIndex(of: "--showcasePairingUrl"),
        arguments.indices.contains(flagIndex + 1)
      else {
        return nil as String?
      }
      return arguments[flagIndex + 1]
    }

    Function("getShowcaseScene") { () -> String? in
      let scenePath = NSHomeDirectory() + "/Library/Caches/Code456ShowcaseScene"
      if let storedScene = try? String(contentsOfFile: scenePath, encoding: .utf8)
        .trimmingCharacters(in: .whitespacesAndNewlines), !storedScene.isEmpty {
        return storedScene
      }
      let arguments = ProcessInfo.processInfo.arguments
      guard
        let flagIndex = arguments.firstIndex(of: "--showcaseScene"),
        arguments.indices.contains(flagIndex + 1)
      else {
        return nil as String?
      }
      return arguments[flagIndex + 1]
    }

    Function("prepareShowcaseCapture") {
      for itemClass in [kSecClassGenericPassword, kSecClassInternetPassword] {
        SecItemDelete([kSecClass as String: itemClass] as CFDictionary)
      }
    }

    Function("markShowcaseReady") { (scene: String) in
      let readyPath = NSHomeDirectory() + "/Library/Caches/Code456ShowcaseReadyScene"
      try? scene.write(toFile: readyPath, atomically: true, encoding: .utf8)
    }

    View(Code456HeaderButtonView.self) {
      Prop("label") { (view: Code456HeaderButtonView, label: String) in
        view.setLabel(label)
      }
      Prop("systemImage") { (view: Code456HeaderButtonView, systemImage: String) in
        view.setSystemImage(systemImage)
      }

      Events("onTriggered")
    }
  }
}
