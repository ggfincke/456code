// apps/web/src/fincke/CodeThemeSetting.tsx
// appearance row for picking the dark syntax colors of code views, diffs & chat code blocks
import { DEFAULT_UNIFIED_SETTINGS, type CodeTheme } from "@t3tools/contracts/settings";

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

const CODE_THEME_LABELS: Record<CodeTheme, string> = {
  auto: "Match app theme",
  "material-ocean-high-contrast": "Material Ocean High Contrast",
  pierre: "Pierre",
};

function isCodeTheme(value: unknown): value is CodeTheme {
  return typeof value === "string" && value in CODE_THEME_LABELS;
}

export function CodeThemeSetting() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();

  return (
    <SettingsRow
      {...searchableSetting("code-theme")}
      description="Syntax colors for files, diffs and code blocks in dark mode. Match app theme uses Material Ocean High Contrast with Fincke Ocean and Pierre otherwise."
      resetAction={
        settings.codeTheme !== DEFAULT_UNIFIED_SETTINGS.codeTheme ? (
          <SettingResetButton
            label="code theme"
            onClick={() => updateSettings({ codeTheme: DEFAULT_UNIFIED_SETTINGS.codeTheme })}
          />
        ) : null
      }
      control={
        <div className="w-full sm:w-60">
          <Select
            value={settings.codeTheme}
            onValueChange={(value) => {
              if (isCodeTheme(value)) updateSettings({ codeTheme: value });
            }}
          >
            <SelectTrigger size="sm" className="w-full min-w-0" aria-label="Code theme">
              <SelectValue>{CODE_THEME_LABELS[settings.codeTheme]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="auto">Match app theme (default)</SelectItem>
              <SelectItem value="material-ocean-high-contrast">
                Material Ocean High Contrast
              </SelectItem>
              <SelectItem value="pierre">Pierre</SelectItem>
            </SelectPopup>
          </Select>
        </div>
      }
    />
  );
}
