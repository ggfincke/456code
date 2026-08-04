// apps/mobile/modules/code456-native-controls/android/src/main/java/expo/modules/code456nativecontrols/Code456NativeControlsModule.kt
// registers Android native control views
package expo.modules.code456nativecontrols

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class Code456NativeControlsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("Code456NativeControls")

    Function("getShowcasePairingUrl") {
      appContext.currentActivity?.intent?.getStringExtra("showcasePairingUrl")
    }

    Function("getShowcaseScene") {
      val storedScene = appContext.reactContext
        ?.filesDir
        ?.resolve("code456-showcase-scene")
        ?.takeIf { it.isFile }
        ?.readText()
        ?.trim()
        ?.takeIf { it.isNotEmpty() }
      storedScene ?: appContext.currentActivity?.intent?.getStringExtra("showcaseScene")
    }

    Function("prepareShowcaseCapture") {
      // android app data is cleared by the host runner before launch.
    }

    Function("markShowcaseReady") { scene: String ->
      appContext.reactContext
        ?.filesDir
        ?.resolve("code456-showcase-ready")
        ?.writeText(scene)
    }

    View(Code456HeaderButtonView::class) {
      Prop("label") { view: Code456HeaderButtonView, label: String ->
        view.setLabel(label)
      }
      Prop("systemImage") { view: Code456HeaderButtonView, systemImage: String ->
        view.setSystemImage(systemImage)
      }

      Events("onTriggered")
    }
  }
}
