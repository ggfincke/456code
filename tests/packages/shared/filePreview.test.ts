import { describe, expect, it } from "vite-plus/test";

import {
  isWorkspaceBrowserPreviewPath,
  isWorkspaceImagePreviewPath,
  isWorkspacePreviewEntryPath,
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
