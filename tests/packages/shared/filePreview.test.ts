// tests/packages/shared/filePreview.test.ts
// verifies preview classification and safe mdx target resolution

import { describe, expect, it } from "vite-plus/test";

import {
  isWorkspaceBrowserPreviewPath,
  isWorkspaceImagePreviewPath,
  isWorkspacePreviewEntryPath,
  normalizeMdxWorkspacePath,
  resolveMdxAnchorTarget,
  resolveMdxImageTarget,
} from "../../../packages/shared/src/filePreview.ts";

describe("workspace file previews", () => {
  it.each([
    { kind: "browser", path: "report.html", preview: true, image: false },
    { kind: "browser", path: "report.HTM", preview: true, image: false },
    { kind: "browser", path: "document.pdf?download=1", preview: true, image: false },
    { kind: "image", path: "icon.png", preview: true, image: true },
    { kind: "image", path: "photo.JPEG", preview: true, image: true },
    { kind: "image", path: "animation.gif", preview: true, image: true },
    { kind: "image", path: "vector.svg#mark", preview: true, image: true },
    { kind: "image", path: "texture.webp", preview: true, image: true },
    { kind: "image", path: "image.avif", preview: true, image: true },
    { kind: "reject", path: "README.md", preview: false, image: false },
    { kind: "reject", path: "src/index.ts", preview: false, image: false },
    { kind: "reject", path: "image.png.ts", preview: false, image: false },
    { kind: "reject", path: "png", preview: false, image: false },
  ])("$kind path $path", ({ path, preview, image }) => {
    expect(isWorkspacePreviewEntryPath(path)).toBe(preview);
    expect(isWorkspaceBrowserPreviewPath(path)).toBe(preview && !image);
    expect(isWorkspaceImagePreviewPath(path)).toBe(image);
  });
});

describe("mdx workspace targets", () => {
  it("normalizes workspace-root and document-relative paths", () => {
    expect(normalizeMdxWorkspacePath("./src/components/Callout.tsx")).toEqual({
      kind: "workspace",
      path: "src/components/Callout.tsx",
      fragment: null,
    });
    expect(resolveMdxImageTarget("docs/guides/intro.mdx", "./assets/diagram%20one.png")).toEqual({
      kind: "workspace",
      path: "docs/guides/assets/diagram one.png",
      fragment: null,
    });
  });

  it("normalizes in-root parent segments and rejects escapes", () => {
    expect(resolveMdxAnchorTarget("docs/guides/intro.mdx", "../reference.md")).toEqual({
      kind: "workspace",
      path: "docs/reference.md",
      fragment: null,
    });
    expect(resolveMdxAnchorTarget("intro.mdx", "../secrets.txt")).toEqual({
      kind: "rejected",
      reason: "workspace_escape",
    });
  });

  it.each([
    "/etc/passwd",
    "C:/Users/example/secret.txt",
    "C%3A/Users/example/secret.txt",
    "C:\\Users\\example\\secret.txt",
    "//server/share/secret.txt",
    "\\\\server\\share\\secret.txt",
  ])("rejects absolute path %s", (target) => {
    expect(resolveMdxAnchorTarget("docs/intro.mdx", target).kind).toBe("rejected");
  });

  it.each([
    ["assets\\diagram.png", "backslash"],
    ["assets/\u0000diagram.png", "control_character"],
    ["assets/%ZZ.png", "malformed_percent_encoding"],
    ["assets/%2fsecret.png", "ambiguous_percent_encoding"],
    ["assets/%5csecret.png", "ambiguous_percent_encoding"],
    ["assets/%00secret.png", "ambiguous_percent_encoding"],
    ["assets/%252fsecret.png", "ambiguous_percent_encoding"],
    ["javascript%3Aalert(1)", "unsupported_protocol"],
  ] as const)("rejects unsafe target %s", (target, reason) => {
    expect(resolveMdxImageTarget("docs/intro.mdx", target)).toEqual({
      kind: "rejected",
      reason,
    });
  });

  it("rejects query-bearing workspace paths", () => {
    expect(resolveMdxAnchorTarget("docs/intro.mdx", "reference.md?raw=1")).toEqual({
      kind: "rejected",
      reason: "query_not_allowed",
    });
  });

  it.each([
    ["https://example.com/reference?q=mdx", "https://example.com/reference?q=mdx"],
    ["https://example.com/reference#mdx", "https://example.com/reference#mdx"],
    ["http://example.com/reference", "http://example.com/reference"],
    ["mailto:docs@example.com", "mailto:docs@example.com"],
    ["tel:+15550123", "tel:+15550123"],
  ])("allows external anchor %s", (target, href) => {
    expect(resolveMdxAnchorTarget("docs/intro.mdx", target)).toEqual({
      kind: "external",
      href,
    });
  });

  it("rejects unsupported external anchors and all external images", () => {
    expect(resolveMdxAnchorTarget("docs/intro.mdx", "javascript:alert(1)")).toEqual({
      kind: "rejected",
      reason: "unsupported_protocol",
    });
    expect(resolveMdxImageTarget("docs/intro.mdx", "https://example.com/diagram.png")).toEqual({
      kind: "rejected",
      reason: "external_not_allowed",
    });
  });

  it("rejects workspace anchor fragments until navigation supports them", () => {
    expect(resolveMdxAnchorTarget("docs/intro.mdx", "#architecture")).toEqual({
      kind: "rejected",
      reason: "fragment_not_allowed",
    });
    expect(resolveMdxAnchorTarget("docs/intro.mdx", "reference.md#architecture")).toEqual({
      kind: "rejected",
      reason: "fragment_not_allowed",
    });
    expect(resolveMdxImageTarget("docs/intro.mdx", "#architecture")).toEqual({
      kind: "rejected",
      reason: "fragment_not_allowed",
    });
  });
});
