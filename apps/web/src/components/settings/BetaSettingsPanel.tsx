import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { Switch } from "../ui/switch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

// 456code hides upstream's Guest links row: guest sharing needs T3 Connect, which this fork does
// not use. With `guestSharingEnabled` left at its default (off), every share entry point stays hidden.
/** Features that are still settling in. Some are on by default; each can be turned off here. */
export function BetaSettingsPanel() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsPageContainer>
      <SettingsSection id="beta" title="Beta">
        <SettingsRow
          {...searchableSetting("new-design")}
          description="A true black dark mode, dimmer read threads, and simpler composer controls. Turn it off for the classic look."
          resetAction={
            settings.redesignEnabled !== DEFAULT_UNIFIED_SETTINGS.redesignEnabled ? (
              <SettingResetButton
                label="new design"
                onClick={() =>
                  updateSettings({ redesignEnabled: DEFAULT_UNIFIED_SETTINGS.redesignEnabled })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.redesignEnabled}
              onCheckedChange={(checked) => updateSettings({ redesignEnabled: Boolean(checked) })}
              aria-label="New design"
            />
          }
        />
        <SettingsRow
          {...searchableSetting("working-shelf")}
          description="Fold working and monitoring threads into a Working section. They return to the top of the inbox when they need you."
          resetAction={
            settings.sidebarWorkingShelfEnabled !==
            DEFAULT_UNIFIED_SETTINGS.sidebarWorkingShelfEnabled ? (
              <SettingResetButton
                label="working section"
                onClick={() =>
                  updateSettings({
                    sidebarWorkingShelfEnabled: DEFAULT_UNIFIED_SETTINGS.sidebarWorkingShelfEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.sidebarWorkingShelfEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ sidebarWorkingShelfEnabled: Boolean(checked) })
              }
              aria-label="Working section"
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
