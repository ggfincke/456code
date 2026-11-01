import type { MenuAction } from "@react-native-menu/menu";
import type { AppBarMenuItem } from "./AppBar.types";

export function headerMenuActions(items: ReadonlyArray<AppBarMenuItem>): MenuAction[] {
  return items.flatMap((item): MenuAction[] =>
    "items" in item
      ? item.inline && !item.title
        ? headerMenuActions(item.items)
        : [
            {
              id: item.id,
              title: item.title ?? "",
              image: item.icon,
              subactions: headerMenuActions(item.items),
            },
          ]
      : [
          {
            id: item.id,
            title: item.title,
            subtitle: item.subtitle,
            image: item.icon,
            state: item.selected ? "on" : undefined,
            attributes: item.disabled ? { disabled: true } : undefined,
          },
        ],
  );
}

export function findHeaderMenuAction(
  items: ReadonlyArray<AppBarMenuItem>,
  id: string,
): Extract<AppBarMenuItem, { readonly onPress: () => void }> | undefined {
  for (const item of items) {
    if ("items" in item) {
      const action = findHeaderMenuAction(item.items, id);
      if (action) return action;
    } else if (item.id === id) {
      return item;
    }
  }
  return undefined;
}
