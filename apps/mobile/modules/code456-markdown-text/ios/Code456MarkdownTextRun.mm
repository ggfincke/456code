#import "Code456MarkdownTextRun.h"
#import "Code456MarkdownText.h"
#import "Code456MarkdownTextRunComponentDescriptor.h"
#import <react/renderer/components/Code456MarkdownTextSpec/EventEmitters.h>
#import <react/renderer/components/Code456MarkdownTextSpec/Props.h>
#import <react/renderer/components/Code456MarkdownTextSpec/RCTComponentViewHelpers.h>
#import "RCTFabricComponentsPlugins.h"
#import "Utils.h"

using namespace facebook::react;

@interface Code456MarkdownTextRun () <RCTCode456MarkdownTextRunViewProtocol>

@end

@implementation Code456MarkdownTextRun {
  NSString * _text;
  RCTBubblingEventBlock _onPress;
  RCTBubblingEventBlock _onLongPress;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider
{
    return concreteComponentDescriptorProvider<Code456MarkdownTextRunComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps = std::make_shared<const Code456MarkdownTextRunProps>();
    _props = defaultProps;
  }
  return self;
}

- (void)updateProps:(Props::Shared const &)props oldProps:(Props::Shared const &)oldProps
{
  const auto &oldViewProps = *std::static_pointer_cast<Code456MarkdownTextRunProps const>(_props);
  const auto &newViewProps = *std::static_pointer_cast<Code456MarkdownTextRunProps const>(props);

  if (newViewProps.text != oldViewProps.text) {
    NSString *text = [NSString stringWithUTF8String:newViewProps.text.c_str()];
    _text = text;
  }

  [super updateProps:props oldProps:oldProps];
}

- (void)onPress {
  if (_eventEmitter != nullptr) {
    std::dynamic_pointer_cast<const facebook::react::Code456MarkdownTextRunEventEmitter>(_eventEmitter)
    ->onPress(facebook::react::Code456MarkdownTextRunEventEmitter::OnPress{});
  }
}

- (void)onLongPress {
  if (_eventEmitter != nullptr) {
    std::dynamic_pointer_cast<const facebook::react::Code456MarkdownTextRunEventEmitter>(_eventEmitter)
    ->onLongPress(facebook::react::Code456MarkdownTextRunEventEmitter::OnLongPress{});
  }
}

+ (BOOL)shouldBeRecycled {
  return NO;
}

Class<RCTComponentViewProtocol> Code456MarkdownTextRunCls(void)
{
    return Code456MarkdownTextRun.class;
}

@end
