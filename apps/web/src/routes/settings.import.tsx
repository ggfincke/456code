// apps/web/src/routes/settings.import.tsx
// mounts the session import settings panel
import { createFileRoute } from "@tanstack/react-router";

import { ImportSessionsPanel } from "../components/settings/ImportSessionsPanel";

export const Route = createFileRoute("/settings/import")({
  component: ImportSessionsPanel,
});
