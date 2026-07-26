#pragma once

#include <react/renderer/components/Code456MarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/Code456MarkdownTextSpec/Props.h>
#include <react/renderer/components/Code456MarkdownTextSpec/States.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>

namespace facebook::react {
extern const char Code456MarkdownTextRunComponentName[];

using Code456MarkdownTextRunShadowNode = ConcreteViewShadowNode<
    Code456MarkdownTextRunComponentName,
    Code456MarkdownTextRunProps,
    Code456MarkdownTextRunEventEmitter,
    Code456MarkdownTextRunState>;
}
