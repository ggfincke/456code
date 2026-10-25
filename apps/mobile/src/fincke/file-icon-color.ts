// apps/mobile/src/fincke/file-icon-color.ts
// material ocean language colors for existing file icons

import type { MarkdownFileIcon } from "../lib/markdownLinks";

export function finckeFileIconColor(icon: MarkdownFileIcon): string {
  switch (icon) {
    case "typescript":
    case "python":
      return "#82aaff";
    case "react":
      return "#89ddff";
    case "css":
    case "sass":
      return "#c792ea";
    case "json":
    case "yml":
      return "#ffcb6b";
    case "markdown":
      return "#80cbc4";
    case "rust":
    case "go":
      return "#f78c6c";
    default:
      return "#8f93a2";
  }
}
