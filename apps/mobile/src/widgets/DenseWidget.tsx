// apps/mobile/src/widgets/DenseWidget.tsx
// renders plan-aware limits and thread activity in native ios widgets

import { HStack, Image, Link, ProgressView, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  accessibilityElement,
  accessibilityLabel,
  background,
  containerBackground,
  environment,
  font,
  foregroundStyle,
  frame,
  layoutPriority,
  lineLimit,
  opacity,
  padding,
  progressViewStyle,
  resizable,
  shapes,
  tint,
  widgetURL,
} from "@expo/ui/swift-ui/modifiers";
import { createWidget, type WidgetEnvironment } from "expo-widgets";

import type { DenseWidgetRow, DenseWidgetSnapshot } from "./denseWidgetSnapshot";

function DenseWidget(
  props: DenseWidgetSnapshot,
  widget: WidgetEnvironment & { showsContainerBackground?: boolean },
) {
  "widget";
  // WidgetKit evaluates the serialized function without this module's scope.
  const now = Math.max(widget.date?.getTime() ?? 0, Date.now());
  const family: string | undefined = widget.widgetFamily;
  const portrait = family === "systemExtraLargePortrait";
  const large = family === "systemLarge" || portrait;
  const extraLarge = widget.widgetFamily === "systemExtraLarge";
  const accessory = widget.widgetFamily === "accessoryRectangular";
  const compact = (!large && !extraLarge) || widget.levelOfDetail === "simplified";
  const stale = !props.live || !props.checkedAt || now >= props.expiresAt;
  const monochrome = widget.widgetRenderingMode !== "fullColor" || widget.isLuminanceReduced;
  const appearance =
    props.theme?.mode === "light" || props.theme?.mode === "dark"
      ? props.theme.mode
      : widget.colorScheme === "light"
        ? "light"
        : "dark";
  const palette =
    !monochrome && !accessory && widget.showsContainerBackground !== false
      ? props.theme?.[appearance]
      : undefined;
  const primary = palette?.foreground ?? "primary";
  const secondary = palette?.secondary ?? "secondary";
  const accent = monochrome ? secondary : (palette?.accent ?? "#80cbc4");
  const blue = monochrome ? secondary : (palette?.info ?? "#82aaff");
  const amber = monochrome
    ? primary
    : (palette?.warning ?? (appearance === "light" ? "#885500" : "#ffcb6b"));
  const attention = props.attention ?? [];
  const running = props.running ?? [];
  const finished = props.finished ?? [];
  const quotas = props.quotas ?? [];
  const attentionCount = props.attentionCount ?? 0;
  const runningCount = props.runningCount ?? 0;
  const shownAttention = attention.slice(0, compact ? 1 : 2);
  const runningLimit = portrait
    ? 6
    : extraLarge
      ? 4
      : compact
        ? attentionCount > 0
          ? 0
          : 1
        : attentionCount > 1
          ? 2
          : 3;
  const shownRunning = running.slice(0, runningLimit);
  // portrait is tall enough to backfill unused running slots with finished rows
  const finishedLimit = portrait
    ? 6 - shownRunning.length
    : compact
      ? runningCount === 0 && attentionCount === 0
        ? 1
        : 0
      : runningCount === 0 && attentionCount === 0
        ? extraLarge
          ? 3
          : 2
        : attentionCount === 0 && runningCount < 3
          ? 1
          : 0;
  const shownFinished = finished.slice(0, finishedLimit);
  // weekly windows reset days out, so an absolute time reads better than a ticking timer
  const resetLabel = (resetsAt: number) => {
    const date = new Date(resetsAt);
    const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return resetsAt - now < 86_400_000
      ? time
      : `${date.toLocaleDateString(undefined, { weekday: "short" })} ${date.toLocaleTimeString(undefined, { hour: "numeric" })}`;
  };

  const providerIcon = (provider: string, size = 18) => {
    const asset =
      provider === "codex"
        ? "WidgetCodex"
        : provider === "claudeAgent"
          ? "WidgetClaude"
          : provider === "coral"
            ? "WidgetCoral"
            : null;
    return asset ? (
      <Image
        assetName={asset}
        modifiers={[
          resizable(),
          frame({ width: size, height: provider === "coral" ? (size * 11) / 18 : size }),
        ]}
      />
    ) : (
      <Image systemName="terminal" size={size} modifiers={[foregroundStyle(secondary)]} />
    );
  };
  const threadRow = (row: DenseWidgetRow, done = false) => (
    <Link
      key={row.key}
      destination={row.url}
      modifiers={[
        accessibilityElement("ignore"),
        accessibilityLabel(
          `${row.title}, ${row.project}, ${row.status}${stale ? ", at last update" : ""}`,
        ),
      ]}
    >
      <HStack spacing={7}>
        {done ? (
          <Image
            systemName="checkmark"
            size={12}
            modifiers={[foregroundStyle(accent), frame({ width: 18 })]}
          />
        ) : (
          providerIcon(row.provider, portrait ? 20 : 18)
        )}
        <VStack
          alignment="leading"
          spacing={1}
          modifiers={[frame({ maxWidth: Infinity, alignment: "leading" })]}
        >
          <Text
            modifiers={[
              font({ size: portrait ? 14 : 12, weight: "medium" }),
              foregroundStyle(done ? secondary : primary),
              lineLimit(1),
            ]}
          >
            {row.title}
          </Text>
          <HStack spacing={0}>
            <Text
              modifiers={[
                font({ size: portrait ? 12 : 11 }),
                foregroundStyle(secondary),
                lineLimit(1),
              ]}
            >
              {row.project} ·{" "}
            </Text>
            <Text
              modifiers={[
                font({ size: portrait ? 12 : 11 }),
                foregroundStyle(done ? secondary : blue),
                lineLimit(1),
                layoutPriority(1),
              ]}
            >
              {row.status}
            </Text>
          </HStack>
        </VStack>
      </HStack>
    </Link>
  );
  const freshness = !props.checkedAt
    ? "Open to sync"
    : stale
      ? `Updated ${new Date(props.checkedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
      : "";

  if (accessory) {
    const row = attention[0] ?? running[0] ?? finished[0];
    return (
      <VStack alignment="leading" spacing={2} modifiers={[widgetURL(row?.url ?? props.url)]}>
        <Text modifiers={[font({ textStyle: "caption", weight: "semibold" }), lineLimit(1)]}>
          {stale
            ? "456code · last known state"
            : attentionCount > 0
              ? `${attentionCount} need you`
              : `${runningCount} running`}
        </Text>
        <Text modifiers={[font({ textStyle: "caption" }), lineLimit(1)]}>
          {row?.title ?? "Open 456code to sync"}
        </Text>
      </VStack>
    );
  }

  return (
    <VStack
      alignment="leading"
      spacing={compact ? 4 : portrait ? 10 : 7}
      modifiers={[
        ...(props.url ? [widgetURL(props.url)] : []),
        ...(palette
          ? [
              containerBackground(palette.background, "widget"),
              environment("colorScheme", appearance),
            ]
          : []),
      ]}
    >
      <HStack spacing={5}>
        <Image assetName="T3Mark" modifiers={[resizable(), frame({ width: 16, height: 16 })]} />
        <Text
          modifiers={[
            font({ size: 12, weight: "semibold" }),
            foregroundStyle(accent),
            lineLimit(1),
          ]}
        >
          456code
        </Text>
        <Spacer />
        <Text
          modifiers={[font({ size: 10 }), foregroundStyle(stale ? amber : secondary), lineLimit(1)]}
        >
          {props.host ?? "Connect"}
          {freshness ? ` · ${freshness}` : ""}
          {!stale && props.checkedAt ? " ·" : ""}
        </Text>
        {!stale && props.checkedAt ? (
          <Text
            date={new Date(props.checkedAt)}
            dateStyle="relative"
            modifiers={[font({ size: 10 }), foregroundStyle(secondary), lineLimit(1)]}
          />
        ) : null}
      </HStack>

      {quotas.length === 0 ? (
        <Link destination={props.usageUrl ?? props.url}>
          <Text modifiers={[font({ size: 11 }), foregroundStyle(secondary), lineLimit(1)]}>
            No plan limits reported · Open usage
          </Text>
        </Link>
      ) : (
        quotas.map((quota) => {
          const quotaColor = quota.provider === "claudeAgent" ? blue : accent;
          const quotaStale = stale || !quota.expiresAt || now >= quota.expiresAt;
          const shownWindows = quota.windows.slice(0, extraLarge ? 2 : 1);
          return (
            <Link
              key={quota.provider}
              destination={props.usageUrl ?? props.url}
              modifiers={[
                accessibilityElement("ignore"),
                accessibilityLabel(
                  `${quota.name}. ${shownWindows.map((window) => `${window.label}, ${window.remaining} percent remaining`).join(". ")}${quotaStale ? ". Last known quota; open to refresh." : ""}`,
                ),
              ]}
            >
              <HStack spacing={7}>
                {providerIcon(quota.provider, 13)}
                <Text
                  modifiers={[
                    font({ size: 11, weight: "medium" }),
                    foregroundStyle(quotaColor),
                    frame({ width: 38, alignment: "leading" }),
                    lineLimit(1),
                  ]}
                >
                  {quota.name}
                </Text>
                {shownWindows.map((window) => {
                  const expired = window.resetsAt !== null && now >= window.resetsAt;
                  return (
                    <VStack
                      key={window.label}
                      alignment="leading"
                      spacing={2}
                      modifiers={[frame({ maxWidth: Infinity, alignment: "leading" })]}
                    >
                      <HStack spacing={4}>
                        <Text
                          modifiers={[font({ size: 11 }), foregroundStyle(secondary), lineLimit(1)]}
                        >
                          {window.label}
                          {quota.totalWindows > shownWindows.length
                            ? ` +${quota.totalWindows - shownWindows.length}`
                            : ""}
                        </Text>
                        <Spacer />
                        <Text
                          modifiers={[
                            font({ size: 12, weight: "semibold" }),
                            foregroundStyle(quotaColor),
                            opacity(quotaStale || expired ? 0.5 : 1),
                            lineLimit(1),
                            layoutPriority(1),
                          ]}
                        >
                          {window.remaining}%
                        </Text>
                        {!compact && window.resetsAt !== null ? (
                          expired ? (
                            <Text modifiers={[font({ size: 10 }), foregroundStyle(secondary)]}>
                              Refresh
                            </Text>
                          ) : (
                            <Text
                              modifiers={[
                                font({ size: 10 }),
                                foregroundStyle(secondary),
                                lineLimit(1),
                              ]}
                            >
                              {resetLabel(window.resetsAt)}
                            </Text>
                          )
                        ) : null}
                      </HStack>
                      {!compact ? (
                        <ProgressView
                          value={window.remaining / 100}
                          modifiers={[
                            progressViewStyle("linear"),
                            frame({ height: 3 }),
                            opacity(quotaStale || expired ? 0.4 : 1),
                            ...(monochrome ? [] : [tint(quotaColor)]),
                          ]}
                        />
                      ) : null}
                    </VStack>
                  );
                })}
                {shownWindows.length === 0 ? (
                  <Text modifiers={[font({ size: 11 }), foregroundStyle(secondary), lineLimit(1)]}>
                    No limits reported
                  </Text>
                ) : null}
              </HStack>
            </Link>
          );
        })
      )}

      {attentionCount > 0 ? (
        <VStack alignment="leading" spacing={4}>
          <Text
            modifiers={[
              font({ size: 11, weight: "semibold" }),
              foregroundStyle(amber),
              lineLimit(1),
            ]}
          >
            {stale ? "Pending at last update" : "Needs you"} · {attentionCount}
          </Text>
          {shownAttention.map((row) => (
            <Link
              key={row.key}
              destination={row.url}
              modifiers={[
                accessibilityElement("ignore"),
                accessibilityLabel(
                  `${row.status}. ${row.detail ?? row.title}. ${row.project}${stale ? ". Pending at last update." : ""}`,
                ),
              ]}
            >
              <HStack
                spacing={7}
                modifiers={[
                  padding({ all: compact ? 5 : 6 }),
                  background(
                    palette?.attentionSurface ?? palette?.track ?? "clear",
                    shapes.roundedRectangle({ cornerRadius: 8 }),
                  ),
                  opacity(stale ? 0.6 : 1),
                ]}
              >
                {providerIcon(row.provider, portrait ? 20 : 16)}
                <VStack
                  alignment="leading"
                  spacing={1}
                  modifiers={[frame({ maxWidth: Infinity, alignment: "leading" })]}
                >
                  <Text
                    modifiers={[
                      font({ size: portrait ? 13 : 11, weight: "medium" }),
                      foregroundStyle(amber),
                      lineLimit(1),
                    ]}
                  >
                    {row.detail ?? row.title}
                  </Text>
                  {!compact ? (
                    <Text
                      modifiers={[
                        font({ size: portrait ? 12 : 10 }),
                        foregroundStyle(secondary),
                        lineLimit(1),
                      ]}
                    >
                      {row.project} · {row.status}
                    </Text>
                  ) : null}
                </VStack>
                <Image
                  systemName={row.request === "question" ? "questionmark" : "terminal"}
                  size={11}
                  modifiers={[foregroundStyle(amber)]}
                />
              </HStack>
            </Link>
          ))}
          {attentionCount > shownAttention.length ? (
            <Link
              destination={props.url}
              label={`+${attentionCount - shownAttention.length} more need you`}
              modifiers={[font({ size: 10 }), foregroundStyle(secondary)]}
            />
          ) : null}
        </VStack>
      ) : null}

      {shownRunning.length > 0 ? (
        <VStack alignment="leading" spacing={compact ? 3 : 5}>
          <Text
            modifiers={[
              font({ size: 11, weight: "semibold" }),
              foregroundStyle(accent),
              lineLimit(1),
            ]}
          >
            {stale ? "Last active" : "Running"} · {runningCount}
          </Text>
          {shownRunning.map((row) => threadRow(row))}
        </VStack>
      ) : null}
      {runningCount > shownRunning.length ? (
        <Link
          destination={props.url}
          label={`+${runningCount - shownRunning.length} running${stale ? " at last update" : ""}`}
          modifiers={[font({ size: 10 }), foregroundStyle(secondary)]}
        />
      ) : null}

      {runningCount === 0 && attentionCount === 0 ? (
        <Text
          modifiers={[font({ size: 12, weight: "medium" }), foregroundStyle(primary), lineLimit(1)]}
        >
          {!props.checkedAt
            ? "Open 456code to sync"
            : stale
              ? "No activity at last update"
              : "Nothing running or waiting"}
        </Text>
      ) : null}
      {shownFinished.length > 0 ? (
        <VStack alignment="leading" spacing={4}>
          <Text modifiers={[font({ size: 11 }), foregroundStyle(secondary), lineLimit(1)]}>
            Recently finished
          </Text>
          {shownFinished.map((row) => threadRow(row, true))}
        </VStack>
      ) : null}
      <Spacer minLength={0} />
    </VStack>
  );
}

export default createWidget("DenseWidget", DenseWidget);
