import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PluginState } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { fleetMachinesAtom, fleetProblemsAtom } from "../../../plugins/pluginFleet";
import { type FleetPlacement, placementsOf } from "../../../plugins/pluginFleetPlan";
import { pluginEnvironment } from "../../../state/plugins";
import { useEnvironments } from "../../../state/environments";
import { useAtomCommand } from "../../../state/use-atom-command";
import { Button } from "../../ui/button";
import { Switch } from "../../ui/switch";
import { settingsScopeEnvironmentLabel } from "../settingsScopeAxis";
import { SettingsRow } from "../settingsLayout";

/** Whether this machine shares plugins with the user's other machines, and the switch for it. */
export function PluginSharingRow({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const result = useAtomValue(pluginEnvironment.pluginsLive({ environmentId, input: {} }));
  const fleet = AsyncResult.getOrElse(result, () => null)?.fleet;
  const canManage = useAtomValue(pluginEnvironment.setPluginSharing.permissionAtom(environmentId));
  const setSharing = useAtomCommand(pluginEnvironment.setPluginSharing, "plugin sharing");
  if (fleet === undefined || fleet === null) return null;
  return (
    <SettingsRow
      title="Share plugins with my other machines"
      description={
        fleet.sharing
          ? "Installing, updating, turning on or off, or removing a plugin here does the same on every machine this app connects to that shares plugins, and the same from them. Settings stay on each machine."
          : "This machine keeps its own plugins, and changes stop going to and from it. Turned back on, changes made here meanwhile go out too, removals included."
      }
      control={
        <Switch
          checked={fleet.sharing}
          disabled={!canManage}
          aria-label="Share plugins with my other machines"
          onCheckedChange={(sharing) => void setSharing({ environmentId, input: { sharing } })}
        />
      }
    />
  );
}

const placementText = (placement: FleetPlacement) => {
  switch (placement.kind) {
    case "here":
      return placementOfPlugin(placement.plugin);
    case "pending":
      return placement.problem === undefined ? "copying" : `not copied: ${placement.problem}`;
    case "offline":
      return "offline, catches up when it connects";
    case "left-out":
      return "doesn't share plugins";
    case "kept-off":
      return "kept off";
    case "unavailable":
      return undefined;
  }
};

const placementOfPlugin = (plugin: PluginState | undefined) => {
  if (plugin === undefined) return undefined;
  if (plugin.status === "failed") return `can't run it: ${plugin.failure?.message ?? "it failed"}`;
  return plugin.enabled ? "on" : "off";
};

/**
 * Which of the user's machines have the plugin and how it runs there, shown while this machine
 * shares plugins and another machine is known.
 */
export function PluginPlacements({
  environmentId,
  plugin,
}: {
  readonly environmentId: EnvironmentId;
  readonly plugin: PluginState;
}) {
  const machines = useAtomValue(fleetMachinesAtom);
  const problems = useAtomValue(fleetProblemsAtom);
  const { environments } = useEnvironments();
  const setKeptOff = useAtomCommand(pluginEnvironment.setPluginKeptOff, "plugin kept off");
  // Tells apart machines with the same name, as the scope picker at the top does.
  const labelOf = (machineId: EnvironmentId, label: string) => {
    const environment = environments.find((entry) => entry.environmentId === machineId);
    return environment === undefined
      ? label
      : settingsScopeEnvironmentLabel(environment, environments);
  };
  const here = machines.find((machine) => machine.environmentId === environmentId);
  if (here?.status.kind !== "sharing") return null;
  const lines = placementsOf(machines, plugin.id, problems).flatMap(({ machine, placement }) => {
    const text = placementText(placement);
    return text === undefined ? [] : [{ machine, placement, text }];
  });
  return (
    <>
      {plugin.sharingProblem === undefined ? null : (
        <span className="block text-destructive">
          Not copied to your other machines: {plugin.sharingProblem}
        </span>
      )}
      {lines.length < 2 ? null : (
        <span className="block">
          On your machines:
          {lines.map(({ machine, placement, text }) => (
            <span
              key={machine.environmentId}
              className={
                placement.kind === "pending" && placement.problem !== undefined
                  ? "block text-destructive"
                  : "block"
              }
            >
              {labelOf(machine.environmentId, machine.label)}: {text}
              {placement.kind === "kept-off" ? (
                <>
                  {" "}
                  <Button
                    size="micro"
                    variant="link"
                    onClick={() =>
                      void setKeptOff({
                        environmentId: machine.environmentId,
                        input: { pluginId: plugin.id, keptOff: false },
                      })
                    }
                  >
                    Add back
                  </Button>
                </>
              ) : null}
            </span>
          ))}
        </span>
      )}
    </>
  );
}
