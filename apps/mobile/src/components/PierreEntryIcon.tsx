// apps/mobile/src/components/PierreEntryIcon.tsx
// native file and directory icons with active theme colors
import { SymbolView } from "./ui/AppSymbol";
import { Image, type ImageStyle, type StyleProp } from "react-native";

import { markdownFileIconSource } from "../lib/markdownFileIcons";
import { resolveMarkdownFileIcon } from "../lib/markdownLinks";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { finckeFileIconColor } from "../fincke/file-icon-color";

export function PierreEntryIcon(props: {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly size?: number;
  readonly style?: StyleProp<ImageStyle>;
}) {
  const size = props.size ?? 16;
  const { themeId } = useAppearancePreferences();
  const icon = resolveMarkdownFileIcon(props.path);
  if (props.kind === "directory") {
    return (
      <SymbolView
        name="folder"
        size={size}
        tintColorClassName={"accent-icon-subtle"}
        type="monochrome"
      />
    );
  }

  return (
    <Image
      source={markdownFileIconSource(icon)}
      resizeMode="contain"
      style={[
        { width: size, height: size },
        props.style,
        themeId === "fincke-ocean" ? { tintColor: finckeFileIconColor(icon) } : undefined,
      ]}
    />
  );
}
