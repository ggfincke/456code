// apps/web/src/fincke/ProjectFolderIcon.tsx
// project row icon: the project's own favicon or icon, else a plain (optionally tinted) folder
import type { CSSProperties } from "react";
import { FolderIcon } from "lucide-react";
import { finckeFolderTint } from "@t3tools/shared/fincke-folder-tint";

import { ProjectFavicon, type ProjectFaviconProject } from "../components/ProjectFavicon";
import { useClientSettings } from "../hooks/useSettings";
import { cn } from "../lib/utils";
import "./sidebarTokens.css";

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
  const hue = finckeFolderTint(project.id);
  const tint = tinted ? `var(--fincke-${hue.token}, ${hue.color})` : null;
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
