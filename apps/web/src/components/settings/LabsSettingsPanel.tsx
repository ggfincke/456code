import { SettingsPageContainer } from "./settingsLayout";
import { LegacyFeaturesSection } from "./SettingsPanels";

// 456code hides upstream's Beta section and its Guest links row: guest sharing needs T3 Connect,
// which this fork does not use. With `guestSharingEnabled` left at its default (off), every share
// entry point stays hidden.
/** Legacy behavior kept for people who rely on it. */
export function LabsSettingsPanel() {
  return (
    <SettingsPageContainer>
      <LegacyFeaturesSection />
    </SettingsPageContainer>
  );
}
