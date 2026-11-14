// apps/mobile/src/fincke/ocean-colors.ts
// material ocean accents for pr badges, work-log icons & effort levels, matching web's oceanTokens.css

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

// the effort chip warms from teal to red as the level rises; other levels keep the theme accent
const EFFORT_TINT_BY_LEVEL: Readonly<Record<string, string>> = {
  minimal: "#80cbc4",
  low: "#80cbc4",
  medium: "#ffcb6b",
  high: "#f78c6c",
  xhigh: "#f07178",
  max: "#f07178",
};

export function finckeEffortTint(levelId: string): string | null {
  return EFFORT_TINT_BY_LEVEL[levelId] ?? null;
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
