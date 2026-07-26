#pragma once

#include "Code456MarkdownTextShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using Code456MarkdownTextComponentDescriptor = ConcreteComponentDescriptor<Code456MarkdownTextShadowNode>;

void Code456MarkdownTextSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
