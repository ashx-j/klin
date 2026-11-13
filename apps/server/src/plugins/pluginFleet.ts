// @effect-diagnostics nodeBuiltinImport:off - revisions are sha256 digests, built one file at a time.
import * as NodeCrypto from "node:crypto";

import {
  PLUGIN_UPLOAD_MAX_BYTES,
  PLUGIN_UPLOAD_MAX_FILES,
  type PluginFleet,
  type PluginFleetEntry,
  PluginId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { PluginsConfigFile, StoredFleetEntry } from "./pluginsConfig.ts";

/**
 * Plugin sharing; see docs/internals/plugins.md. An entry only ever describes files this machine
 * has, or a removal it carried out, so a folder that no longer matches its entry was changed here.
 */

// Clients leave these out of uploads, so they are never part of a plugin's files.
const LEFT_OUT = new Set([".git", "node_modules"]);
const isLeftOut = (relativePath: string) =>
  relativePath.split("/").some((segment) => LEFT_OUT.has(segment));

export interface PluginFile {
  /** Relative to the plugin folder, with `/` on every platform. */
  readonly path: string;
  readonly contents: Uint8Array;
}

/** Names a plugin's files the same way on every platform: their paths and bytes, in path order. */
export const filesRevision = (files: ReadonlyArray<PluginFile>) => {
  const hash = NodeCrypto.createHash("sha256");
  const kept = files
    .filter((file) => !isLeftOut(file.path))
    .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of kept) {
    hash.update(`${file.path}\0${file.contents.byteLength}\0`);
    hash.update(file.contents);
  }
  return hash.digest("hex");
};

class PluginFolderUnsharableError extends Schema.TaggedError<PluginFolderUnsharableError>()(
  "PluginFolderUnsharableError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

interface FolderFile {
  readonly path: string;
  readonly absolute: string;
  readonly size: number;
  readonly modifiedAt: number;
}

/** The files a copy of the plugin carries, with sizes and times, within the upload limits. */
const listFolder = Effect.fn("PluginFleet.listFolder")(function* (rootDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const unreadable = (cause: { readonly message: string }) =>
    new PluginFolderUnsharableError({ reason: `Could not read its folder: ${cause.message}` });
  const entries = yield* fs
    .readDirectory(rootDir, { recursive: true })
    .pipe(Effect.mapError(unreadable));
  const files: Array<FolderFile> = [];
  let bytes = 0;
  for (const entry of entries.toSorted()) {
    const relative = entry.split(path.sep).join("/");
    if (isLeftOut(relative)) continue;
    const absolute = path.join(rootDir, entry);
    const info = yield* fs.stat(absolute).pipe(Effect.mapError(unreadable));
    if (info.type !== "File") continue;
    const size = Number(info.size);
    bytes += size;
    if (files.length >= PLUGIN_UPLOAD_MAX_FILES || bytes > PLUGIN_UPLOAD_MAX_BYTES) {
      return yield* new PluginFolderUnsharableError({
        reason: `It has more than ${PLUGIN_UPLOAD_MAX_FILES} files or ${PLUGIN_UPLOAD_MAX_BYTES / 1024 / 1024} MB, so it can't be copied to other machines.`,
      });
    }
    files.push({
      path: relative,
      absolute,
      size,
      modifiedAt: Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() }),
    });
  }
  return files;
});

const readFolderFiles = Effect.fn("PluginFleet.readFolderFiles")(function* (
  files: ReadonlyArray<FolderFile>,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.forEach(files, (file) =>
    fs.readFile(file.absolute).pipe(
      Effect.map((contents): PluginFile => ({ path: file.path, contents })),
      Effect.mapError(
        (cause) =>
          new PluginFolderUnsharableError({
            reason: `Could not read ${file.path}: ${cause.message}`,
          }),
      ),
    ),
  );
});

/** A plugin folder's files and their revision, to send to another machine. */
export const readPluginFolder = Effect.fn("PluginFleet.readFolder")(function* (rootDir: string) {
  const files = yield* readFolderFiles(yield* listFolder(rootDir));
  return { files, revision: filesRevision(files) };
});

interface FolderRevision {
  readonly revision: string;
  /** The newest file time in the folder, which dates a change found by discovery. */
  readonly modifiedAt: number;
}

/**
 * Revisions of plugin folders for discovery, which runs on every visit to Settings. A folder whose
 * files keep their sizes and times is not read again.
 */
export const makeRevisionCache = () => {
  const known = new Map<string, { readonly signature: string; readonly result: FolderRevision }>();
  return Effect.fn("PluginFleet.revisionOf")(function* (rootDir: string) {
    const listed = yield* listFolder(rootDir);
    const signature = listed
      .map((file) => `${file.path}\0${file.size}\0${file.modifiedAt}`)
      .join("\0");
    const cached = known.get(rootDir);
    if (cached?.signature === signature) return cached.result;
    const files = yield* readFolderFiles(listed);
    const result: FolderRevision = {
      revision: filesRevision(files),
      modifiedAt: listed.reduce((newest, file) => Math.max(newest, file.modifiedAt), 0),
    };
    known.set(rootDir, { signature, result });
    return result;
  });
};

const isPluginId = Schema.is(PluginId);

const fleetEntriesOf = (config: PluginsConfigFile): ReadonlyArray<PluginFleetEntry> =>
  Object.entries(config.fleet?.entries ?? {}).flatMap(([pluginId, entry]) =>
    isPluginId(pluginId) ? [{ pluginId, ...entry }] : [],
  );

export const fleetOf = (config: PluginsConfigFile): PluginFleet => ({
  sharing: config.fleet?.sharing !== false,
  entries: fleetEntriesOf(config),
});

export const withFleetEntry = (
  config: PluginsConfigFile,
  entry: PluginFleetEntry,
): PluginsConfigFile => {
  const { pluginId, ...stored } = entry;
  return {
    ...config,
    fleet: { ...config.fleet, entries: { ...config.fleet?.entries, [pluginId]: stored } },
  };
};

/** One discovered plugin with readable files, as the ledger sees it. */
export interface FoundPlugin extends FolderRevision {
  readonly pluginId: PluginId;
  readonly version: string;
}

/**
 * Records changes made here outside a copy: changed and new folders, and removed ones after a
 * discovery that read every folder. `present` holds every id discovery listed, failed ones
 * included. A change takes its newest file time. Returns undefined when nothing changed.
 */
export const recordLocalChanges = (input: {
  readonly config: PluginsConfigFile;
  readonly found: ReadonlyArray<FoundPlugin>;
  readonly present: ReadonlySet<string>;
  readonly complete: boolean;
  readonly now: number;
}): PluginsConfigFile | undefined => {
  const { config, now } = input;
  const entries: Record<string, StoredFleetEntry> = { ...config.fleet?.entries };
  let changed = false;
  for (const plugin of input.found) {
    const entry = entries[plugin.pluginId];
    if (entry?.revision === plugin.revision) continue;
    const changedAt = Math.min(Math.max(0, plugin.modifiedAt), now);
    changed = true;
    if (entry === undefined) {
      const enabled = config.enabled?.[plugin.pluginId] === true;
      entries[plugin.pluginId] = {
        revision: plugin.revision,
        version: plugin.version,
        filesAt: changedAt,
        enabled,
        // Off is the default, not a decision, so a switch turned on elsewhere wins over it.
        enabledAt: enabled ? changedAt : 0,
      };
    } else {
      entries[plugin.pluginId] = {
        ...entry,
        revision: plugin.revision,
        version: plugin.version,
        filesAt: Math.max(changedAt, entry.filesAt + 1),
      };
    }
  }
  if (input.complete) {
    for (const [pluginId, entry] of Object.entries(entries)) {
      if (entry.revision === null || input.present.has(pluginId)) continue;
      changed = true;
      entries[pluginId] = {
        revision: null,
        filesAt: Math.max(now, entry.filesAt + 1),
        enabled: false,
        enabledAt: Math.max(now, entry.enabledAt + 1),
      };
    }
  }
  return changed ? { ...config, fleet: { ...config.fleet, entries } } : undefined;
};

/** Records a switch the user flipped here, if the plugin is shared. */
export const recordSwitch = (
  config: PluginsConfigFile,
  pluginId: PluginId,
  enabled: boolean,
  now: number,
): PluginsConfigFile => {
  const entry = config.fleet?.entries?.[pluginId];
  if (entry === undefined || entry.revision === null) return config;
  return withFleetEntry(config, {
    pluginId,
    ...entry,
    enabled,
    enabledAt: Math.max(now, entry.enabledAt + 1),
  });
};
