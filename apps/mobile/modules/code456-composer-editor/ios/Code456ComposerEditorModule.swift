// apps/mobile/modules/code456-composer-editor/ios/Code456ComposerEditorModule.swift
// registers the iOS composer editor module
import ExpoModulesCore

public class Code456ComposerEditorModule: Module {
  public func definition() -> ModuleDefinition {
    Name("Code456ComposerEditor")

    View(Code456ComposerEditorView.self) {
      Prop("controlledDocumentJson") { (view: Code456ComposerEditorView, documentJson: String) in
        view.setControlledDocumentJson(documentJson)
      }
      Prop("themeJson") { (view: Code456ComposerEditorView, themeJson: String) in
        view.setThemeJson(themeJson)
      }
      Prop("placeholder") { (view: Code456ComposerEditorView, placeholder: String) in
        view.setPlaceholder(placeholder)
      }
      Prop("fontFamily") { (view: Code456ComposerEditorView, fontFamily: String) in
        view.setFontFamily(fontFamily)
      }
      Prop("fontSize") { (view: Code456ComposerEditorView, fontSize: Double) in
        view.setFontSize(CGFloat(fontSize))
      }
      Prop("lineHeight") { (view: Code456ComposerEditorView, lineHeight: Double) in
        view.setLineHeight(CGFloat(lineHeight))
      }
      Prop("contentInsetVertical") { (view: Code456ComposerEditorView, contentInsetVertical: Double) in
        view.setContentInsetVertical(CGFloat(contentInsetVertical))
      }
      Prop("editable") { (view: Code456ComposerEditorView, editable: Bool) in
        view.setEditable(editable)
      }
      Prop("scrollEnabled") { (view: Code456ComposerEditorView, scrollEnabled: Bool) in
        view.setScrollEnabled(scrollEnabled)
      }
      Prop("autoFocus") { (view: Code456ComposerEditorView, autoFocus: Bool) in
        view.setAutoFocus(autoFocus)
      }
      Prop("autoCorrect") { (view: Code456ComposerEditorView, autoCorrect: Bool) in
        view.setAutoCorrect(autoCorrect)
      }
      Prop("spellCheck") { (view: Code456ComposerEditorView, spellCheck: Bool) in
        view.setSpellCheck(spellCheck)
      }

      Events(
        "onComposerChange",
        "onComposerSelectionChange",
        "onComposerFocus",
        "onComposerBlur",
        "onComposerSubmit",
        "onComposerPasteImages",
        "onComposerContentSizeChange"
      )

      AsyncFunction("focus") { (view: Code456ComposerEditorView) in
        view.focusEditor()
      }
      AsyncFunction("blur") { (view: Code456ComposerEditorView) in
        view.blurEditor()
      }
      AsyncFunction("setSelection") { (view: Code456ComposerEditorView, start: Int, end: Int) in
        view.setSelection(start: start, end: end)
      }
    }
  }
}
