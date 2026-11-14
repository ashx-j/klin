import { type PluginFleetEntry, PluginId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { fleetEntryBehind, mergeFleetEntries } from "./pluginFleet.ts";

const pluginId = PluginId.make("notes");
const entry = (overrides: Partial<PluginFleetEntry>): PluginFleetEntry => ({
  pluginId,
  revision: "a".repeat(64),
  version: "1.0.0",
  filesAt: 100,
  enabled: false,
  enabledAt: 0,
  ...overrides,
});

describe("mergeFleetEntries", () => {
  it("takes the newer files and the newer switch from different machines", () => {
    const updatedHere = entry({ revision: "b".repeat(64), version: "1.1.0", filesAt: 200 });
    const turnedOnThere = entry({ enabled: true, enabledAt: 150 });
    expect(mergeFleetEntries([updatedHere, turnedOnThere]).get(pluginId)).toEqual(
      entry({
        revision: "b".repeat(64),
        version: "1.1.0",
        filesAt: 200,
        enabled: true,
        enabledAt: 150,
      }),
    );
  });

  it("picks the same winner of a tie in any order", () => {
    const removed = entry({ revision: null, filesAt: 300, enabled: false, enabledAt: 300 });
    const installed = entry({ filesAt: 300, enabled: true, enabledAt: 300 });
    const merged = mergeFleetEntries([removed, installed]).get(pluginId);
    expect(mergeFleetEntries([installed, removed]).get(pluginId)).toEqual(merged);
    // Files: a fixed order by revision. Switch: off wins a tie.
    expect(merged).toMatchObject({ revision: "a".repeat(64), enabled: false });
  });
});

describe("fleetEntryBehind", () => {
  it("names what a machine lacks of the newest decision", () => {
    const decision = entry({ filesAt: 200, enabled: true, enabledAt: 200 });
    expect(fleetEntryBehind(undefined, decision)).toEqual({ files: true, switch: true });
    expect(fleetEntryBehind(entry({ filesAt: 200 }), decision)).toEqual({
      files: false,
      switch: true,
    });
    expect(fleetEntryBehind(decision, decision)).toEqual({ files: false, switch: false });
  });
});
