import { useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useScaledTextRole } from "../../features/settings/appearance/useScaledTextRole";

/**
 * Shared Android header geometry; class-based spacing uses the app's 14dp rem.
 * `singleLine` sizes the toolbar for a title row with the subtitle inline.
 */
export function useToolbarLayout(embedded = false, singleLine = false) {
  const insets = useSafeAreaInsets();
  const title = useScaledTextRole("title");
  const subtitle = useScaledTextRole("label");
  const { fontScale } = useWindowDimensions();
  return {
    height: Math.ceil(
      singleLine
        ? Math.max(48, title.lineHeight * fontScale + 1)
        : Math.max(56, (title.lineHeight + subtitle.lineHeight) * fontScale + 1),
    ),
    paddingTop: embedded ? 8 : Math.max(insets.top, 12),
    paddingBottom: 7,
  };
}
