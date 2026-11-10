// apps/web/src/components/mcp/mcpGate.ts
// decides whether another app can be pointed at an environment's MCP endpoint

/**
 * What stands between the user and the wizard's steps. Only `open` lets them go on: cloud apps
 * need an https address, so the environment must be reached over one (for example Tailscale
 * Funnel or a custom HTTPS endpoint). The MCP OAuth issuer follows the request's origin.
 */
export type McpGate =
  | { readonly kind: "checking" }
  | { readonly kind: "disconnected" }
  | { readonly kind: "update" }
  | { readonly kind: "no-https" }
  | { readonly kind: "open"; readonly mcpUrl: string };

export function resolveMcpGate(input: {
  readonly connected: boolean;
  /** The environment's `mcpApprovalCodes` capability; undefined until its config loads. */
  readonly approvalCodes: boolean | undefined;
  /** The address this client reaches the environment at. */
  readonly httpBaseUrl: string | null;
}): McpGate {
  if (!input.connected) return { kind: "disconnected" };
  if (input.approvalCodes === undefined) return { kind: "checking" };
  if (!input.approvalCodes) return { kind: "update" };
  const mcpUrl = httpsMcpUrl(input.httpBaseUrl);
  return mcpUrl === null ? { kind: "no-https" } : { kind: "open", mcpUrl };
}

function httpsMcpUrl(httpBaseUrl: string | null): string | null {
  if (httpBaseUrl === null || !URL.canParse(httpBaseUrl)) return null;
  const url = new URL(httpBaseUrl);
  return url.protocol === "https:" ? `${url.origin}/mcp` : null;
}
