import type { getClerkInstance } from "@clerk/expo";
import {
  createCloudAccountService,
  ManagedRelay,
  setManagedRelaySession,
} from "@t3tools/client-runtime/relay";
import {
  reportAtomCommandResult,
  runAtomCommand,
  settleAsyncResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";

import { runtime } from "../../lib/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  getComposerCloudAccountId,
  restoreCloudComposerDrafts,
} from "../../state/use-composer-drafts";
import { removeCloudEnvironments } from "./cloud-drafts";
import { clearConnectOnboardingRequest, requestConnectOnboarding } from "./connectOnboarding";
import { resolveRelayClerkTokenOptions } from "./publicConfig";

type ClerkInstance = ReturnType<typeof getClerkInstance>;

export function deactivateCloudRelayAccount(): void {
  setManagedRelaySession(appAtomRegistry, null);
}

export function activateCloudRelayAccount(
  accountId: string,
  tokenProvider: () => Promise<string | null>,
): void {
  setManagedRelaySession(appAtomRegistry, {
    accountId,
    readClerkToken: tokenProvider,
  });
}

function clerkTokenReader(clerk: ClerkInstance): () => Promise<string | null> {
  return async () =>
    clerk.session ? await clerk.session.getToken(resolveRelayClerkTokenOptions()) : null;
}

const cleanUpCloudAccount = async (accountId: string | null) => {
  const removal = await runAtomCommand(appAtomRegistry, removeCloudEnvironments, accountId, {
    reportFailure: false,
    reportDefect: false,
  });
  if (removal._tag !== "Success") throw squashAtomCommandFailure(removal);
  const result = await settleAsyncResult(() =>
    runtime.runPromiseExit(
      ManagedRelay.ManagedRelayClient.pipe(Effect.flatMap((client) => client.resetTokenCache)),
    ),
  );
  reportAtomCommandResult(result, { label: "cloud account cleanup" });
};

export const cloudAccountService = createCloudAccountService<ClerkInstance>({
  deactivate: deactivateCloudRelayAccount,
  detach: () => setManagedRelaySession(appAtomRegistry, null),
  // A not-yet-presented onboarding request belongs to the account that left.
  onSignOutTransition: clearConnectOnboardingRequest,
  cleanUp: ({ accountId }) => cleanUpCloudAccount(accountId),
  prepare: async ({ accountId, isCurrent }) => {
    const storedAccount = await getComposerCloudAccountId();
    if (storedAccount !== null && storedAccount !== accountId) {
      await cleanUpCloudAccount(storedAccount);
    }
    if (!isCurrent()) return;
    await restoreCloudComposerDrafts(accountId);
  },
  activate: ({ source, accountId, isAccountTransition }) => {
    activateCloudRelayAccount(accountId, clerkTokenReader(source));
    // Issued after cleanup so the sheet never lists the previous account's environments.
    if (isAccountTransition) requestConnectOnboarding(accountId);
  },
});
