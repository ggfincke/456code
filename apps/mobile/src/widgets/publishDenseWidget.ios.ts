// apps/mobile/src/widgets/publishDenseWidget.ios.ts
// publishes bounded dense widget timelines to widgetkit

import { denseWidgetTimeline, type DenseWidgetSnapshot } from "./denseWidgetSnapshot";

export async function publishDenseWidget(snapshot: DenseWidgetSnapshot) {
  const { default: widget } = await import("./DenseWidget");
  widget.updateTimeline(denseWidgetTimeline(snapshot, Date.now()));
}
