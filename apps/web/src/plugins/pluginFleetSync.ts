import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { pluginEnvironment } from "../state/plugins";
import { fleetMachinesAtom, fleetProblemsAtom } from "./pluginFleet";
import { copyPlugin } from "./pluginFiles";
import { type FleetAction, fleetActionKey, planFleetSync } from "./pluginFleetPlan";

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

/**
 * Copies the newest plugin decisions to the machines this window manages that are behind, one at a
 * time, whenever a machine's plugins or connection change. Each action is tried once per connection
 * to its machine, so one a machine refuses shows in Settings instead of repeating. Servers check
 * that an entry is newer, so two windows doing this at once apply each change once.
 */
export function startPluginFleetSync(): () => void {
  let stopped = false;
  let running = false;
  let again = false;
  const tried = new Set<string>();
  const sharingBefore = new Set<EnvironmentId>();

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
          if (tried.has(key)) continue;
          tried.add(key);
          try {
            await perform(action);
            setProblem(key, undefined);
          } catch (error) {
            setProblem(key, errorText(error));
          }
        }
        if (!again || stopped) return;
      }
    } finally {
      running = false;
    }
  };

  const unsubscribe = appAtomRegistry.subscribe(
    fleetMachinesAtom,
    (machines) => {
      // A machine that comes back gets another try at what it refused or missed.
      for (const machine of machines) {
        const isSharing = machine.status.kind === "sharing";
        if (isSharing && !sharingBefore.has(machine.environmentId)) {
          for (const key of tried)
            if (key.startsWith(`${machine.environmentId}:`)) tried.delete(key);
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
    unsubscribe();
  };
}
