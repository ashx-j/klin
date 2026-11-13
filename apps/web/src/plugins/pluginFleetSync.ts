import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { pluginEnvironment } from "../state/plugins";
import { fleetMachinesAtom, fleetProblemsAtom } from "./pluginFleet";
import { copyPlugin } from "./pluginFiles";
import { type FleetAction, fleetActionKey, planFleetSync } from "./pluginFleetPlan";

// How long a failed action waits before its next try, by the number of tries so far.
const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000];
const DONE_SETTLE_MS = 60_000;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const perform = async (action: FleetAction) => {
  if (action.kind === "copy") {
    await copyPlugin(action.from, action.to, action.entry);
    return;
  }
  const result = await runAtomCommand(
    appAtomRegistry,
    pluginEnvironment.applyPluginFleet,
    { environmentId: action.to, input: { entry: action.entry } },
    { reportFailure: false },
  );
  if (result._tag !== "Success") throw squashAtomCommandFailure(result);
};

const setProblem = (key: string, problem: string | undefined) => {
  const problems = new Map(appAtomRegistry.get(fleetProblemsAtom));
  if (problem === undefined) problems.delete(key);
  else problems.set(key, problem);
  appAtomRegistry.set(fleetProblemsAtom, problems);
};

// The server reads its plugins folder only when asked, so a folder copied there by hand is found
// when this window connects to the machine, not only when Settings shows it.
const rescan = (environmentId: EnvironmentId) =>
  void runAtomCommand(
    appAtomRegistry,
    pluginEnvironment.rescanPlugins,
    { environmentId, input: {} },
    { reportFailure: false, reportDefect: false },
  );

/**
 * Copies the newest plugin decisions to the machines this window manages that are behind, one at a
 * time, whenever a machine's plugins or connection change. A failed action waits longer before
 * each new try, and starts over when its machine reconnects. Servers check that an entry is newer,
 * so two windows doing this at once apply each change once.
 */
export function startPluginFleetSync(): () => void {
  let stopped = false;
  let running = false;
  let again = false;
  // Actions in flight or failed, by key, with when each may run next.
  const attempts = new Map<string, { readonly tries: number; readonly retryAt: number }>();
  const sharingBefore = new Set<EnvironmentId>();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleRetry = () => {
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
    const next = Math.min(...[...attempts.values()].map((attempt) => attempt.retryAt));
    if (!Number.isFinite(next)) return;
    retryTimer = setTimeout(() => void run(), Math.max(0, next - Date.now()));
  };

  const run = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      for (;;) {
        again = false;
        for (const action of planFleetSync(appAtomRegistry.get(fleetMachinesAtom))) {
          if (stopped) return;
          const key = fleetActionKey(action);
          const attempt = attempts.get(key);
          if (attempt !== undefined && attempt.retryAt > Date.now()) continue;
          const tries = (attempt?.tries ?? 0) + 1;
          // In flight, so a plan made before this machine's list updates doesn't repeat it.
          attempts.set(key, { tries, retryAt: Number.POSITIVE_INFINITY });
          try {
            await perform(action);
            // Until this machine's list shows the change, a new plan may still hold the action.
            attempts.set(key, { tries: 0, retryAt: Date.now() + DONE_SETTLE_MS });
            setProblem(key, undefined);
          } catch (error) {
            const delay = RETRY_DELAYS_MS[Math.min(tries, RETRY_DELAYS_MS.length) - 1] ?? 0;
            attempts.set(key, { tries, retryAt: Date.now() + delay });
            setProblem(key, errorText(error));
          }
        }
        if (!again || stopped) return;
      }
    } finally {
      running = false;
      if (!stopped) scheduleRetry();
    }
  };

  const unsubscribe = appAtomRegistry.subscribe(
    fleetMachinesAtom,
    (machines) => {
      for (const machine of machines) {
        const isSharing = machine.status.kind === "sharing";
        if (isSharing && !sharingBefore.has(machine.environmentId)) {
          // A machine that comes back gets a fresh try at what it refused or missed.
          for (const key of attempts.keys()) {
            if (key.startsWith(`${machine.environmentId}:`)) attempts.delete(key);
          }
          rescan(machine.environmentId);
        }
        if (isSharing) sharingBefore.add(machine.environmentId);
        else sharingBefore.delete(machine.environmentId);
      }
      void run();
    },
    { immediate: true },
  );
  return () => {
    stopped = true;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    unsubscribe();
  };
}
