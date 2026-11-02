// apps/mobile/src/fincke/ocean-colors.ts
// material ocean accents for pr badges & work-log icons, matching web's oceanTokens.css

export function finckePrStateColor(state: "open" | "closed" | "merged"): string {
  switch (state) {
    case "open":
      return "#c3e88d";
    case "closed":
      return "#f07178";
    case "merged":
      return "#c792ea";
  }
}

// keyed by the work row's sf symbol; kinds without a color keep the muted icon tint
const WORK_ICON_COLOR_BY_SYMBOL: Readonly<Record<string, string>> = {
  terminal: "#c3e88d",
  "square.and.pencil": "#82aaff",
  magnifyingglass: "#c792ea",
  eye: "#c792ea",
  globe: "#89ddff",
  safari: "#89ddff",
  browser: "#89ddff",
  hammer: "#ffcb6b",
  wrench: "#ffcb6b",
  bolt: "#ffcb6b",
  sparkles: "#80cbc4",
};

export function finckeWorkIconColor(icon: string | { readonly ios: string }): string | null {
  return WORK_ICON_COLOR_BY_SYMBOL[typeof icon === "string" ? icon : icon.ios] ?? null;
}
