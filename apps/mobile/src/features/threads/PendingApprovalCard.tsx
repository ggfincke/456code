// apps/mobile/src/features/threads/PendingApprovalCard.tsx
// presents provider approvals with complete details and native touch actions

import { Button } from "../../components/ui/Button";
import type {
  ProviderApprovalDecision,
  ProviderApprovalOption,
  RuntimeRequestId,
} from "@t3tools/contracts";
import {
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
} from "@t3tools/client-runtime/state/thread-requests";
import { T, useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import type { PendingApproval } from "../../lib/threadActivity";

export interface PendingApprovalCardProps {
  readonly canOperateThread: boolean;
  readonly approval: PendingApproval;
  readonly respondingApprovalId: RuntimeRequestId | null;
  readonly onRespond: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

export function PendingApprovalCard(props: PendingApprovalCardProps) {
  const gt = useGT();
  const m = useMessages();
  const options: ReadonlyArray<ProviderApprovalOption> = props.approval.options ?? [
    { decision: "accept", label: gt("Allow once") },
    { decision: "acceptForSession", label: gt("Allow session") },
    {
      decision: "decline",
      label: gt("Decline", { $context: "verb, rejects the approval request" }),
    },
  ];
  const warnings = [
    ...new Set(options.flatMap((option) => (option.warning ? [option.warning] : []))),
  ];
  const canRespond = props.approval.responseCapability === "live";
  const disabled = !canRespond || props.respondingApprovalId === props.approval.requestId;
  const [explanationOpen, setExplanationOpen] = useState(false);
  return (
    <View className="overflow-hidden rounded-[20px] border border-border bg-card-alt">
      <View className="flex-row items-center gap-2 border-b border-warning-border bg-warning-foreground/10 px-4 py-3">
        <SymbolView
          name="exclamationmark.circle"
          size={16}
          tintColorClassName="accent-warning-foreground"
        />
        <Text className="font-t3-bold text-xs text-warning-foreground">
          <T>Needs approval</T>
        </Text>
      </View>
      <View className="gap-2.5 p-4">
        <Text className="font-t3-bold text-lg text-foreground">
          {props.approval.appName ?? props.approval.requestKind}
        </Text>
        {props.approval.detail ? (
          <View className="rounded-xl border border-border bg-card p-3">
            <Text
              selectable
              className={
                props.approval.requestKind === "mcp-elicitation"
                  ? "font-sans text-sm leading-normal text-foreground"
                  : "font-mono text-sm leading-normal text-foreground"
              }
            >
              {props.approval.detail}
            </Text>
          </View>
        ) : null}
        {props.approval.reason ? (
          <Text className="font-sans text-xs leading-normal text-warning-foreground">
            {props.approval.reason}
          </Text>
        ) : null}
        {props.approval.fullAccessOverride ? (
          <Pressable
            accessibilityRole="button"
            className="min-h-11 justify-center"
            accessibilityState={{ expanded: explanationOpen }}
            onPress={() => setExplanationOpen((open) => !open)}
          >
            <Text className="font-t3-bold text-xs text-foreground-secondary underline">
              {m(FULL_ACCESS_OVERRIDE_QUESTION)}
            </Text>
            {explanationOpen ? (
              <Text className="mt-1 font-sans text-xs leading-normal text-foreground-muted">
                {fullAccessOverrideExplanation(props.approval.fullAccessOverride, m)}
              </Text>
            ) : null}
          </Pressable>
        ) : null}
        {!canRespond ? (
          <Text className="font-sans text-sm leading-5 text-foreground-muted">
            <T>
              The provider process for this request is no longer available. Interrupt or restart the
              run to continue.
            </T>
          </Text>
        ) : null}
        {warnings.map((warning) => (
          <Text key={warning} className="font-sans text-xs leading-normal text-warning-foreground">
            {warning}
          </Text>
        ))}
        <View className="gap-2">
          {options.map((option) => (
            <Button
              key={option.decision}
              label={option.label}
              tone={option.decision === "accept" ? "primary" : "secondary"}
              disabled={disabled || !props.canOperateThread}
              onPress={() => void props.onRespond(props.approval.requestId, option.decision)}
              fullWidth
            />
          ))}
        </View>
        {!props.canOperateThread ? (
          <Text className="font-sans text-xs text-foreground-muted">
            <T>This connection cannot respond to approvals.</T>
          </Text>
        ) : null}
      </View>
    </View>
  );
}
