import type { EnvironmentId, PluginFleetEntry, PluginId, PluginState } from "@t3tools/contracts";
import { fleetEntryBehind, mergeFleetEntries } from "@t3tools/shared/pluginFleet";

/**
 * One of the user's machines as plugin sharing sees it from this window. Only a machine this
 * window manages plugins on reports its shared entries, so `unavailable` covers a server without
 * plugins and a session without the rights to install them.
 */
export interface FleetMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly status:
    | { readonly kind: "offline" }
    | { readonly kind: "unavailable" }
    | { readonly kind: "left-out" }
    | {
        readonly kind: "sharing";
        readonly plugins: ReadonlyArray<PluginState>;
        readonly entries: ReadonlyArray<PluginFleetEntry>;
        /** Plugins the user keeps off this machine, which it neither gets nor gives. */
        readonly keptOff: ReadonlySet<PluginId>;
      };
}

/** Copies the files and switch from `from`, or applies a switch or removal that needs no files. */
export type FleetAction =
  | {
      readonly kind: "copy";
      readonly from: EnvironmentId;
      readonly to: EnvironmentId;
      readonly entry: PluginFleetEntry;
    }
  | { readonly kind: "apply"; readonly to: EnvironmentId; readonly entry: PluginFleetEntry };

/** Names an action by what it brings a machine to, so the same decision is tried once. */
export const fleetActionKey = (action: FleetAction) => {
  const { entry } = action;
  return `${action.to}:${entry.pluginId}:${entry.revision ?? "removed"}:${entry.filesAt}:${entry.enabled}:${entry.enabledAt}`;
};

const sharingOf = (machine: FleetMachine) =>
  machine.status.kind === "sharing" ? machine.status : undefined;

/** The newest decision for each plugin among the machines that share now. */
const fleetDecisions = (machines: ReadonlyArray<FleetMachine>) =>
  mergeFleetEntries(machines.flatMap((machine) => sharingOf(machine)?.entries ?? []));

/**
 * What brings every sharing machine to the newest decisions. Newer files come from a machine whose
 * entry is that decision, which therefore has them; a machine with the same files only records the
 * later time, and one with nothing for a removed plugin still records the removal, so it carries
 * it to machines it meets later.
 */
export function planFleetSync(machines: ReadonlyArray<FleetMachine>): ReadonlyArray<FleetAction> {
  const sharing = machines.flatMap((machine) => {
    const status = sharingOf(machine);
    return status === undefined
      ? []
      : [
          {
            environmentId: machine.environmentId,
            entries: new Map(status.entries.map((entry) => [entry.pluginId, entry])),
            keptOff: status.keptOff,
          },
        ];
  });
  if (sharing.length < 2) return [];
  const actions: Array<FleetAction> = [];
  for (const decision of fleetDecisions(machines).values()) {
    const source = sharing.find((machine) => {
      const entry = machine.entries.get(decision.pluginId);
      return entry !== undefined && !fleetEntryBehind(entry, decision).files;
    });
    for (const machine of sharing) {
      if (machine.keptOff.has(decision.pluginId)) continue;
      const current = machine.entries.get(decision.pluginId);
      const behind = fleetEntryBehind(current, decision);
      if (behind.files && decision.revision !== null && current?.revision !== decision.revision) {
        if (source !== undefined && source.environmentId !== machine.environmentId) {
          actions.push({
            kind: "copy",
            from: source.environmentId,
            to: machine.environmentId,
            entry: decision,
          });
        }
      } else if (behind.files || behind.switch) {
        actions.push({ kind: "apply", to: machine.environmentId, entry: decision });
      }
    }
  }
  return actions;
}

export type FleetPlacement =
  | { readonly kind: "here"; readonly plugin: PluginState | undefined }
  | { readonly kind: "pending"; readonly problem: string | undefined }
  | { readonly kind: "offline" | "unavailable" | "left-out" | "kept-off" };

/**
 * Where a plugin is across the user's machines, for its row in Settings. `problems` holds why an
 * action for a machine failed, by `fleetActionKey`.
 */
export function placementsOf(
  machines: ReadonlyArray<FleetMachine>,
  pluginId: PluginId,
  problems: ReadonlyMap<string, string>,
): ReadonlyArray<{ readonly machine: FleetMachine; readonly placement: FleetPlacement }> {
  const decision = fleetDecisions(machines).get(pluginId);
  const actions = planFleetSync(machines);
  return machines.flatMap(
    (
      machine,
    ): ReadonlyArray<{
      readonly machine: FleetMachine;
      readonly placement: FleetPlacement;
    }> => {
      const status = machine.status;
      if (status.kind !== "sharing") return [{ machine, placement: { kind: status.kind } }];
      if (status.keptOff.has(pluginId)) return [{ machine, placement: { kind: "kept-off" } }];
      const action = actions.find(
        (candidate) =>
          candidate.to === machine.environmentId && candidate.entry.pluginId === pluginId,
      );
      if (action !== undefined) {
        return [
          {
            machine,
            placement: { kind: "pending", problem: problems.get(fleetActionKey(action)) },
          },
        ];
      }
      if (decision?.revision === null) return [];
      const plugin = status.plugins.find((candidate) => candidate.id === pluginId);
      return [{ machine, placement: { kind: "here", plugin } }];
    },
  );
}
