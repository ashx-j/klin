import { EnvironmentId, type PluginFleetEntry, PluginId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { type FleetMachine, planFleetSync } from "./pluginFleetPlan";

const notes = PluginId.make("notes");
const entry = (overrides: Partial<PluginFleetEntry> = {}): PluginFleetEntry => ({
  pluginId: notes,
  revision: "a".repeat(64),
  version: "1.0.0",
  filesAt: 100,
  enabled: false,
  enabledAt: 0,
  ...overrides,
});
const sharing = (id: string, entries: ReadonlyArray<PluginFleetEntry>): FleetMachine => ({
  environmentId: EnvironmentId.make(id),
  label: id,
  status: { kind: "sharing", plugins: [], entries },
});
const away = (id: string, kind: "offline" | "left-out" | "unavailable"): FleetMachine => ({
  environmentId: EnvironmentId.make(id),
  label: id,
  status: { kind },
});

describe("planFleetSync", () => {
  it("copies newer files from a machine that has them, to sharing machines only", () => {
    const updated = entry({
      revision: "b".repeat(64),
      filesAt: 200,
      enabled: true,
      enabledAt: 200,
    });
    expect(
      planFleetSync([
        sharing("pc", [entry()]),
        sharing("homeserver", [updated]),
        sharing("new-laptop", []),
        away("thinkpad2", "offline"),
        away("guest", "left-out"),
      ]),
    ).toEqual([
      { kind: "copy", from: "homeserver", to: "pc", entry: updated },
      { kind: "copy", from: "homeserver", to: "new-laptop", entry: updated },
    ]);
  });

  it("sends a switch or a removal without files, and nothing to a machine that has it", () => {
    const on = entry({ enabled: true, enabledAt: 300 });
    expect(planFleetSync([sharing("pc", [entry()]), sharing("homeserver", [on])])).toEqual([
      { kind: "apply", to: "pc", entry: on },
    ]);
    const removed = entry({ revision: null, filesAt: 400, enabledAt: 400 });
    expect(
      planFleetSync([sharing("pc", [on]), sharing("homeserver", [removed]), sharing("new", [])]),
    ).toEqual([
      { kind: "apply", to: "pc", entry: removed },
      { kind: "apply", to: "new", entry: removed },
    ]);
  });

  it("does nothing until two machines share", () => {
    expect(planFleetSync([sharing("pc", [entry()]), away("homeserver", "offline")])).toEqual([]);
  });
});
