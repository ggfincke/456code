import { Link } from "@tanstack/react-router";

import { APP_DISPLAY_NAME } from "~/branding";
import { isElectron } from "../env";
import { Button } from "./ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

/** Home screen while this computer's local environment is switched off. */
export function HostedEmptyState() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
              {APP_DISPLAY_NAME}
            </span>
          </div>
        </WorkspacePageHeader>

        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyTitle>This computer is off</EmptyTitle>
            <EmptyDescription>Turn it back on, or connect a different computer.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button render={<Link to="/settings/connections" />} size="sm">
              Open Environments
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    </SidebarInset>
  );
}
