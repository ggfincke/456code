import { SettingsPageContainer } from "./settingsLayout";
import { LegacyFeaturesSection } from "./SettingsPanels";

// 456code drops upstream's Beta section. Its only row turned on guest links, which need T3 Connect
// and are not part of this fork.
/** Legacy behavior kept for people who rely on it. */
export function LabsSettingsPanel() {
  return (
    <SettingsPageContainer>
      <LegacyFeaturesSection />
    </SettingsPageContainer>
  );
}
