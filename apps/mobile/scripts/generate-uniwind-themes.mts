#!/usr/bin/env node
// apps/mobile/scripts/generate-uniwind-themes.mts
// compile default mobile semantic tokens for Uniwind and native interop

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import tailwindColors from "tailwindcss/colors";

const APPEARANCES = ["light", "dark"] as const;
const GLOBAL_CSS_PATH = NodePath.resolve(import.meta.dirname, "../global.css");
const GENERATED_CSS_PATH = NodePath.resolve(import.meta.dirname, "../generated-uniwind-themes.css");
const GENERATED_DEFAULT_VARIABLES_PATH = NodePath.resolve(
  import.meta.dirname,
  "../generated-uniwind-default-theme-variables.json",
);

export type MobileThemeAppearance = (typeof APPEARANCES)[number];
export type MobileThemeVariable = `--color-${string}`;
export type MobileThemeVariables = Readonly<Record<MobileThemeVariable, string>>;

type TailwindColorFamily = keyof typeof tailwindColors;
type TailwindColorShade = 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 | 950;

function color(family: TailwindColorFamily, shade?: TailwindColorShade, opacity = 1): string {
  const familyColors = tailwindColors[family];
  const value =
    typeof familyColors === "string"
      ? shade === undefined
        ? familyColors
        : undefined
      : shade === undefined
        ? undefined
        : familyColors[String(shade) as keyof typeof familyColors];

  if (value === undefined) {
    throw new Error(`Unknown Tailwind color ${family}${shade === undefined ? "" : `-${shade}`}.`);
  }
  if (opacity === 1) return value;

  const percentage = Number((opacity * 100).toFixed(4));
  const oklch = /^oklch\((.*)\)$/u.exec(value);
  if (oklch) return `oklch(${oklch[1]} / ${percentage}%)`;
  if (value === "#fff") return `rgb(255 255 255 / ${percentage}%)`;
  if (value === "#000") return `rgb(0 0 0 / ${percentage}%)`;
  return `color-mix(in srgb, ${value} ${percentage}%, transparent)`;
}

// these replace appearance variants so one semantic class follows the active default theme
const ADAPTIVE_COLORS = {
  "--color-adaptive-amber-50-950-a40": [color("amber", 50), color("amber", 950, 0.4)],
  "--color-adaptive-amber-200-900-a60": [color("amber", 200), color("amber", 900, 0.6)],
  "--color-adaptive-amber-500-a12-a16": [color("amber", 500, 0.12), color("amber", 500, 0.16)],
  "--color-adaptive-amber-700-300": [color("amber", 700), color("amber", 300)],
  "--color-adaptive-amber-700-400": [color("amber", 700), color("amber", 400)],
  "--color-adaptive-amber-800-200": [color("amber", 800), color("amber", 200)],
  "--color-adaptive-blue-50-blue-400-a14": [color("blue", 50), color("blue", 400, 0.14)],
  "--color-adaptive-blue-300-a50-blue-400-a28": [color("blue", 300, 0.5), color("blue", 400, 0.28)],
  "--color-adaptive-blue-500-a20-blue-400-a15": [color("blue", 500, 0.2), color("blue", 400, 0.15)],
  "--color-adaptive-blue-500-400": [color("blue", 500), color("blue", 400)],
  "--color-adaptive-blue-600-400": [color("blue", 600), color("blue", 400)],
  "--color-adaptive-black-a10-a25": [
    color("black", undefined, 0.1),
    color("black", undefined, 0.25),
  ],
  "--color-adaptive-black-a15-a35": [
    color("black", undefined, 0.15),
    color("black", undefined, 0.35),
  ],
  "--color-adaptive-emerald-500-a12-a16": [
    color("emerald", 500, 0.12),
    color("emerald", 500, 0.16),
  ],
  "--color-adaptive-emerald-600-400": [color("emerald", 600), color("emerald", 400)],
  "--color-adaptive-emerald-700-300": [color("emerald", 700), color("emerald", 300)],
  "--color-adaptive-indigo-500-a12-a16": [color("indigo", 500, 0.12), color("indigo", 500, 0.16)],
  "--color-adaptive-indigo-600-300": [color("indigo", 600), color("indigo", 300)],
  "--color-adaptive-indigo-700-300": [color("indigo", 700), color("indigo", 300)],
  "--color-adaptive-neutral-100-900": [color("neutral", 100), color("neutral", 900)],
  "--color-adaptive-neutral-100-a80-900-a80": [
    color("neutral", 100, 0.8),
    color("neutral", 900, 0.8),
  ],
  "--color-adaptive-neutral-200-700-a60": [color("neutral", 200), color("neutral", 700, 0.6)],
  "--color-adaptive-neutral-200-800": [color("neutral", 200), color("neutral", 800)],
  "--color-adaptive-neutral-200-a70-white-a8": [
    color("neutral", 200, 0.7),
    color("white", undefined, 0.08),
  ],
  "--color-adaptive-neutral-200-white-a6": [color("neutral", 200), color("white", undefined, 0.06)],
  "--color-adaptive-neutral-200-white-a8": [color("neutral", 200), color("white", undefined, 0.08)],
  "--color-adaptive-neutral-200-a80-white-a8": [
    color("neutral", 200, 0.8),
    color("white", undefined, 0.08),
  ],
  "--color-adaptive-neutral-300-a60-white-a12": [
    color("neutral", 300, 0.6),
    color("white", undefined, 0.12),
  ],
  "--color-adaptive-neutral-400-500": [color("neutral", 400), color("neutral", 500)],
  "--color-adaptive-neutral-400-a60-500-a60": [
    color("neutral", 400, 0.6),
    color("neutral", 500, 0.6),
  ],
  "--color-adaptive-neutral-400-a80-500-a80": [
    color("neutral", 400, 0.8),
    color("neutral", 500, 0.8),
  ],
  "--color-adaptive-neutral-500-a10-a16": [color("neutral", 500, 0.1), color("neutral", 500, 0.16)],
  "--color-adaptive-neutral-500-400": [color("neutral", 500), color("neutral", 400)],
  "--color-adaptive-neutral-500-500": [color("neutral", 500), color("neutral", 500)],
  "--color-adaptive-neutral-600-300": [color("neutral", 600), color("neutral", 300)],
  "--color-adaptive-neutral-600-400": [color("neutral", 600), color("neutral", 400)],
  "--color-adaptive-neutral-950-50": [color("neutral", 950), color("neutral", 50)],
  "--color-adaptive-red-50-950-a80": [color("red", 50), color("red", 950, 0.8)],
  "--color-adaptive-red-200-800": [color("red", 200), color("red", 800)],
  "--color-adaptive-red-600-a80-400-a80": [color("red", 600, 0.8), color("red", 400, 0.8)],
  "--color-adaptive-red-700-300": [color("red", 700), color("red", 300)],
  "--color-adaptive-rose-100-500-a18": [color("rose", 100), color("rose", 500, 0.18)],
  "--color-adaptive-rose-100-a80-500-a12": [color("rose", 100, 0.8), color("rose", 500, 0.12)],
  "--color-adaptive-rose-300-a70-400-a28": [color("rose", 300, 0.7), color("rose", 400, 0.28)],
  "--color-adaptive-rose-500-a12-a16": [color("rose", 500, 0.12), color("rose", 500, 0.16)],
  "--color-adaptive-rose-500-400": [color("rose", 500), color("rose", 400)],
  "--color-adaptive-rose-600-400": [color("rose", 600), color("rose", 400)],
  "--color-adaptive-rose-700-300": [color("rose", 700), color("rose", 300)],
  "--color-adaptive-sky-500-a12-a16": [color("sky", 500, 0.12), color("sky", 500, 0.16)],
  "--color-adaptive-sky-600-400": [color("sky", 600), color("sky", 400)],
  "--color-adaptive-sky-700-300": [color("sky", 700), color("sky", 300)],
  "--color-adaptive-violet-500-a12-a16": [color("violet", 500, 0.12), color("violet", 500, 0.16)],
  "--color-adaptive-violet-600-400": [color("violet", 600), color("violet", 400)],
  "--color-adaptive-violet-700-300": [color("violet", 700), color("violet", 300)],
  "--color-adaptive-white-a90-neutral-900-a90": [
    color("white", undefined, 0.9),
    color("neutral", 900, 0.9),
  ],
  "--color-adaptive-white-a95-neutral-900-a95": [
    color("white", undefined, 0.95),
    color("neutral", 900, 0.95),
  ],
  "--color-adaptive-white-neutral-950-a70": [color("white"), color("neutral", 950, 0.7)],
  "--color-adaptive-zinc-500-a12-a16": [color("zinc", 500, 0.12), color("zinc", 500, 0.16)],
  "--color-adaptive-zinc-500-400": [color("zinc", 500), color("zinc", 400)],
  "--color-adaptive-zinc-600-300": [color("zinc", 600), color("zinc", 300)],
} as const satisfies Readonly<Record<MobileThemeVariable, readonly [string, string]>>;

function adaptiveVariablesFor(appearance: MobileThemeAppearance): MobileThemeVariables {
  return Object.fromEntries(
    Object.entries(ADAPTIVE_COLORS).map(([name, values]) => [
      name,
      values[appearance === "light" ? 0 : 1],
    ]),
  ) as MobileThemeVariables;
}

function renderVariant(name: string, variables: MobileThemeVariables): string {
  const declarations = Object.entries(variables)
    .map(([variable, value]) => `      ${variable}: ${value};`)
    .join("\n");
  return `    @variant ${name} {\n${declarations}\n    }`;
}

export function renderUniwindThemesCSS(): string {
  return [
    "/* Generated by scripts/generate-uniwind-themes.mts. Do not edit manually. */",
    "@layer theme {",
    "  :root {",
    APPEARANCES.map((appearance) =>
      renderVariant(appearance, adaptiveVariablesFor(appearance)),
    ).join("\n\n"),
    "  }",
    "}",
    "",
  ].join("\n");
}

function readVariantBody(css: string, appearance: MobileThemeAppearance): string {
  const marker = `@variant ${appearance} {`;
  const markerIndex = css.indexOf(marker);
  if (markerIndex === -1) throw new Error(`Could not find ${marker} in global.css.`);

  const openingBraceIndex = css.indexOf("{", markerIndex);
  let depth = 0;
  for (let index = openingBraceIndex; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return css.slice(openingBraceIndex + 1, index);
  }
  throw new Error(`Could not find the end of ${marker} in global.css.`);
}

function readColorVariables(body: string): MobileThemeVariables {
  const variables: Record<MobileThemeVariable, string> = {};
  for (const match of body.matchAll(/^\s*(--color-[a-z0-9-]+):\s*([^;]+);/gmu)) {
    const [, name, value] = match;
    if (!name || !value) continue;
    variables[name as MobileThemeVariable] = value.trim();
  }
  return variables;
}

export function readDefaultThemeVariables(
  css: string,
): Readonly<Record<MobileThemeAppearance, MobileThemeVariables>> {
  const themes = Object.fromEntries(
    APPEARANCES.map((appearance) => [
      appearance,
      readColorVariables(readVariantBody(css, appearance)),
    ]),
  ) as Readonly<Record<MobileThemeAppearance, MobileThemeVariables>>;
  const lightNames = Object.keys(themes.light);
  const darkNames = Object.keys(themes.dark);

  if (lightNames.length === 0) throw new Error("Default light theme has no color variables.");
  if (lightNames.join("\n") !== darkNames.join("\n")) {
    throw new Error("Default light and dark themes must define the same color variables in order.");
  }
  return themes;
}

export function getGeneratedUniwindThemeOutputs(): ReadonlyArray<
  readonly [filename: string, contents: string]
> {
  const css = NodeFS.readFileSync(GLOBAL_CSS_PATH, "utf8");
  return [
    [GENERATED_CSS_PATH, renderUniwindThemesCSS()],
    [
      GENERATED_DEFAULT_VARIABLES_PATH,
      `${JSON.stringify(readDefaultThemeVariables(css), null, 2)}\n`,
    ],
  ];
}

function writeFileAtomically(filename: string, contents: string) {
  const current = NodeFS.existsSync(filename) ? NodeFS.readFileSync(filename, "utf8") : null;
  if (current === contents) return;

  const temporaryFilename = `${filename}.${process.pid}.tmp`;
  try {
    NodeFS.writeFileSync(temporaryFilename, contents);
    NodeFS.renameSync(temporaryFilename, filename);
  } finally {
    if (NodeFS.existsSync(temporaryFilename)) NodeFS.unlinkSync(temporaryFilename);
  }
}

if (import.meta.main) {
  const checkOnly = process.argv.includes("--check");
  for (const [filename, contents] of getGeneratedUniwindThemeOutputs()) {
    if (checkOnly) {
      const current = NodeFS.existsSync(filename) ? NodeFS.readFileSync(filename, "utf8") : null;
      if (current !== contents) {
        console.error(
          `${NodePath.relative(process.cwd(), filename)} is stale. Run pnpm --filter @t3tools/mobile generate.`,
        );
        process.exitCode = 1;
      }
      continue;
    }
    writeFileAtomically(filename, contents);
  }
}
