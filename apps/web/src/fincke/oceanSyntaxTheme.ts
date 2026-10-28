// apps/web/src/fincke/oceanSyntaxTheme.ts
// material theme ocean high contrast syntax colors for dark code views, picked by the code theme setting
import { registerCustomTheme, type DiffsTheme } from "@pierre/diffs";

export const MATERIAL_OCEAN_HC_THEME_NAME = "material-ocean-high-contrast";

const BLUE = "#82AAFF";
const CYAN = "#89DDFF";
const GREEN = "#C3E88D";
const ORANGE = "#F78C6C";
const PINK = "#FF9CAC";
const PURPLE = "#C792EA";
const RED = "#F07178";
const YELLOW = "#FFCB6B";
const TEXT = "#BABED8";
const COMMENT = "#464B5D";

// hand-mapped from the tokenColors of Material-Theme-Ocean-High-Contrast.json in the t3dotgg
// marketplace build; highlights only reads zed capture names, so the vscode json can't load as-is
const theme: NonNullable<DiffsTheme["zed"]> = {
  name: MATERIAL_OCEAN_HC_THEME_NAME,
  appearance: "dark",
  style: {
    background: "#0F111A",
    text: TEXT,
    "editor.background": "#0F111A",
    "editor.foreground": TEXT,
    syntax: {
      attribute: { color: PURPLE },
      boolean: { color: PINK },
      comment: { color: COMMENT, font_style: "italic" },
      constant: { color: TEXT },
      "constant.builtin": { color: CYAN },
      constructor: { color: YELLOW },
      "diff.minus": { color: RED },
      "diff.plus": { color: GREEN },
      embedded: { color: TEXT },
      emphasis: { color: RED, font_style: "italic" },
      "emphasis.strong": { color: RED, font_weight: 700 },
      enum: { color: YELLOW },
      function: { color: BLUE },
      hint: { color: "#969696" },
      keyword: { color: CYAN },
      "keyword.control": { color: CYAN, font_style: "italic" },
      "keyword.import": { color: CYAN, font_style: "italic" },
      // storage.type & storage.modifier (const, function, class) are purple, not keyword cyan
      "keyword.declaration": { color: PURPLE },
      "keyword.jsdoc": { color: PURPLE },
      label: { color: YELLOW },
      link_text: { color: RED },
      link_uri: { color: TEXT },
      namespace: { color: YELLOW },
      number: { color: ORANGE },
      operator: { color: CYAN },
      predictive: { color: COMMENT },
      preproc: { color: CYAN, font_style: "italic" },
      primary: { color: TEXT },
      property: { color: RED },
      "property.json_key": { color: PURPLE },
      punctuation: { color: CYAN },
      selector: { color: YELLOW },
      "selector.id": { color: ORANGE },
      "selector.pseudo": { color: PURPLE },
      string: { color: GREEN },
      "string.escape": { color: TEXT },
      tag: { color: RED },
      "tag.component.jsx": { color: YELLOW },
      "tag.doctype": { color: CYAN },
      "text.jsx": { color: TEXT },
      "text.literal": { color: GREEN },
      title: { color: CYAN },
      type: { color: YELLOW },
      "type.jsdoc": { color: YELLOW },
      variable: { color: TEXT },
      "variable.parameter": { color: TEXT, font_style: "italic" },
      "variable.special": { color: CYAN },
      variant: { color: TEXT },
    },
  },
};

// themes resolve on the main thread and reach the diff workers already resolved
registerCustomTheme(MATERIAL_OCEAN_HC_THEME_NAME, async () => theme, "zed");

// appInit mirrors the codeTheme client setting onto <html>; auto follows fincke ocean
export function usesMaterialOceanSyntax(): boolean {
  if (typeof document === "undefined") return false;
  const { codeTheme, themeId } = document.documentElement.dataset;
  if (codeTheme === "material-ocean-high-contrast") return true;
  if (codeTheme === "pierre") return false;
  return themeId === "fincke-ocean";
}
