import { AsyncResult, Atom } from "effect/reactivity";

import { pluginEnvironment } from "../state/plugins";
import { environmentPresentations } from "../state/presentation";
import type { FleetMachine } from "./pluginFleetPlan";

/**
 * Every environment this window knows, as plugin sharing sees it. Reading it follows the plugin
 * list of each connected environment that runs plugins.
 */
export const fleetMachinesAtom = Atom.make((get): ReadonlyArray<FleetMachine> =>
  [...get(environmentPresentations.presentationsAtom)].map(([environmentId, presentation]) => {
    const machine = { environmentId, label: presentation.entry.target.label };
    if (presentation.connection.phase !== "connected") {
      return { ...machine, status: { kind: "offline" } };
    }
    if (presentation.serverConfig?.environment.capabilities.plugins !== true) {
      return { ...machine, status: { kind: "unavailable" } };
    }
    const result = get(pluginEnvironment.pluginsLive({ environmentId, input: {} }));
    if (!AsyncResult.isSuccess(result)) return { ...machine, status: { kind: "offline" } };
    const { plugins, fleet } = result.value;
    if (fleet === undefined) return { ...machine, status: { kind: "unavailable" } };
    if (!fleet.sharing) return { ...machine, status: { kind: "left-out" } };
    return { ...machine, status: { kind: "sharing", plugins, entries: fleet.entries } };
  }),
).pipe(Atom.withLabel("web-plugin-fleet-machines"));

/** Why copying a plugin to a machine failed, by `fleetActionKey`, for Settings to show. */
export const fleetProblemsAtom = Atom.make<ReadonlyMap<string, string>>(new Map()).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-plugin-fleet-problems"),
);
