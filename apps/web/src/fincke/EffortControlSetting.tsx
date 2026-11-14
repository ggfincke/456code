// apps/web/src/fincke/EffortControlSetting.tsx
// appearance row for choosing how the effort popover picks a level: segments or a slider
import { DEFAULT_UNIFIED_SETTINGS, type EffortControl } from "@t3tools/contracts/settings";

import { SettingResetButton, SettingsRow } from "../components/settings/settingsLayout";
import { searchableSetting } from "../components/settings/settingsSearch";
import {
  useScopedSettings,
  useUpdateScopedSettings,
} from "../components/settings/useScopedSettings";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";

const EFFORT_CONTROL_LABELS: Record<EffortControl, string> = {
  segments: "Segments",
  slider: "Slider",
};

function isEffortControl(value: unknown): value is EffortControl {
  return typeof value === "string" && value in EFFORT_CONTROL_LABELS;
}

export function EffortControlSetting() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();

  return (
    <SettingsRow
      {...searchableSetting("effort-control")}
      description="Pick reasoning effort in the composer from a row of named levels or by dragging a slider."
      resetAction={
        settings.effortControl !== DEFAULT_UNIFIED_SETTINGS.effortControl ? (
          <SettingResetButton
            label="effort control"
            onClick={() =>
              updateSettings({ effortControl: DEFAULT_UNIFIED_SETTINGS.effortControl })
            }
          />
        ) : null
      }
      control={
        <div className="w-full sm:w-40">
          <Select
            value={settings.effortControl}
            onValueChange={(value) => {
              if (isEffortControl(value)) updateSettings({ effortControl: value });
            }}
          >
            <SelectTrigger size="sm" className="w-full min-w-0" aria-label="Effort control">
              <SelectValue>{EFFORT_CONTROL_LABELS[settings.effortControl]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="segments">Segments (default)</SelectItem>
              <SelectItem value="slider">Slider</SelectItem>
            </SelectPopup>
          </Select>
        </div>
      }
    />
  );
}
