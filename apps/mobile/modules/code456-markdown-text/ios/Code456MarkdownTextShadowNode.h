#pragma once

#include <react/renderer/components/Code456MarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/Code456MarkdownTextSpec/Props.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/textlayoutmanager/TextLayoutManager.h>
#include <react/renderer/core/LayoutContext.h>
#include <react/renderer/core/ShadowNode.h>

#include <string>
#include <vector>

namespace facebook::react {

extern const char Code456MarkdownTextComponentName[];

struct Code456MarkdownTextParagraphStyleRange {
  size_t location;
  size_t length;
  Float firstLineHeadIndent;
  Float headIndent;
  Float paragraphSpacing;
};

struct Code456MarkdownTextAttachmentRange {
  size_t location;
  size_t length;
  std::string imageUri;
};

inline Float Code456MarkdownTextAttachmentSize(const Code456MarkdownTextAttachmentRange &) {
  return 14;
}

inline Float Code456MarkdownTextAttachmentBaselineOffset(
    const Code456MarkdownTextAttachmentRange &) {
  return -2;
}

class Code456MarkdownTextStateReal final {
 public:
  AttributedString attributedString;
  std::vector<Code456MarkdownTextParagraphStyleRange> paragraphStyleRanges;
  std::vector<Code456MarkdownTextAttachmentRange> attachmentRanges;
};

class Code456MarkdownTextShadowNode final : public ConcreteViewShadowNode<
Code456MarkdownTextComponentName,
Code456MarkdownTextProps,
Code456MarkdownTextEventEmitter,
Code456MarkdownTextStateReal> {
public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  Code456MarkdownTextShadowNode(
   const ShadowNode& sourceShadowNode,
   const ShadowNodeFragment& fragment
  );

  static ShadowNodeTraits BaseTraits() {
    auto traits = ConcreteViewShadowNode::BaseTraits();
    traits.set(ShadowNodeTraits::Trait::LeafYogaNode);
    traits.set(ShadowNodeTraits::Trait::MeasurableYogaNode);
    return traits;
  }

  void layout(LayoutContext layoutContext) override;

  Size measureContent(
      const LayoutContext& layoutContext,
      const LayoutConstraints& layoutConstraints) const override;

private:
  mutable AttributedString _attributedString;
  mutable std::vector<Code456MarkdownTextParagraphStyleRange> _paragraphStyleRanges;
  mutable std::vector<Code456MarkdownTextAttachmentRange> _attachmentRanges;
};
} // namespace facebook::React
