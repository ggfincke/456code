// apps/mobile/modules/code456-composer-editor/android/src/main/java/expo/modules/code456composereditor/Code456ComposerEditorModule.kt
// registers the Android composer editor module
package expo.modules.code456composereditor

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class Code456ComposerEditorModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("Code456ComposerEditor")

    View(Code456ComposerEditorView::class) {
      Prop("controlledDocumentJson") { view: Code456ComposerEditorView, documentJson: String ->
        view.setControlledDocumentJson(documentJson)
      }
      Prop("themeJson") { view: Code456ComposerEditorView, themeJson: String ->
        view.setThemeJson(themeJson)
      }
      Prop("placeholder") { view: Code456ComposerEditorView, placeholder: String ->
        view.setPlaceholder(placeholder)
      }
      Prop("fontFamily") { view: Code456ComposerEditorView, fontFamily: String ->
        view.setFontFamily(fontFamily)
      }
      Prop("fontSize") { view: Code456ComposerEditorView, fontSize: Double ->
        view.setFontSize(fontSize.toFloat())
      }
      Prop("lineHeight") { view: Code456ComposerEditorView, lineHeight: Double ->
        view.setLineHeight(lineHeight.toFloat())
      }
      Prop("contentInsetVertical") {
          view: Code456ComposerEditorView,
          contentInsetVertical: Double
        ->
        view.setContentInsetVertical(contentInsetVertical.toInt())
      }

      Prop("singleLineCentered") { view: Code456ComposerEditorView, singleLineCentered: Boolean ->
        view.setSingleLineCentered(singleLineCentered)
      }
      Prop("editable") { view: Code456ComposerEditorView, editable: Boolean ->
        view.setEditable(editable)
      }
      Prop("scrollEnabled") { view: Code456ComposerEditorView, scrollEnabled: Boolean ->
        view.setScrollEnabled(scrollEnabled)
      }
      Prop("autoFocus") { view: Code456ComposerEditorView, autoFocus: Boolean ->
        view.setAutoFocus(autoFocus)
      }
      Prop("autoCorrect") { view: Code456ComposerEditorView, autoCorrect: Boolean ->
        view.setAutoCorrect(autoCorrect)
      }
      Prop("spellCheck") { view: Code456ComposerEditorView, spellCheck: Boolean ->
        view.setSpellCheck(spellCheck)
      }

      Events(
        "onComposerChange",
        "onComposerSelectionChange",
        "onComposerFocus",
        "onComposerBlur",
        "onComposerPasteImages",
        "onComposerContentSizeChange",
      )

      AsyncFunction("focus") { view: Code456ComposerEditorView ->
        view.focusEditor()
      }
      AsyncFunction("blur") { view: Code456ComposerEditorView ->
        view.blurEditor()
      }
      AsyncFunction("setSelection") { view: Code456ComposerEditorView, start: Int, end: Int ->
        view.setSelection(start, end)
      }
    }
  }
}
