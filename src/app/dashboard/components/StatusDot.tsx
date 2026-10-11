/**
 * StatusDot - displays status indicator for instances/subscriptions
 */

export function StatusDot({ status }: { status: string }) {
  const normalizedStatus = status?.toLowerCase() || "";
  const isRunning = normalizedStatus === "running" || normalizedStatus === "active" || normalizedStatus === "subscribed";
  const isStopped = normalizedStatus === "stopped" || normalizedStatus === "off";
  const isTerminating = normalizedStatus === "un_subscribing" || normalizedStatus === "unsubscribing" || normalizedStatus === "terminating";
  const isPending = normalizedStatus === "pending" || normalizedStatus === "starting" || normalizedStatus === "stopping" || normalizedStatus === "subscribing";
  const isSettingUp = normalizedStatus === "setting-up";
  const isSetupFailed = normalizedStatus === "setup-failed" || normalizedStatus === "failed";
  // Running, but its SSH login never arrived: a steady warning, not the pulse of something in progress.
  const isSshUnavailable = normalizedStatus === "ssh-unavailable";

  return (
    <span className="relative flex h-2 w-2">
      {isRunning && !isTerminating && !isSettingUp && !isSetupFailed && (
        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
      )}
      {isSettingUp && (
        <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500 animate-pulse"></span>
      )}
      {isSetupFailed && (
        <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500"></span>
      )}
      {isTerminating && (
        <span className="relative inline-flex rounded-full h-2 w-2 bg-orange-500 animate-pulse"></span>
      )}
      {isStopped && (
        <span className="relative inline-flex rounded-full h-2 w-2 bg-zinc-300"></span>
      )}
      {isSshUnavailable && (
        <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
      )}
      {isPending && (
        <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-400 animate-pulse"></span>
      )}
      {!isRunning && !isStopped && !isPending && !isTerminating && !isSettingUp && !isSetupFailed && !isSshUnavailable && (
        <span className="relative inline-flex rounded-full h-2 w-2 bg-zinc-300"></span>
      )}
    </span>
  );
}
