// apps/mobile/src/widgets/DenseWidget.tsx
// renders plan-aware limits and thread activity in native ios widgets

import { HStack, Image, Link, ProgressView, Spacer, Text, VStack, ZStack } from "@expo/ui/swift-ui";
import {
  accessibilityElement,
  accessibilityLabel,
  aspectRatio,
  background,
  containerBackground,
  environment,
  fixedSize,
  font,
  foregroundStyle,
  frame,
  kerning,
  layoutPriority,
  lineLimit,
  opacity,
  padding,
  progressViewStyle,
  resizable,
  shapes,
  textCase,
  tint,
  widgetURL,
} from "@expo/ui/swift-ui/modifiers";
import { createWidget, type WidgetEnvironment } from "expo-widgets";

import type {
  DenseWidgetPullRequest,
  DenseWidgetRow,
  DenseWidgetSnapshot,
} from "./denseWidgetSnapshot";

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
  const red = monochrome ? primary : (palette?.danger ?? "#f07178");
  const surface = palette?.surface ?? "clear";
  const toneSurface = (color: string) =>
    color === red
      ? palette?.dangerSurface
      : color === blue
        ? palette?.infoSurface
        : color === accent
          ? palette?.accentSurface
          : palette?.track;
  const attention = props.attention ?? [];
  const running = props.running ?? [];
  const finished = props.finished ?? [];
  const pullRequests = props.pullRequests ?? [];
  const quotas = props.quotas ?? [];
  const attentionCount = props.attentionCount ?? 0;
  const runningCount = props.runningCount ?? 0;
  const pullRequestCount = props.pullRequestCount ?? 0;
  // sections fill one shared row budget in priority order, so short lists leave room for the next
  let budget = portrait ? 6.5 : extraLarge ? 5 : large ? 4 : 1.2;
  const take = <T,>(rows: readonly T[], max: number, cost: number) => {
    const count = Math.max(0, Math.min(rows.length, max, Math.floor((budget - 0.4) / cost)));
    if (count > 0) budget -= 0.4 + count * cost;
    return rows.slice(0, count);
  };
  const shownAttention = take(attention, compact ? 1 : 2, 1);
  const shownRunning = take(running, portrait ? 5 : 4, 1);
  const shownPullRequests = take(
    compact ? pullRequests.filter((pullRequest) => pullRequest.tone === "alert") : pullRequests,
    portrait ? 4 : 3,
    1,
  );
  const shownFinished = take(finished, portrait ? 6 : 3, 0.5);
  const timeLabel = (at: number) =>
    new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  // finished rows keep a fixed timestamp; a relative age would go stale between timeline reloads
  const finishedLabel = (at: number) =>
    now - at < 86_400_000 && new Date(at).getDate() === new Date(now).getDate()
      ? timeLabel(at)
      : new Date(at).toLocaleDateString(undefined, { weekday: "short" });
  // weekly windows reset days out, so an absolute time reads better than a ticking timer
  const resetLabel = (resetsAt: number) => {
    const date = new Date(resetsAt);
    return resetsAt - now < 86_400_000
      ? timeLabel(resetsAt)
      : `${date.toLocaleDateString(undefined, { weekday: "short" })} ${date.toLocaleTimeString(undefined, { hour: "numeric" })}`;
  };
  const titleSize = portrait ? 14 : 12;
  const detailSize = portrait ? 12 : 11;

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
  const sectionHeader = (label: string, count: number | null, color: string) => (
    <HStack spacing={6}>
      <Text
        modifiers={[
          font({ size: 10, weight: "bold" }),
          textCase("uppercase"),
          kerning(0.8),
          foregroundStyle(secondary),
          lineLimit(1),
        ]}
      >
        {label}
      </Text>
      {count !== null ? (
        <Text
          modifiers={[
            font({ size: 10, weight: "bold" }),
            foregroundStyle(color),
            padding({ horizontal: 6, vertical: 1 }),
            background(toneSurface(color) ?? "clear", shapes.capsule()),
            lineLimit(1),
          ]}
        >
          {count}
        </Text>
      ) : null}
    </HStack>
  );
  const pill = (label: string, color: string) => (
    <Text
      modifiers={[
        font({ size: portrait ? 11 : 10, weight: "semibold" }),
        foregroundStyle(color),
        padding({ horizontal: 7, vertical: 2 }),
        background(toneSurface(color) ?? "clear", shapes.capsule()),
        lineLimit(1),
        layoutPriority(1),
      ]}
    >
      {label}
    </Text>
  );
  // grouped rows sit on one soft card, echoing the app's grouped list surfaces
  const card = (children: ReturnType<typeof pill>[]) => (
    <VStack
      alignment="leading"
      spacing={compact ? 4 : 8}
      modifiers={[
        frame({ maxWidth: Infinity, alignment: "leading" }),
        padding({ all: compact ? 6 : 9 }),
        background(surface, shapes.roundedRectangle({ cornerRadius: 14 })),
      ]}
    >
      {children}
    </VStack>
  );
  const twoLineRow = (input: {
    key: string;
    url: string;
    label: string;
    icon: ReturnType<typeof providerIcon>;
    title: string;
    detail: string;
    status: string | null;
    statusColor: string;
    trailing?: ReturnType<typeof providerIcon>;
  }) => (
    <Link
      key={input.key}
      destination={input.url}
      modifiers={[accessibilityElement("ignore"), accessibilityLabel(input.label)]}
    >
      <HStack spacing={8} modifiers={[opacity(stale ? 0.6 : 1)]}>
        {input.icon}
        <VStack
          alignment="leading"
          spacing={1}
          modifiers={[frame({ maxWidth: Infinity, alignment: "leading" })]}
        >
          <Text
            modifiers={[
              font({ size: titleSize, weight: "medium" }),
              foregroundStyle(primary),
              lineLimit(1),
            ]}
          >
            {input.title}
          </Text>
          <HStack spacing={6}>
            <Text
              modifiers={[font({ size: detailSize }), foregroundStyle(secondary), lineLimit(1)]}
            >
              {input.detail}
            </Text>
            {input.status ? pill(input.status, input.statusColor) : null}
          </HStack>
        </VStack>
        {input.trailing ?? null}
      </HStack>
    </Link>
  );
  const runningRow = (row: DenseWidgetRow) =>
    twoLineRow({
      key: row.key,
      url: row.url,
      label: `${row.title}, ${row.project}, ${row.status}${stale ? ", at last update" : ""}`,
      icon: providerIcon(row.provider, portrait ? 20 : 18),
      title: row.title,
      // "working" is implied by the section, so only unusual states take the status slot
      detail:
        row.status === "Working" ? `${row.project} · since ${timeLabel(row.at)}` : row.project,
      status: row.status === "Working" ? null : row.status,
      statusColor: blue,
    });
  const pullRequestRow = (pullRequest: DenseWidgetPullRequest) => {
    const color =
      pullRequest.tone === "alert" ? red : pullRequest.tone === "ready" ? accent : secondary;
    return twoLineRow({
      key: pullRequest.key,
      url: pullRequest.url,
      label: `Pull request ${pullRequest.number}, ${pullRequest.title}, ${pullRequest.status}${pullRequest.watched ? ", watched" : ""}${stale ? ", at last update" : ""}`,
      icon: (
        <Image
          systemName={pullRequest.glyph}
          size={portrait ? 15 : 13}
          modifiers={[foregroundStyle(color), frame({ width: portrait ? 20 : 18 })]}
        />
      ),
      title: `#${pullRequest.number} ${pullRequest.title}`,
      detail: pullRequest.repository,
      status: pullRequest.status,
      statusColor: color,
      trailing: pullRequest.watched ? (
        <Image systemName="eye" size={10} modifiers={[foregroundStyle(secondary)]} />
      ) : undefined,
    });
  };
  const finishedRow = (row: DenseWidgetRow) => (
    <Link
      key={row.key}
      destination={row.url}
      modifiers={[
        accessibilityElement("ignore"),
        accessibilityLabel(`${row.title}, ${row.project}, finished ${finishedLabel(row.at)}`),
      ]}
    >
      <HStack spacing={8}>
        <Image
          systemName="checkmark"
          size={11}
          modifiers={[foregroundStyle(accent), frame({ width: portrait ? 20 : 18 })]}
        />
        <Text
          modifiers={[
            font({ size: portrait ? 13 : 11 }),
            foregroundStyle(secondary),
            lineLimit(1),
            frame({ maxWidth: Infinity, alignment: "leading" }),
          ]}
        >
          {row.title}
        </Text>
        <Text
          modifiers={[
            font({ size: 10 }),
            foregroundStyle(secondary),
            lineLimit(1),
            layoutPriority(1),
          ]}
        >
          {finishedLabel(row.at)}
        </Text>
      </HStack>
    </Link>
  );
  const freshness = !props.checkedAt
    ? "Open to sync"
    : stale
      ? `Updated ${timeLabel(props.checkedAt)}`
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

  const hostLabel = (
    <Text
      modifiers={[
        font({ size: 10, weight: "medium" }),
        foregroundStyle(stale ? amber : secondary),
        lineLimit(1),
      ]}
    >
      {props.host ?? "Connect"}
      {freshness ? ` · ${freshness}` : ""}
    </Text>
  );
  const title = (
    <Text
      modifiers={[
        font({ size: portrait ? 17 : compact ? 13 : 15, weight: "bold" }),
        foregroundStyle(compact || monochrome ? accent : primary),
        lineLimit(1),
      ]}
    >
      456code
    </Text>
  );
  const showWave = !compact && !monochrome;

  return (
    <VStack
      alignment="leading"
      spacing={compact ? 5 : portrait ? 10 : 9}
      modifiers={[
        ...(props.url ? [widgetURL(props.url)] : []),
        ...(palette
          ? [
              containerBackground(palette.background, "widget"),
              // ios lays a sheen over the container background, so full color repaints it as
              // content bled past the margins to land the exact theme color
              ...(monochrome
                ? []
                : [padding({ all: 30 }), background(palette.background), padding({ all: -30 })]),
              environment("colorScheme", appearance),
            ]
          : []),
      ]}
    >
      {showWave ? (
        // the whole ribbon field bled to the widget edges; the brand tucks under its high left
        // end & the host sits above its low right end. fixed vertical size stops the vstack
        // squeezing it below the height its full width needs
        <ZStack
          modifiers={[
            aspectRatio({ ratio: 470 / 163, contentMode: "fit" }),
            padding({ top: -6, bottom: -6, horizontal: -18 }),
            fixedSize({ vertical: true }),
          ]}
        >
          <Image assetName="WidgetWave" modifiers={[resizable()]} />
          <VStack
            alignment="leading"
            modifiers={[padding({ top: 16, leading: 18, bottom: 2, trailing: 18 })]}
          >
            <HStack>
              <Spacer />
              {hostLabel}
            </HStack>
            <Spacer />
            {title}
          </VStack>
        </ZStack>
      ) : (
        <HStack spacing={5}>
          <Image assetName="T3Mark" modifiers={[resizable(), frame({ width: 16, height: 16 })]} />
          {title}
          <Spacer />
          {hostLabel}
        </HStack>
      )}

      {quotas.length === 0 ? (
        <Link destination={props.usageUrl ?? props.url}>
          <Text modifiers={[font({ size: 11 }), foregroundStyle(secondary), lineLimit(1)]}>
            No plan limits reported · Open usage
          </Text>
        </Link>
      ) : (
        <HStack spacing={8}>
          {quotas.map((quota) => {
            const quotaColor = quota.provider === "claudeAgent" ? blue : accent;
            const quotaStale = stale || !quota.expiresAt || now >= quota.expiresAt;
            // windows arrive tightest first, so the tile always shows what runs out soonest
            const window = quota.windows[0];
            const expired = !!window && window.resetsAt !== null && now >= window.resetsAt;
            const dim = quotaStale || expired;
            return (
              <Link
                key={quota.provider}
                destination={props.usageUrl ?? props.url}
                modifiers={[
                  accessibilityElement("ignore"),
                  accessibilityLabel(
                    `${quota.name}. ${window ? `${window.label}, ${window.remaining} percent left` : "No limits reported"}${quotaStale ? ". Last known quota; open to refresh." : ""}`,
                  ),
                  frame({ maxWidth: Infinity }),
                ]}
              >
                <VStack
                  alignment="leading"
                  spacing={compact ? 3 : 5}
                  modifiers={[
                    frame({ maxWidth: Infinity, alignment: "leading" }),
                    padding({ all: compact ? 6 : 10 }),
                    background(surface, shapes.roundedRectangle({ cornerRadius: 14 })),
                  ]}
                >
                  <HStack spacing={5}>
                    {providerIcon(quota.provider, 13)}
                    <Text
                      modifiers={[
                        font({ size: 11, weight: "semibold" }),
                        foregroundStyle(secondary),
                        lineLimit(1),
                      ]}
                    >
                      {quota.name}
                    </Text>
                    <Spacer minLength={4} />
                    {!compact && window && window.resetsAt !== null ? (
                      <Text
                        modifiers={[font({ size: 10 }), foregroundStyle(secondary), lineLimit(1)]}
                      >
                        {expired ? "Refresh" : resetLabel(window.resetsAt)}
                      </Text>
                    ) : null}
                  </HStack>
                  <HStack spacing={3}>
                    <Text
                      modifiers={[
                        font({ size: compact ? 14 : portrait ? 20 : 18, weight: "bold" }),
                        foregroundStyle(quotaColor),
                        opacity(dim ? 0.5 : 1),
                        lineLimit(1),
                      ]}
                    >
                      {window ? `${window.remaining}%` : "–"}
                    </Text>
                    <Text
                      modifiers={[font({ size: 10 }), foregroundStyle(secondary), lineLimit(1)]}
                    >
                      {window ? "left" : "No limits"}
                    </Text>
                  </HStack>
                  {window ? (
                    <ProgressView
                      value={window.remaining / 100}
                      modifiers={[
                        progressViewStyle("linear"),
                        opacity(dim ? 0.4 : 1),
                        ...(monochrome ? [] : [tint(quotaColor)]),
                      ]}
                    />
                  ) : null}
                </VStack>
              </Link>
            );
          })}
        </HStack>
      )}

      {shownAttention.length > 0 ? (
        <VStack alignment="leading" spacing={4}>
          {sectionHeader(stale ? "Pending at last update" : "Needs you", attentionCount, amber)}
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
                spacing={8}
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
        <VStack alignment="leading" spacing={compact ? 3 : 6}>
          {sectionHeader(stale ? "Last active" : "Running", runningCount, accent)}
          {card(shownRunning.map(runningRow))}
          {runningCount > shownRunning.length ? (
            <Link
              destination={props.url}
              label={`+${runningCount - shownRunning.length} more running`}
              modifiers={[font({ size: 10 }), foregroundStyle(secondary)]}
            />
          ) : null}
        </VStack>
      ) : null}

      {shownAttention.length +
        shownRunning.length +
        shownPullRequests.length +
        shownFinished.length ===
      0 ? (
        <Text modifiers={[font({ size: 11 }), foregroundStyle(secondary), lineLimit(1)]}>
          {!props.checkedAt
            ? "Open 456code to sync"
            : stale
              ? "No activity at last update"
              : "Nothing running or waiting"}
        </Text>
      ) : null}

      {shownFinished.length > 0 ? (
        <VStack alignment="leading" spacing={5}>
          {sectionHeader("Finished", null, accent)}
          {card(shownFinished.map(finishedRow))}
        </VStack>
      ) : null}
      {/* prs anchor to the bottom edge as a footer; spare height collects above them */}
      <Spacer minLength={0} />
      {shownPullRequests.length > 0 ? (
        <VStack alignment="leading" spacing={compact ? 3 : 6}>
          {sectionHeader("Pull requests", pullRequestCount, accent)}
          {card(shownPullRequests.map(pullRequestRow))}
        </VStack>
      ) : null}
    </VStack>
  );
}

export default createWidget("DenseWidget", DenseWidget);
