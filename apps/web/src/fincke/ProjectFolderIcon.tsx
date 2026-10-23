// apps/web/src/fincke/ProjectFolderIcon.tsx
// project row icon: the project's own favicon or icon, else a plain (optionally tinted) folder
import type { CSSProperties } from "react";
import { FolderIcon } from "lucide-react";

import { ProjectFavicon, type ProjectFaviconProject } from "../components/ProjectFavicon";
import { useClientSettings } from "../hooks/useSettings";
import { cn } from "../lib/utils";
import "./sidebarTokens.css";

// material ocean hues; the hex fallbacks keep tints stable outside the fincke theme
const FOLDER_TINTS = [
  "var(--fincke-teal, #80cbc4)",
  "var(--fincke-purple, #c792ea)",
  "var(--fincke-red, #f07178)",
  "var(--fincke-yellow, #ffcb6b)",
  "var(--fincke-blue, #82aaff)",
  "var(--fincke-green, #c3e88d)",
  "var(--fincke-orange, #f78c6c)",
  "var(--fincke-cyan, #89ddff)",
] as const;

// fnv-1a keeps a project's hue stable across reloads & machines
function folderTintForProject(projectId: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < projectId.length; index += 1) {
    hash ^= projectId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return FOLDER_TINTS[(hash >>> 0) % FOLDER_TINTS.length]!;
}

// reads its colors from the wrapper so ProjectFavicon can render it as a plain fallback component
function FallbackFolderIcon({ className }: { className?: string }) {
  return (
    <FolderIcon
      aria-hidden
      className={cn(className, "text-(--project-folder-tint) fill-(--project-folder-fill)")}
    />
  );
}

export function ProjectFolderIcon({
  project,
}: {
  project: ProjectFaviconProject & { readonly id: string };
}) {
  const tinted = useClientSettings((settings) => settings.sidebarProjectFolderTint);
  const tint = tinted ? folderTintForProject(project.id) : null;
  const style = {
    "--project-folder-tint": tint ?? "var(--fincke-sidebar-folder)",
    "--project-folder-fill": tint ? `color-mix(in srgb, ${tint} 80%, transparent)` : "none",
  } as CSSProperties;

  // an empty title makes ProjectFavicon skip its letter monogram fallback, so a
  // project without a favicon or chosen icon lands on the folder instead
  return (
    <span className="flex shrink-0" style={style}>
      <ProjectFavicon project={{ ...project, title: "" }} fallbackIcon={FallbackFolderIcon} />
    </span>
  );
}
