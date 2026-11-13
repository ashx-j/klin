import type { PluginFleetEntry, PluginId } from "@t3tools/contracts";

/**
 * How machines agree on a plugin without a server in charge: each keeps the newest decision it
 * knows, and the files and the switch are each decided by the later time. A tie falls to a fixed
 * order, so every machine picks the same winner.
 */
type FilesDecision = Pick<PluginFleetEntry, "revision" | "filesAt">;
type SwitchDecision = Pick<PluginFleetEntry, "enabled" | "enabledAt">;

/** Positive when `a` holds the newer files decision, negative when `b` does, 0 when they match. */
const compareFleetFiles = (a: FilesDecision, b: FilesDecision) => {
  if (a.filesAt !== b.filesAt) return a.filesAt - b.filesAt;
  const left = a.revision ?? "";
  const right = b.revision ?? "";
  return left === right ? 0 : left > right ? 1 : -1;
};

/** Like `compareFleetFiles` for the switch. On a tie, off wins. */
const compareFleetSwitch = (a: SwitchDecision, b: SwitchDecision) =>
  a.enabledAt !== b.enabledAt ? a.enabledAt - b.enabledAt : Number(b.enabled) - Number(a.enabled);

/** The newest decision for each plugin across what several machines report. */
export const mergeFleetEntries = (
  entries: Iterable<PluginFleetEntry>,
): ReadonlyMap<PluginId, PluginFleetEntry> => {
  const merged = new Map<PluginId, PluginFleetEntry>();
  for (const entry of entries) {
    const known = merged.get(entry.pluginId);
    if (known === undefined) {
      merged.set(entry.pluginId, entry);
      continue;
    }
    const files = compareFleetFiles(entry, known) > 0 ? entry : known;
    const switched = compareFleetSwitch(entry, known) > 0 ? entry : known;
    merged.set(entry.pluginId, {
      pluginId: entry.pluginId,
      revision: files.revision,
      ...(files.version === undefined ? {} : { version: files.version }),
      filesAt: files.filesAt,
      enabled: switched.enabled,
      enabledAt: switched.enabledAt,
    });
  }
  return merged;
};

/** What a machine whose entry is `current` lacks of `decision`. */
export const fleetEntryBehind = (
  current: PluginFleetEntry | undefined,
  decision: PluginFleetEntry,
) => ({
  files: current === undefined || compareFleetFiles(decision, current) > 0,
  switch: current === undefined || compareFleetSwitch(decision, current) > 0,
});
