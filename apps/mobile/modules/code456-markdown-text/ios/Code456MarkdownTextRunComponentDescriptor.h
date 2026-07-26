#pragma once

#include "Code456MarkdownTextRunShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using Code456MarkdownTextRunComponentDescriptor = ConcreteComponentDescriptor<Code456MarkdownTextRunShadowNode>;

void Code456MarkdownTextRunSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
