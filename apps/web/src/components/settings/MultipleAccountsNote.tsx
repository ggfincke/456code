import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";
import { InfoIcon } from "lucide-react";

import { APP_BASE_NAME } from "~/branding";
import { serverEnvironment } from "../../state/server";
import { Alert, AlertDescription } from "../ui/alert";

const PROVIDER_NAMES = new Map<string, string>([
  ["codex", "Codex"],
  ["claudeAgent", "Claude"],
]);

/** Shown while adding a Claude or Codex account when the environment already has one signed in. */
export function MultipleAccountsNote({
  environmentId,
  driver,
}: {
  readonly environmentId: EnvironmentId;
  readonly driver: ProviderDriverKind;
}) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const providerName = PROVIDER_NAMES.get(driver);
  const hasSignedInAccount =
    providerName !== undefined &&
    providers?.some(
      (provider) => provider.driver === driver && provider.auth.status === "authenticated",
    );
  if (!hasSignedInAccount) return null;
  return (
    <Alert variant="info" role="note">
      <InfoIcon aria-hidden />
      <AlertDescription>
        <p>
          We do not recommend managing multiple {providerName} accounts in {APP_BASE_NAME}.
        </p>
      </AlertDescription>
    </Alert>
  );
}
