// apps/mobile/modules/code456-terminal/android/src/main/java/expo/modules/code456terminal/Code456TerminalModule.kt
// registers the Android terminal module
package expo.modules.code456terminal

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class Code456TerminalModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("Code456TerminalSurface")

    // bumped when native hardware-keyboard handling changes; surfaced in the JS debug
    // logs so a stale native binary is distinguishable from a broken key pipeline.
    Constants(
      "hardwareKeyRevision" to 2,
    )

    View(Code456TerminalView::class) {
      Prop("terminalKey") { view: Code456TerminalView, terminalKey: String ->
        view.terminalKey = terminalKey
      }

      Prop("initialBuffer") { view: Code456TerminalView, initialBuffer: String ->
        view.initialBuffer = initialBuffer
      }

      Prop("fontSize") { view: Code456TerminalView, fontSize: Double ->
        view.fontSize = fontSize.toFloat()
      }

      Prop("focusRequest") { view: Code456TerminalView, focusRequest: Double ->
        view.focusRequest = focusRequest
      }

      Prop("autoFocus") { view: Code456TerminalView, autoFocus: Boolean ->
        view.autoFocus = autoFocus
      }

      Prop("appearanceScheme") { view: Code456TerminalView, appearanceScheme: String ->
        view.appearanceScheme = appearanceScheme
      }

      Prop("themeConfig") { view: Code456TerminalView, themeConfig: String ->
        view.themeConfig = themeConfig
      }

      Prop("backgroundColor") { view: Code456TerminalView, backgroundColor: String ->
        view.backgroundColorHex = backgroundColor
      }

      Prop("foregroundColor") { view: Code456TerminalView, foregroundColor: String ->
        view.foregroundColorHex = foregroundColor
      }

      Prop("mutedForegroundColor") { view: Code456TerminalView, mutedForegroundColor: String ->
        view.mutedForegroundColorHex = mutedForegroundColor
      }

      Events("onInput", "onResize")

      OnViewDestroys { view: Code456TerminalView ->
        view.cleanup()
      }
    }
  }
}
