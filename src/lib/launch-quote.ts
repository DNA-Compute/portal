import type { AuthenticatedCustomer } from "./auth/helpers";
import {
  launchConfigurationSchema,
  type LaunchConfiguration,
  type LaunchQuote,
  type ResolvedLaunchConfiguration,
} from "./launch-config";
import { quoteResolvedConfiguration } from "./launch-pricing";
import { resolveLaunchConfiguration } from "./launch-capabilities";
import { validateLaunchSoftware } from "./launch-software";
import { getStoragePricePerGBHourCents, getStoppedInstanceRatePercent } from "./pricing";


export async function resolveAndQuoteLaunch(
  auth: AuthenticatedCustomer,
  configuration: LaunchConfiguration,
): Promise<{ resolved: ResolvedLaunchConfiguration; quote: LaunchQuote }> {
  if (!auth.teamId || !auth.can("gpu.provision")) {
    throw Object.assign(new Error("You do not have permission to provision resources for this account."), { status: 403 });
  }
  const parsed = launchConfigurationSchema.parse(configuration);
  const resolved = await resolveLaunchConfiguration(auth, parsed);
  await validateLaunchSoftware(auth, resolved);
  const quote = quoteResolvedConfiguration(
    resolved,
    auth.accountId,
    auth.teamId,
    getStoragePricePerGBHourCents(),
    getStoppedInstanceRatePercent(),
  );
  return { resolved, quote };
}
