import { msg, useGT, useMessages } from "gt-react-native";
import { Pressable } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { Menu } from "../../../components/ui/Menu";
import { isSharedSlotTab, type SharedSlotTab } from "./navigation-tab-order";
import { useSelectWorkspaceTab } from "./useSelectWorkspaceTab";

const TITLES = {
  pullRequests: msg("Pull requests"),
  issues: msg("Issues", { $context: "screen title, list of issues" }),
} as const;

/** The header title of the tab pull requests and issues share: names the list and switches it. */
export function SharedSlotTitle(props: { readonly tab: SharedSlotTab }) {
  const gt = useGT();
  const messages = useMessages();
  const selectTab = useSelectWorkspaceTab();
  return (
    <Menu
      actions={Object.entries(TITLES).map(([id, title]) => ({
        id,
        title: messages(title),
        state: id === props.tab ? ("on" as const) : ("off" as const),
      }))}
      onPressAction={({ nativeEvent }) => {
        const id = nativeEvent.event;
        if (isSharedSlotTab(id) && id !== props.tab) selectTab(id);
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={gt("{list}, switch list", { list: messages(TITLES[props.tab]) })}
        hitSlop={8}
        className="flex-row items-center gap-1.5"
      >
        <Text
          allowFontScaling
          maxFontSizeMultiplier={1.4}
          numberOfLines={1}
          className="font-t3-bold text-foreground"
          style={{ fontSize: 20, letterSpacing: -0.4 }}
        >
          {messages(TITLES[props.tab])}
        </Text>
        <SymbolView
          name="chevron.down"
          size={12}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
          weight="semibold"
        />
      </Pressable>
    </Menu>
  );
}
