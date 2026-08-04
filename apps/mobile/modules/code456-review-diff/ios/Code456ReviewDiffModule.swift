// apps/mobile/modules/code456-review-diff/ios/Code456ReviewDiffModule.swift
// registers the iOS review diff module
import ExpoModulesCore

public class Code456ReviewDiffModule: Module {
  public func definition() -> ModuleDefinition {
    Name("Code456ReviewDiffSurface")

    View(Code456ReviewDiffView.self) {
      Prop("tokensResetKey") { (view: Code456ReviewDiffView, tokensResetKey: String) in
        view.setTokensResetKey(tokensResetKey)
      }

      Prop("contentResetKey") { (view: Code456ReviewDiffView, contentResetKey: String) in
        view.setContentResetKey(contentResetKey)
      }

      Prop("collapsedFileIdsJson") { (view: Code456ReviewDiffView, collapsedFileIdsJson: String) in
        view.setCollapsedFileIdsJson(collapsedFileIdsJson)
      }

      Prop("viewedFileIdsJson") { (view: Code456ReviewDiffView, viewedFileIdsJson: String) in
        view.setViewedFileIdsJson(viewedFileIdsJson)
      }

      Prop("selectedRowIdsJson") { (view: Code456ReviewDiffView, selectedRowIdsJson: String) in
        view.setSelectedRowIdsJson(selectedRowIdsJson)
      }

      Prop("collapsedCommentIdsJson") { (view: Code456ReviewDiffView, collapsedCommentIdsJson: String) in
        view.setCollapsedCommentIdsJson(collapsedCommentIdsJson)
      }

      Prop("appearanceScheme") { (view: Code456ReviewDiffView, appearanceScheme: String) in
        view.setAppearanceScheme(appearanceScheme)
      }

      Prop("themeJson") { (view: Code456ReviewDiffView, themeJson: String) in
        view.setThemeJson(themeJson)
      }

      Prop("styleJson") { (view: Code456ReviewDiffView, styleJson: String) in
        view.setStyleJson(styleJson)
      }

      Prop("rowHeight") { (view: Code456ReviewDiffView, rowHeight: Double) in
        view.setRowHeight(CGFloat(rowHeight))
      }

      Prop("contentWidth") { (view: Code456ReviewDiffView, contentWidth: Double) in
        view.setContentWidth(CGFloat(contentWidth))
      }

      Prop("initialRowIndex") { (view: Code456ReviewDiffView, initialRowIndex: Double) in
        view.setInitialRowIndex(initialRowIndex)
      }

      Prop("refreshing") { (view: Code456ReviewDiffView, refreshing: Bool) in
        view.setRefreshing(refreshing)
      }

      Events(
        "onDebug",
        "onVisibleFileChange",
        "onToggleFile",
        "onToggleViewedFile",
        "onPressLine",
        "onToggleComment",
        "onPullToRefresh"
      )

      AsyncFunction("scrollToFile") { (view: Code456ReviewDiffView, fileId: String, animated: Bool) in
        view.scrollToFile(fileId, animated: animated)
      }

      AsyncFunction("scrollToTop") { (view: Code456ReviewDiffView, animated: Bool) in
        view.scrollToTop(animated: animated)
      }

      // large, frequently changing JSON values cannot be regular Fabric props. Expo's
      // prop adapter compares strings on the main thread before invoking a setter, which
      // makes a syntax-token patch capable of blocking a frame by itself.
      AsyncFunction("setRowsJson") { (view: Code456ReviewDiffView, rowsJson: String) in
        view.setRowsJson(rowsJson)
      }

      AsyncFunction("setTokensJson") { (view: Code456ReviewDiffView, tokensJson: String) in
        view.setTokensJson(tokensJson)
      }

      AsyncFunction("setTokensPatchJson") { (view: Code456ReviewDiffView, tokensPatchJson: String) in
        view.setTokensPatchJson(tokensPatchJson)
      }
    }
  }
}
