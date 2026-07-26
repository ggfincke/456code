#import <React/RCTViewManager.h>
#import <React/RCTUIManager.h>
#import "RCTBridge.h"
#import "Utils.h"

@interface Code456MarkdownTextManager : RCTViewManager
@end

@implementation Code456MarkdownTextManager

RCT_EXPORT_MODULE(Code456MarkdownText)

- (UIView *)view
{
  return [[UIView alloc] init];
}

RCT_CUSTOM_VIEW_PROPERTY(color, NSString, UIView)
{
}

@end

@interface Code456MarkdownTextRunManager : RCTViewManager
@end

@implementation Code456MarkdownTextRunManager

RCT_EXPORT_MODULE(Code456MarkdownTextRun)

- (UIView *)view
{
  return nil;
}

@end
