import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";
import { T, Var } from "gt-react";
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
          <T>
            We do not recommend managing multiple <Var>{providerName}</Var> accounts in{" "}
            <Var>{APP_BASE_NAME}</Var>.
          </T>
        </p>
      </AlertDescription>
    </Alert>
  );
}
