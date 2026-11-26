// apps/web/src/fincke/ProjectFolderTintSetting.tsx
// appearance row for tinting the sidebar's fallback project folders
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { SettingResetButton, SettingsRow } from "../components/settings/settingsLayout";
import { useSearchableSetting } from "../components/settings/settingsSearch";
import {
  useScopedSettings,
  useUpdateScopedSettings,
} from "../components/settings/useScopedSettings";
import { Switch } from "../components/ui/switch";

export function ProjectFolderTintSetting() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();

  return (
    <SettingsRow
      {...searchableSetting("project-folder-tint")}
      description="Fill the folder icon of projects without their own icon with a color picked from the project."
      resetAction={
        settings.sidebarProjectFolderTint !== DEFAULT_UNIFIED_SETTINGS.sidebarProjectFolderTint ? (
          <SettingResetButton
            ariaLabel="Reset project folder colors to default"
            onClick={() =>
              updateSettings({
                sidebarProjectFolderTint: DEFAULT_UNIFIED_SETTINGS.sidebarProjectFolderTint,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.sidebarProjectFolderTint}
          onCheckedChange={(checked) =>
            updateSettings({ sidebarProjectFolderTint: Boolean(checked) })
          }
          aria-label="Color project folders"
        />
      }
    />
  );
}
