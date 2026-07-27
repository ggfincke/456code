import { describe, expect, it } from "vite-plus/test";

import {
  serializeComposerFileLink,
  serializeComposerMentionPath,
} from "../../../packages/shared/src/composerTrigger.ts";

describe("serializeComposerMentionPath", () => {
  it.each([
    ["src/index.ts", "src/index.ts"],
    ["docs/My File.md", '"docs/My File.md"'],
    ['docs/My "File".md', '"docs/My \\"File\\".md"'],
  ])("serializes mention path %s", (input, expected) => {
    expect(serializeComposerMentionPath(input)).toBe(expected);
  });
});

describe("serializeComposerFileLink", () => {
  it.each([
    ["path/to/package.json", "[package.json](path/to/package.json)"],
    ["docs/My File (draft).md", "[My File (draft).md](docs/My%20File%20%28draft%29.md)"],
    ["C:\\repo\\src\\index.ts", "[index.ts](C:%5Crepo%5Csrc%5Cindex.ts)"],
    ["@scope/package.json", "[package.json](@scope/package.json)"],
  ])("serializes file link %s", (input, expected) => {
    expect(serializeComposerFileLink(input)).toBe(expected);
  });
});
