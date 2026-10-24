// packages/shared/src/fincke-folder-tint.ts
// stable ocean folder hues shared by web and native project rows

const FOLDER_TINTS = [
  { token: "teal", color: "#80cbc4" },
  { token: "purple", color: "#c792ea" },
  { token: "red", color: "#f07178" },
  { token: "yellow", color: "#ffcb6b" },
  { token: "blue", color: "#82aaff" },
  { token: "green", color: "#c3e88d" },
  { token: "orange", color: "#f78c6c" },
  { token: "cyan", color: "#89ddff" },
] as const;

export function finckeFolderTint(projectId: string) {
  // fnv-1a keeps the same project's hue stable across clients and reloads.
  let hash = 0x811c9dc5;
  for (let index = 0; index < projectId.length; index += 1) {
    hash ^= projectId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return FOLDER_TINTS[(hash >>> 0) % FOLDER_TINTS.length]!;
}
