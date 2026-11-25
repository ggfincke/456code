import { Link } from "@tanstack/react-router";
import {
  DEFAULT_WORKFLOW_SKIPPED_RUNS_KEPT,
  MAX_WORKFLOW_SKIPPED_RUNS_KEPT,
} from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";

import { NumberField, NumberFieldGroup, NumberFieldInput } from "../ui/number-field";
import { Switch } from "../ui/switch";
import { commitNumberFieldOnEnter } from "./commitNumberFieldOnEnter";
import { ScopedSwitch } from "./ScopedSwitch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { LegacyFeaturesSection } from "./SettingsPanels";
import { APP_BASE_NAME } from "~/branding";

/** Features still settling in, plus the plan mode and projects sidebar switches. */
export function LabsSettingsPanel() {
  const gt = useGT();
  return (
    <SettingsPageContainer>
      <SettingsSection id="beta" title={gt("Beta")}>
        <BoringSidebarRow />
        <LinkedEnvironmentsRow />
        <WorkflowsRow />
        <WorkflowSkippedRunsRow />
        <PromptSuggestionsRow />
        <SimlockHostsRow />
        <FastWorktreeCheckoutRow />
      </SettingsSection>
      <LegacyFeaturesSection />
    </SettingsPageContainer>
  );
}

function BoringSidebarRow() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const gt = useGT();
  return (
    <SettingsRow
      {...searchableSetting("boring-sidebar")}
      description={gt(
        "Group sidebar threads into project folders. Pinned threads stay on top, and Snoozed and Archived stay below the folders.",
      )}
      control={
        <Switch
          checked={settings.boringSidebarEnabled}
          onCheckedChange={(checked) => updateSettings({ boringSidebarEnabled: Boolean(checked) })}
          aria-label={gt("Boring sidebar (group by project)")}
        />
      }
    >
      {settings.boringSidebarEnabled ? (
        <div className="mt-2 mb-2 border-l-2 border-border/60 ps-3">
          <BoringSidebarMultilineRow />
        </div>
      ) : null}
    </SettingsRow>
  );
}

function BoringSidebarMultilineRow() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const gt = useGT();
  return (
    <SettingsRow
      {...searchableSetting("boring-sidebar-multiline")}
      className="px-0 py-2 sm:px-0"
      description={gt(
        "Show folder threads on two lines: the title, then the branch, pull request, and agent.",
      )}
      control={
        <Switch
          checked={settings.boringSidebarMultilineRows}
          onCheckedChange={(checked) =>
            updateSettings({ boringSidebarMultilineRows: Boolean(checked) })
          }
          aria-label={gt("Two-line folder rows")}
        />
      }
    />
  );
}

function LinkedEnvironmentsRow() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const gt = useGT();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("linked-environments-beta")}
      settingKeys={["linkedEnvironmentsEnabled"]}
      description={
        <T>
          Let agents here work on your other machines, and theirs here. Turn it on for each machine,
          then link them in{" "}
          <Link to="/settings/connections" className="underline underline-offset-2">
            Connections
          </Link>
          . While off, nothing new starts over a link; running tasks finish.
        </T>
      }
      control={
        <ScopedSwitch
          settingKeys={["linkedEnvironmentsEnabled"]}
          checked={settings.linkedEnvironmentsEnabled}
          onCheckedChange={(checked) =>
            updateSettings({ linkedEnvironmentsEnabled: Boolean(checked) })
          }
          aria-label={gt("Linked environments")}
        />
      }
    />
  );
}

function WorkflowsRow() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const gt = useGT();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("workflows-beta")}
      settingKeys={["workflowsEnabled"]}
      description={gt(
        "Run multi-step workflows from files in the workflows folder of this server's data directory. Open them from the command palette. While off, nothing in that folder runs; runs wait until it is on again.",
      )}
      control={
        <ScopedSwitch
          settingKeys={["workflowsEnabled"]}
          checked={settings.workflowsEnabled}
          onCheckedChange={(checked) => updateSettings({ workflowsEnabled: Boolean(checked) })}
          aria-label={gt("Workflows")}
        />
      }
    />
  );
}

const NO_GROUPING: Intl.NumberFormatOptions = { useGrouping: false };

export function WorkflowSkippedRunsRow() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["workflowSkippedRunsKept"]);
  const gt = useGT();
  if (!settings.workflowsEnabled) return null;
  const kept = settings.workflowSkippedRunsKept;
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("workflow-skipped-runs")}
      settingKeys={["workflowSkippedRunsKept"]}
      description={gt(
        "How many skipped runs each workflow keeps in its history. Older skipped runs are deleted; runs that did something are always kept.",
      )}
      resetAction={
        mixed || kept !== DEFAULT_WORKFLOW_SKIPPED_RUNS_KEPT ? (
          <SettingResetButton
            ariaLabel={gt("Reset skipped runs kept to default")}
            onClick={() =>
              updateSettings({ workflowSkippedRunsKept: DEFAULT_WORKFLOW_SKIPPED_RUNS_KEPT })
            }
          />
        ) : null
      }
      control={
        <div className="w-24">
          <NumberField
            value={mixed ? null : kept}
            min={0}
            max={MAX_WORKFLOW_SKIPPED_RUNS_KEPT}
            format={NO_GROUPING}
            size="sm"
            onValueCommitted={(value) => {
              if (value === null || !Number.isInteger(value) || (!mixed && value === kept)) return;
              updateSettings({ workflowSkippedRunsKept: value });
            }}
          >
            <NumberFieldGroup>
              <NumberFieldInput
                aria-label={gt("Skipped runs kept")}
                placeholder={mixed ? gt("Mixed") : undefined}
                onKeyDown={commitNumberFieldOnEnter}
              />
            </NumberFieldGroup>
          </NumberField>
        </div>
      }
    />
  );
}

function PromptSuggestionsRow() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const gt = useGT();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("prompt-suggestions-beta")}
      settingKeys={["promptSuggestionsEnabled"]}
      description={gt(
        "Show a predicted next message in the empty composer after a Claude or Codex turn. Tab uses it. Each is an extra cached request on your plan. Needs Codex 0.165+. Claude threads update on restart.",
      )}
      control={
        <ScopedSwitch
          settingKeys={["promptSuggestionsEnabled"]}
          checked={settings.promptSuggestionsEnabled}
          onCheckedChange={(checked) =>
            updateSettings({ promptSuggestionsEnabled: Boolean(checked) })
          }
          aria-label={gt("Suggest next prompt")}
        />
      }
    />
  );
}

function SimlockHostsRow() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const gt = useGT();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("simlock-hosts")}
      settingKeys={["simlockDeviceHostsEnabled"]}
      description={
        <T>
          Let the Device panel lease simulators and emulators from your own{" "}
          <a
            href="https://incubator.callstack.com/simlock/"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            Simlock
          </a>{" "}
          pool, added in{" "}
          <Link to="/settings/devices" className="underline underline-offset-2">
            Devices
          </Link>
          . An alpha that may change or break. <Var>{APP_BASE_NAME}</Var> never installs Simlock.
        </T>
      }
      control={
        <ScopedSwitch
          settingKeys={["simlockDeviceHostsEnabled"]}
          checked={settings.simlockDeviceHostsEnabled}
          onCheckedChange={(checked) =>
            updateSettings({ simlockDeviceHostsEnabled: Boolean(checked) })
          }
          aria-label={gt("Simlock device hosts")}
        />
      }
    />
  );
}

/** Shows only when every machine in scope is a Mac, since only macOS servers honor it. */
function FastWorktreeCheckoutRow() {
  const searchableSetting = useSearchableSetting();
  const { scope, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const gt = useGT();
  if (
    scope.kind === "project" ||
    scope.kind === "checkout" ||
    connectedEnvironments.length === 0 ||
    connectedEnvironments.some(
      (environment) =>
        environment.serverConfig?.environment.capabilities.fastWorktreeCheckout !== true,
    )
  )
    return null;
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("worktree-fast-checkout")}
      settingKeys={["fastWorktreeCheckout"]}
      description={gt(
        "On a Mac, clone new worktrees from a checkout cached in the data directory instead of writing every file. Uses Git’s normal checkout when it can’t. Turning it off deletes the cache.",
      )}
      control={
        <ScopedSwitch
          settingKeys={["fastWorktreeCheckout"]}
          checked={settings.fastWorktreeCheckout}
          onCheckedChange={(checked) => updateSettings({ fastWorktreeCheckout: Boolean(checked) })}
          aria-label={gt("Fast worktree checkout")}
        />
      }
    />
  );
}
