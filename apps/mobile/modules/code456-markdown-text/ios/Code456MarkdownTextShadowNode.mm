#include "Code456MarkdownTextShadowNode.h"
#include "Code456MarkdownTextRunShadowNode.h"
#include <react/renderer/components/view/ViewShadowNode.h>
#import <react/renderer/textlayoutmanager/RCTAttributedTextUtils.h>

#include <algorithm>
#include <cmath>

namespace facebook::react {

static constexpr Float ParagraphStyleEncodingOffset = 1000;
static constexpr auto FileAttachmentNativeIdPrefix = "code456-file:";
static constexpr auto SkillAttachmentNativeIdPrefix = "code456-skill:";

static void applyParagraphStyles(
    NSMutableAttributedString *attributedString,
    const std::vector<Code456MarkdownTextParagraphStyleRange> &styleRanges)
{
  for (const auto &styleRange : styleRanges) {
    if (styleRange.length == 0 || styleRange.location >= attributedString.length) {
      continue;
    }

    const NSRange markerRange = NSMakeRange(
        styleRange.location,
        MIN(styleRange.length, attributedString.length - styleRange.location));
    const NSRange paragraphRange = [attributedString.string paragraphRangeForRange:markerRange];
    const NSParagraphStyle *existingStyle =
        [attributedString attribute:NSParagraphStyleAttributeName
                            atIndex:paragraphRange.location
                     effectiveRange:nil];
    NSMutableParagraphStyle *paragraphStyle =
        existingStyle ? [existingStyle mutableCopy] : [NSMutableParagraphStyle new];
    paragraphStyle.firstLineHeadIndent = styleRange.firstLineHeadIndent;
    paragraphStyle.headIndent = styleRange.headIndent;
    paragraphStyle.paragraphSpacing = styleRange.paragraphSpacing;
    paragraphStyle.tabStops = @[
      [[NSTextTab alloc] initWithTextAlignment:NSTextAlignmentLeft
                                      location:styleRange.headIndent
                                       options:@{}]
    ];
    paragraphStyle.defaultTabInterval = styleRange.headIndent;
    [attributedString addAttribute:NSParagraphStyleAttributeName
                             value:paragraphStyle
                             range:paragraphRange];
  }
}

static void applyAttachments(
    NSMutableAttributedString *attributedString,
    const std::vector<Code456MarkdownTextAttachmentRange> &attachmentRanges)
{
  for (const auto &attachmentRange : attachmentRanges) {
    if (attachmentRange.length == 0 || attachmentRange.location >= attributedString.length) {
      continue;
    }

    NSTextAttachment *attachment = [[NSTextAttachment alloc] init];
    attachment.image = [[UIImage alloc] init];
    const CGFloat attachmentSize = Code456MarkdownTextAttachmentSize(attachmentRange);
    attachment.bounds = CGRectMake(
        0,
        Code456MarkdownTextAttachmentBaselineOffset(attachmentRange),
        attachmentSize,
        attachmentSize);
    const NSRange range = NSMakeRange(
        attachmentRange.location,
        MIN(attachmentRange.length, attributedString.length - attachmentRange.location));
    NSAttributedString *attachmentString =
        [NSAttributedString attributedStringWithAttachment:attachment];
    [attributedString replaceCharactersInRange:range withAttributedString:attachmentString];
  }
}

Code456MarkdownTextShadowNode::Code456MarkdownTextShadowNode(
   const ShadowNode& sourceShadowNode,
   const ShadowNodeFragment& fragment
) : ConcreteViewShadowNode(sourceShadowNode, fragment) {
};

Size Code456MarkdownTextShadowNode::measureContent(
  const LayoutContext& layoutContext,
  const LayoutConstraints& layoutConstraints) const {
    const auto &baseProps = getConcreteProps();

    auto baseTextAttributes = TextAttributes::defaultTextAttributes();
    baseTextAttributes.backgroundColor = baseProps.backgroundColor;
    baseTextAttributes.allowFontScaling = baseProps.allowFontScaling;

    Float fontSizeMultiplier = 1.0;
    if (baseTextAttributes.allowFontScaling) {
      fontSizeMultiplier = layoutContext.fontSizeMultiplier;
    }

    auto baseAttributedString = AttributedString{};
    auto paragraphStyleRanges = std::vector<Code456MarkdownTextParagraphStyleRange>{};
    auto attachmentRanges = std::vector<Code456MarkdownTextAttachmentRange>{};
    size_t utf16Offset = 0;
    const auto &children = getChildren();
    for (size_t i = 0; i < children.size(); i++) {
      const auto child = children[i].get();
      if (auto textViewChild = dynamic_cast<const Code456MarkdownTextRunShadowNode *>(child)) {
        auto &props = textViewChild->getConcreteProps();
        auto fragment = AttributedString::Fragment{};
        auto textAttributes = TextAttributes::defaultTextAttributes();

        textAttributes.allowFontScaling = baseProps.allowFontScaling;
        textAttributes.backgroundColor = props.backgroundColor;
        textAttributes.fontSize = props.fontSize * fontSizeMultiplier;
        textAttributes.lineHeight = props.lineHeight * fontSizeMultiplier;
        textAttributes.foregroundColor = props.color;
        const bool hasParagraphStyle = props.shadowRadius >= ParagraphStyleEncodingOffset;
        if (!hasParagraphStyle) {
          textAttributes.textShadowColor = props.shadowColor;
          textAttributes.textShadowOffset = props.shadowOffset;
          textAttributes.textShadowRadius = props.shadowRadius;
        }
        textAttributes.letterSpacing = props.letterSpacing;
        textAttributes.textDecorationColor = props.textDecorationColor;
        textAttributes.fontFamily = props.fontFamily;

        if (props.fontStyle == Code456MarkdownTextRunFontStyle::Italic) {
          textAttributes.fontStyle = FontStyle::Italic;
        } else {
          textAttributes.fontStyle = FontStyle::Normal;
        }

        if (props.fontWeight == Code456MarkdownTextRunFontWeight::Bold) {
          textAttributes.fontWeight = FontWeight::Bold;
        } else if (props.fontWeight == Code456MarkdownTextRunFontWeight::UltraLight) {
          textAttributes.fontWeight = FontWeight::UltraLight;
        } else if (props.fontWeight == Code456MarkdownTextRunFontWeight::Light) {
          textAttributes.fontWeight = FontWeight::Light;
        } else if (props.fontWeight == Code456MarkdownTextRunFontWeight::Medium) {
          textAttributes.fontWeight = FontWeight::Medium;
        } else if (props.fontWeight == Code456MarkdownTextRunFontWeight::Semibold) {
          textAttributes.fontWeight = FontWeight::Semibold;
        } else if (props.fontWeight == Code456MarkdownTextRunFontWeight::Heavy) {
          textAttributes.fontWeight = FontWeight::Heavy;
        } else {
          textAttributes.fontWeight = FontWeight::Regular;
        }

        if (props.textDecorationLine == Code456MarkdownTextRunTextDecorationLine::LineThrough) {
          textAttributes.textDecorationLineType = TextDecorationLineType::Strikethrough;
        } else if (props.textDecorationLine == Code456MarkdownTextRunTextDecorationLine::Underline) {
          textAttributes.textDecorationLineType = TextDecorationLineType::Underline;
        } else {
          textAttributes.textDecorationLineType = TextDecorationLineType::None;
        }

        if (props.textDecorationStyle == Code456MarkdownTextRunTextDecorationStyle::Solid) {
          textAttributes.textDecorationStyle = TextDecorationStyle::Solid;
        } else if (props.textDecorationStyle == Code456MarkdownTextRunTextDecorationStyle::Dotted) {
          textAttributes.textDecorationStyle = TextDecorationStyle::Dotted;
        } else if (props.textDecorationStyle == Code456MarkdownTextRunTextDecorationStyle::Dashed) {
          textAttributes.textDecorationStyle = TextDecorationStyle::Dashed;
        } else if (props.textDecorationStyle == Code456MarkdownTextRunTextDecorationStyle::Double) {
          textAttributes.textDecorationStyle = TextDecorationStyle::Double;
        }

        if (props.textAlign == Code456MarkdownTextRunTextAlign::Left) {
          textAttributes.alignment = TextAlignment::Left;
        } else if (props.textAlign == Code456MarkdownTextRunTextAlign::Right) {
          textAttributes.alignment = TextAlignment::Right;
        } else if (props.textAlign == Code456MarkdownTextRunTextAlign::Center) {
          textAttributes.alignment = TextAlignment::Center;
        } else if (props.textAlign == Code456MarkdownTextRunTextAlign::Justify) {
          textAttributes.alignment = TextAlignment::Justified;
        } else if (props.textAlign == Code456MarkdownTextRunTextAlign::Auto) {
          textAttributes.alignment = TextAlignment::Natural;
        }

        textAttributes.backgroundColor = props.backgroundColor;

        fragment.string = props.text;
        fragment.textAttributes = textAttributes;

        NSString *fragmentText = [NSString stringWithUTF8String:props.text.c_str()];
        const size_t fragmentLength = fragmentText.length;
        if (hasParagraphStyle) {
          paragraphStyleRanges.push_back(Code456MarkdownTextParagraphStyleRange{
              utf16Offset,
              fragmentLength,
              props.shadowOffset.width,
              props.shadowOffset.height,
              props.shadowRadius - ParagraphStyleEncodingOffset,
          });
        }
        if (props.nativeId.rfind(FileAttachmentNativeIdPrefix, 0) == 0 && fragmentLength > 0) {
          attachmentRanges.push_back(Code456MarkdownTextAttachmentRange{
              utf16Offset,
              1,
              props.nativeId.substr(std::char_traits<char>::length(FileAttachmentNativeIdPrefix)),
          });
        } else if (
            props.nativeId.rfind(SkillAttachmentNativeIdPrefix, 0) == 0 && fragmentLength > 0) {
          attachmentRanges.push_back(Code456MarkdownTextAttachmentRange{
              utf16Offset,
              1,
              props.nativeId.substr(
                  std::char_traits<char>::length(SkillAttachmentNativeIdPrefix)),
          });
        }
        utf16Offset += fragmentLength;
        baseAttributedString.appendFragment(std::move(fragment));
      }
    }

    _attributedString = baseAttributedString;
    _paragraphStyleRanges = paragraphStyleRanges;
    _attachmentRanges = attachmentRanges;

    NSMutableAttributedString *convertedAttributedString =
        [RCTNSAttributedStringFromAttributedString(baseAttributedString) mutableCopy];
    applyParagraphStyles(convertedAttributedString, paragraphStyleRanges);
    applyAttachments(convertedAttributedString, attachmentRanges);

    const CGFloat maximumWidth = std::isfinite(layoutConstraints.maximumSize.width)
        ? layoutConstraints.maximumSize.width
        : CGFLOAT_MAX;
    NSTextStorage *textStorage =
        [[NSTextStorage alloc] initWithAttributedString:convertedAttributedString];
    NSLayoutManager *layoutManager = [[NSLayoutManager alloc] init];
    layoutManager.usesFontLeading = NO;
    NSTextContainer *textContainer =
        [[NSTextContainer alloc] initWithSize:CGSizeMake(maximumWidth, CGFLOAT_MAX)];
    textContainer.lineFragmentPadding = 0;
    textContainer.maximumNumberOfLines = baseProps.numberOfLines;
    if (baseProps.ellipsizeMode == Code456MarkdownTextEllipsizeMode::Head) {
      textContainer.lineBreakMode = NSLineBreakByTruncatingHead;
    } else if (baseProps.ellipsizeMode == Code456MarkdownTextEllipsizeMode::Middle) {
      textContainer.lineBreakMode = NSLineBreakByTruncatingMiddle;
    } else if (baseProps.ellipsizeMode == Code456MarkdownTextEllipsizeMode::Tail) {
      textContainer.lineBreakMode = NSLineBreakByTruncatingTail;
    } else {
      textContainer.lineBreakMode = NSLineBreakByClipping;
    }
    [layoutManager addTextContainer:textContainer];
    [textStorage addLayoutManager:layoutManager];
    [layoutManager ensureLayoutForTextContainer:textContainer];
    const CGRect usedRect = [layoutManager usedRectForTextContainer:textContainer];

    return {
        std::clamp(
            static_cast<Float>(std::ceil(usedRect.size.width)),
            layoutConstraints.minimumSize.width,
            layoutConstraints.maximumSize.width),
        std::clamp(
            static_cast<Float>(std::ceil(usedRect.size.height)),
            layoutConstraints.minimumSize.height,
            layoutConstraints.maximumSize.height),
    };
}

void Code456MarkdownTextShadowNode::layout(LayoutContext layoutContext) {
  ensureUnsealed();
  setStateData(Code456MarkdownTextStateReal{
    _attributedString,
    _paragraphStyleRanges,
    _attachmentRanges,
  });
}
}
