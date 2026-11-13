import {
  type PluginFleetEntry,
  type PluginId,
  PluginManifest,
  type PluginState,
  type PluginUploadFile,
} from "@t3tools/contracts";
import { fleetEntryBehind } from "@t3tools/shared/pluginFleet";
import { satisfiesSemverRange } from "@t3tools/shared/semver";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import type { DiscoveredPlugin } from "./pluginDiscovery.ts";
import {
  filesRevision,
  keptOffOf,
  type PluginFile,
  readPluginFolder,
  withFleetEntry,
} from "./pluginFleet.ts";
import type { PluginNotFoundError } from "./PluginHost.ts";
import { type PluginConfigError, type PluginsConfigFile, withoutCrash } from "./pluginsConfig.ts";
import * as PluginSettingsStore from "./PluginSettingsStore.ts";
import * as PluginStorage from "./PluginStorage.ts";

// `reason` is shown to the user as is, so it says what to fix.
export class PluginInstallError extends Schema.TaggedError<PluginInstallError>()(
  "PluginInstallError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.reason;
  }
}

/**
 * The host builds it and hands it the lifecycle lock, the plugin list and plugins.json, so the host
 * keeps discovery, activation and state, and a new install source only changes this file.
 */
export class PluginInstaller extends Context.Service<
  PluginInstaller,
  {
    /**
     * Installs a plugin folder a client sent as files into the plugins folder. A new plugin is
     * turned off; a replaced one keeps its switch and restarts if on. It is staged first and
     * swapped in with a rename, so a failed install leaves the previous version.
     */
    readonly installFiles: (
      files: ReadonlyArray<PluginUploadFile>,
      /**
       * Makes the upload a copy from another of the user's machines: the files must match its
       * revision, they replace only older files, the plugin takes the entry's switch, and a
       * version that fails to start stays, as it does on the other machines.
       */
      fleet?: PluginFleetEntry,
    ) => Effect.Effect<PluginState, PluginInstallError | PluginNotFoundError | PluginConfigError>;
    /**
     * Brings this machine to a shared entry where it is newer: removes the plugin or turns it on or
     * off. Newer files must come through `installFiles`.
     */
    readonly applyFleet: (
      entry: PluginFleetEntry,
    ) => Effect.Effect<
      { readonly applied: boolean },
      PluginInstallError | PluginNotFoundError | PluginConfigError
    >;
    /** A plugin's files and their revision, to copy it to another machine. */
    readonly exportFiles: (
      pluginId: PluginId,
    ) => Effect.Effect<
      { readonly revision: string; readonly files: ReadonlyArray<PluginFile> },
      PluginInstallError | PluginNotFoundError
    >;
    /** Takes this machine out of plugin sharing, or back in. Its plugins stay as they are. */
    readonly setSharing: (sharing: boolean) => Effect.Effect<void, PluginConfigError>;
    /**
     * Keeps a plugin off this machine, removing it and its data here only, or lets other machines
     * copy it here again.
     */
    readonly setKeptOff: (
      pluginId: PluginId,
      keptOff: boolean,
    ) => Effect.Effect<void, PluginInstallError | PluginNotFoundError | PluginConfigError>;
    /**
     * Loads the plugin in `folder`, an absolute path on the server, where it is, turned off like an
     * install. Refuses a folder without a manifest this server can run, and an id already listed.
     */
    readonly link: (
      folder: string,
    ) => Effect.Effect<PluginState, PluginInstallError | PluginNotFoundError | PluginConfigError>;
    /**
     * Stops a plugin and deletes its folder, settings, secrets and storage; a linked folder is
     * only forgotten. Refuses an id more than one folder has, whose data the other folders use.
     */
    readonly uninstall: (
      pluginId: PluginId,
    ) => Effect.Effect<void, PluginInstallError | PluginNotFoundError | PluginConfigError>;
  }
>()("t3/plugins/PluginInstaller") {}

export interface PluginInstallerHost {
  /**
   * Runs `body` under the lifecycle lock in the host's scope, so a caller that disconnects only
   * stops waiting and never leaves a plugin half replaced.
   */
  readonly lifecycle: <A, E>(body: Effect.Effect<A, E>) => Effect.Effect<A, E>;
  readonly plugins: Effect.Effect<ReadonlyArray<DiscoveredPlugin>>;
  readonly pluginOf: (pluginId: PluginId) => Effect.Effect<DiscoveredPlugin, PluginNotFoundError>;
  /** Stops a plugin; the caller sets what comes next. Only under `lifecycle`. */
  readonly stop: (pluginId: PluginId) => Effect.Effect<void>;
  /** Rescans the plugin folders without restarting anything. Only under `lifecycle`. */
  readonly rescan: Effect.Effect<void, PluginConfigError>;
  /** What clients see of a plugin now. */
  readonly stateOf: (pluginId: PluginId) => Effect.Effect<PluginState, PluginNotFoundError>;
  /**
   * Restarts the plugin with its current files, waiting until it has started. A linked folder is
   * not recorded for other machines, so a restart the user didn't ask for never shares its edits.
   */
  readonly restart: (
    pluginId: PluginId,
  ) => Effect.Effect<PluginState, PluginNotFoundError | PluginConfigError>;
  /** Rescans the plugin folders and restarts the plugin, waiting until it has started. */
  readonly reload: (
    pluginId: PluginId,
  ) => Effect.Effect<PluginState, PluginNotFoundError | PluginConfigError>;
  /** plugins.json as last read or written. */
  readonly config: Effect.Effect<PluginsConfigFile>;
  readonly writeConfig: (
    update: (current: PluginsConfigFile) => PluginsConfigFile,
  ) => Effect.Effect<void, PluginConfigError>;
}

type InstallOrigin = {
  readonly files: ReadonlyArray<PluginUploadFile>;
  readonly fleet?: PluginFleetEntry;
};

/** Why this machine takes no copy of the plugin from another machine, if it doesn't. */
const fleetRefusal = (config: PluginsConfigFile, pluginId: PluginId) => {
  if (config.fleet?.sharing === false) {
    return "This machine is left out of plugin sharing. Turn sharing on for it in Settings → Plugins.";
  }
  if (keptOffOf(config).has(pluginId)) return `${pluginId} is kept off this machine.`;
  return undefined;
};

const decodeManifestJson = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginManifest));

const installFailed = (reason: string) => (cause: unknown) =>
  new PluginInstallError({ reason, cause });

const isDuplicate = (
  plugin: DiscoveredPlugin,
): plugin is Extract<DiscoveredPlugin, { readonly failure: unknown }> =>
  "failure" in plugin && plugin.failure.stage === "duplicate";

/** The host runs `recoverStaging` before its first discovery. */
export const make = Effect.fn("PluginInstaller.make")(function* (host: PluginInstallerHost) {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const settingsStore = yield* PluginSettingsStore.PluginSettingsStore;
  const storage = yield* PluginStorage.PluginStorage;
  const scope = yield* Effect.scope;

  const pluginsDir = path.join(config.stateDir, "plugins");
  const stagingRoot = path.join(config.stateDir, "plugin-staging");

  // An install interrupted mid-swap (a crash) can leave the old version only in staging. Listed
  // while the layer builds, before the server serves requests, so recovery never touches the
  // staging folder of an install that starts after that.
  const leftoverStaging = yield* fs
    .readDirectory(stagingRoot)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const recoverStaging = Effect.gen(function* () {
    for (const entry of leftoverStaging) {
      const previous = path.join(stagingRoot, entry, "previous");
      const manifest = yield* fs
        .readFileString(path.join(previous, "t3-plugin.json"))
        .pipe(Effect.flatMap(decodeManifestJson), Effect.option);
      if (Option.isSome(manifest)) {
        const target = path.join(pluginsDir, manifest.value.id);
        const replaced = yield* fs.exists(target).pipe(Effect.orElseSucceed(() => true));
        if (!replaced) {
          yield* fs.makeDirectory(pluginsDir, { recursive: true }).pipe(Effect.ignore);
          yield* fs.rename(previous, target).pipe(Effect.ignore);
        }
      }
      yield* fs
        .remove(path.join(stagingRoot, entry), { recursive: true, force: true })
        .pipe(Effect.ignore);
    }
  }).pipe(Effect.withSpan("PluginInstaller.recoverStaging"));

  // A caller that disconnects stops waiting but cannot interrupt a swap or a staging cleanup.
  const inHostScope = <A, E>(body: Effect.Effect<A, E>) =>
    body.pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join));

  const readSourceManifest = (folder: string) =>
    fs.readFileString(path.join(folder, "t3-plugin.json")).pipe(
      Effect.mapError(installFailed("The folder has no t3-plugin.json.")),
      Effect.flatMap((raw) =>
        decodeManifestJson(raw).pipe(
          Effect.mapError(installFailed("The folder's t3-plugin.json is not a valid manifest.")),
        ),
      ),
    );

  // The upload schema checks that every path stays inside `into`.
  const writeFiles = Effect.fn("PluginInstaller.writeFiles")(function* (
    files: ReadonlyArray<{ readonly path: string; readonly contents: Uint8Array }>,
    into: string,
  ) {
    for (const file of files) {
      const target = path.join(into, ...file.path.split("/"));
      yield* fs
        .makeDirectory(path.dirname(target), { recursive: true })
        .pipe(
          Effect.andThen(fs.writeFile(target, file.contents)),
          Effect.mapError(installFailed(`Could not write ${file.path}.`)),
        );
    }
  });

  /** Why this server cannot run `manifest`, checked before anything is stopped or moved. */
  const refusal = (manifest: PluginManifest) => {
    if (!satisfiesSemverRange(packageJson.version, manifest.engines.t3)) {
      return `${manifest.name} ${manifest.version} needs T3 Code ${manifest.engines.t3}, and this server is ${packageJson.version}.`;
    }
    const schemaProblem =
      manifest.settingsSchema === undefined
        ? undefined
        : PluginSettingsStore.settingsSchemaProblem(manifest.settingsSchema);
    return schemaProblem === undefined
      ? undefined
      : `${manifest.name} ${manifest.version} has a settingsSchema T3 Code cannot validate: ${schemaProblem}`;
  };

  /**
   * Swaps `<stagingDir>/plugin` into the plugins folder under the lifecycle lock and starts it if it
   * is on. The replaced version waits in `<stagingDir>/previous` and goes back if the new one fails
   * to start. `stagingDir` is removed unless it holds a version's only copy, which startup then
   * restores.
   */
  const swapIn = Effect.fn("PluginInstaller.swapIn")(function* (
    manifest: PluginManifest,
    stagingDir: string,
    fleet: PluginFleetEntry | undefined,
  ) {
    const staged = path.join(stagingDir, "plugin");
    const previous = path.join(stagingDir, "previous");
    let stopped = false;
    let stranded = false;
    yield* Effect.addFinalizer(() => (stranded ? Effect.void : removeStaging(stagingDir)));
    const swapped = yield* host
      .lifecycle(
        // Read under the lock, so another install or a removal cannot change them before the swap.
        Effect.gen(function* () {
          const plugins = yield* host.plugins;
          const existing = plugins.find((plugin) => plugin.id === manifest.id);
          if (existing !== undefined && isDuplicate(existing)) {
            return yield* new PluginInstallError({ reason: existing.failure.message });
          }
          // An installed copy the user drops replaces a linked folder and keeps its data; the
          // folder stays. A copy from another machine never replaces what is being developed here.
          const linkedFolder = existing?.source === "dev" ? existing.folder : undefined;
          if (linkedFolder !== undefined && fleet !== undefined) {
            return yield* new PluginInstallError({
              reason: `${manifest.id} is linked here from ${linkedFolder}, so it keeps that folder. Reload it there to share it.`,
            });
          }
          const fresh = existing === undefined || linkedFolder !== undefined;
          const target = fresh ? path.join(pluginsDir, manifest.id) : existing.folder;
          // A folder put there by hand holds another plugin, or none, which the swap would delete.
          if (fresh && (yield* fs.exists(target).pipe(Effect.orElseSucceed(() => true)))) {
            const owner = plugins.find((plugin) => plugin.folder === target);
            return yield* new PluginInstallError({
              reason: `The plugins folder already has a ${manifest.id} folder${owner === undefined ? "" : ` holding ${owner.id}`}. Move it, then install again.`,
            });
          }
          const config = yield* host.config;
          // A new plugin starts off, so none of it runs until the user has seen its row and turned
          // it on. A replaced one keeps its switch. A copy from another machine takes the newer of
          // its switch and this machine's.
          let enabled = existing !== undefined && config.enabled?.[manifest.id] === true;
          let shared: PluginFleetEntry | undefined;
          if (fleet !== undefined) {
            const refused = fleetRefusal(config, manifest.id);
            if (refused !== undefined) return yield* new PluginInstallError({ reason: refused });
            const stored = config.fleet?.entries?.[manifest.id];
            const current = stored === undefined ? undefined : { pluginId: manifest.id, ...stored };
            const behind = fleetEntryBehind(current, fleet);
            // The same files with a later time only need recording, which `applyFleet` does.
            if (!behind.files || current?.revision === fleet.revision) {
              return { skipped: true } as const;
            }
            const switched = behind.switch || current === undefined ? fleet : current;
            // A switch nobody flipped since sharing began leaves this machine's own.
            if (switched.enabledAt > 0) enabled = switched.enabled;
            shared = { ...fleet, enabled: switched.enabled, enabledAt: switched.enabledAt };
          }
          stopped = true;
          yield* host.stop(manifest.id);
          yield* fs
            .makeDirectory(pluginsDir, { recursive: true })
            .pipe(Effect.mapError(installFailed("Could not create the plugins folder.")));
          const hadPrevious = yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false));
          if (hadPrevious) {
            yield* fs
              .rename(target, previous)
              .pipe(Effect.mapError(installFailed("Could not move the installed version aside.")));
          }
          yield* fs.rename(staged, target).pipe(
            Effect.mapError(installFailed("Could not move the new version into place.")),
            Effect.tapError(() =>
              hadPrevious ? fs.rename(previous, target).pipe(Effect.ignore) : Effect.void,
            ),
          );
          yield* host.writeConfig((current) => {
            const next = {
              ...current,
              enabled: { ...current.enabled, [manifest.id]: enabled },
              ...(linkedFolder === undefined
                ? {}
                : {
                    devPaths: (current.devPaths ?? []).filter(
                      (entry) => path.resolve(entry) !== linkedFolder,
                    ),
                  }),
            };
            return shared === undefined ? next : withFleetEntry(next, shared);
          });
          return {
            skipped: false,
            target,
            hadPrevious,
            replacedVersion:
              existing !== undefined && "manifest" in existing
                ? existing.manifest.version
                : undefined,
          };
        }),
      )
      .pipe(
        // Whatever failed after the stop, the plugin folder holds one version; start it again.
        Effect.onError(() =>
          stopped ? host.restart(manifest.id).pipe(Effect.ignore) : Effect.void,
        ),
      );
    if (swapped.skipped) {
      // Files this machine already has, or newer ones; the entry may still carry a newer switch.
      if (fleet !== undefined) yield* applyFleet(fleet);
      return yield* host.stateOf(manifest.id);
    }
    const started = yield* host.restart(manifest.id);
    // A copy keeps a version that fails to start, as every other machine has it.
    if (!swapped.hadPrevious || started.status !== "failed" || fleet !== undefined) return started;
    yield* host
      .lifecycle(
        Effect.gen(function* () {
          yield* host.stop(manifest.id);
          yield* fs
            .rename(swapped.target, path.join(stagingDir, "failed"))
            .pipe(Effect.mapError(installFailed("Could not move the failed version aside.")));
          yield* fs.rename(previous, swapped.target).pipe(
            Effect.tapError(() =>
              Effect.sync(() => {
                stranded = true;
              }),
            ),
            Effect.mapError(
              installFailed("Could not put the previous version back. Restart T3 Code to finish."),
            ),
          );
        }),
      )
      .pipe(Effect.ensuring(host.restart(manifest.id).pipe(Effect.ignore)));
    return yield* new PluginInstallError({
      reason: `${manifest.name} ${manifest.version} failed to start, so ${swapped.replacedVersion ?? "the previous version"} is back. It failed with: ${started.failure?.message ?? "an unknown error"}`,
    });
  }, Effect.scoped);

  const stage = Effect.fn("PluginInstaller.stage")(function* (origin: InstallOrigin) {
    const stagingDir = path.join(stagingRoot, yield* random.uuidV4().pipe(Effect.orDie));
    const staged = path.join(stagingDir, "plugin");
    yield* fs
      .makeDirectory(stagingDir, { recursive: true })
      .pipe(Effect.mapError(installFailed("Could not create the staging folder.")));
    return yield* Effect.gen(function* () {
      yield* writeFiles(origin.files, staged);
      return { stagingDir, manifest: yield* readSourceManifest(staged) };
    }).pipe(Effect.tapError(() => removeStaging(stagingDir)));
  });

  const removeStaging = (stagingDir: string) =>
    fs.remove(stagingDir, { recursive: true, force: true }).pipe(Effect.ignore);

  const installOrigin = Effect.fn("PluginInstaller.installOrigin")(function* (
    origin: InstallOrigin,
  ) {
    const { fleet } = origin;
    // Checked before anything is written, so a copy that doesn't match its entry changes nothing.
    if (fleet !== undefined && filesRevision(origin.files) !== fleet.revision) {
      return yield* new PluginInstallError({
        reason: "The copied files don't match the revision they were sent as. Try again.",
      });
    }
    const { stagingDir, manifest } = yield* stage(origin);
    const reason =
      fleet !== undefined && manifest.id !== fleet.pluginId
        ? `The copied files are plugin ${manifest.id}, not ${fleet.pluginId}.`
        : refusal(manifest);
    if (reason !== undefined) {
      yield* removeStaging(stagingDir);
      return yield* new PluginInstallError({ reason });
    }
    return yield* swapIn(manifest, stagingDir, fleet);
  });

  // `PluginUploadFiles` bounds the folder's size before it gets here.
  const installFiles: PluginInstaller["Service"]["installFiles"] = Effect.fn(
    "PluginInstaller.installFiles",
  )((files, fleet) =>
    inHostScope(installOrigin(fleet === undefined ? { files } : { files, fleet })),
  );

  const link: PluginInstaller["Service"]["link"] = Effect.fn("PluginInstaller.link")(
    function* (input) {
      // A relative path would resolve against wherever the server happened to start.
      if (!path.isAbsolute(input)) {
        return yield* new PluginInstallError({
          reason: "Give the folder's absolute path on the server.",
        });
      }
      const folder = path.resolve(input);
      const manifest = yield* readSourceManifest(folder);
      const reason = refusal(manifest);
      if (reason !== undefined) return yield* new PluginInstallError({ reason });
      const realOf = (location: string) =>
        fs.realPath(location).pipe(Effect.orElseSucceed(() => location));
      const overlap = (a: string, b: string) =>
        a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
      const linked = yield* realOf(folder);
      // Replacing an installed copy deletes its folder, which must never be the one being linked.
      if (overlap(linked, yield* realOf(pluginsDir))) {
        return yield* new PluginInstallError({
          reason: "Link a folder outside the plugins folder. Folders in it are already installed.",
        });
      }
      yield* host.lifecycle(
        Effect.gen(function* () {
          const existing = (yield* host.plugins).find((plugin) => plugin.id === manifest.id);
          if (existing?.source === "dev") {
            return yield* new PluginInstallError({
              reason: `${manifest.id} is already linked from ${existing.folder}. Unlink it first.`,
            });
          }
          if (existing !== undefined && isDuplicate(existing)) {
            return yield* new PluginInstallError({ reason: existing.failure.message });
          }
          if (existing !== undefined && overlap(linked, existing.rootDir)) {
            return yield* new PluginInstallError({
              reason: `${folder} holds the installed copy of ${manifest.id}, so it can't be linked.`,
            });
          }
          // Linking replaces an installed copy and keeps its switch, settings and data, so moving
          // to a development folder never removes the plugin from the user's other machines.
          if (existing !== undefined) {
            yield* host.stop(manifest.id);
            yield* fs
              .remove(existing.folder, { recursive: true, force: true })
              .pipe(Effect.mapError(installFailed(`Could not delete ${existing.folder}.`)));
          }
          yield* host.writeConfig((current) => ({
            ...current,
            devPaths: [...(current.devPaths ?? []), folder],
            enabled: {
              ...current.enabled,
              [manifest.id]: existing !== undefined && current.enabled?.[manifest.id] === true,
            },
          }));
        }),
      );
      return yield* host.reload(manifest.id);
    },
  );

  const removeFromConfig = (pluginId: PluginId) =>
    host.writeConfig((current) => {
      const { [pluginId]: _removed, ...enabled } = current.enabled ?? {};
      return { ...withoutCrash(current, pluginId), enabled };
    });

  const forgetDevPath = (folder: string) =>
    host.writeConfig((current) => ({
      ...current,
      devPaths: (current.devPaths ?? []).filter((entry) => path.resolve(entry) !== folder),
    }));

  // The folder as listed, not `rootDir`: that is the real path, so a symlinked plugin would delete
  // the user's own folder behind the link. A linked folder is the author's own; only plugins.json
  // forgets it.
  const removeFolder = (plugin: DiscoveredPlugin) =>
    plugin.source === "dev"
      ? forgetDevPath(plugin.folder)
      : fs
          .remove(plugin.folder, { recursive: true, force: true })
          .pipe(Effect.mapError(installFailed(`Could not delete ${plugin.folder}.`)));

  /**
   * Only under the lock. `shared` is the removal to record for the user's other machines when it
   * came from one of them; a removal made here is recorded by the rescan that follows.
   */
  const remove = Effect.fn("PluginInstaller.remove")(function* (
    plugin: DiscoveredPlugin,
    markStopped: () => void,
    shared?: PluginFleetEntry,
  ) {
    const pluginId = plugin.id;
    if (isDuplicate(plugin)) {
      return yield* new PluginInstallError({ reason: plugin.failure.message });
    }
    markStopped();
    yield* host.stop(pluginId);
    yield* removeFolder(plugin);
    yield* removeFromConfig(pluginId);
    if (shared !== undefined) yield* host.writeConfig((current) => withFleetEntry(current, shared));
    yield* host.rescan;
    // Under the lock, or an install that starts meanwhile could lose its new settings.
    yield* settingsStore
      .clear(pluginId)
      .pipe(Effect.mapError(installFailed("The plugin is removed, but its settings are not.")));
    yield* storage
      .clear(pluginId)
      .pipe(Effect.mapError(installFailed("The plugin is removed, but its storage is not.")));
  });

  const uninstall: PluginInstaller["Service"]["uninstall"] = Effect.fn("PluginInstaller.uninstall")(
    (pluginId) => {
      let stopped = false;
      return host
        .lifecycle(
          host.pluginOf(pluginId).pipe(
            Effect.flatMap((plugin) =>
              remove(plugin, () => {
                stopped = true;
              }),
            ),
          ),
        )
        .pipe(
          // As for an install: whatever failed after the stop, what is left starts again if on.
          Effect.onError(() =>
            stopped ? host.restart(pluginId).pipe(Effect.ignore) : Effect.void,
          ),
        );
    },
  );

  const applyFleet: PluginInstaller["Service"]["applyFleet"] = Effect.fn(
    "PluginInstaller.applyFleet",
  )(function* (entry) {
    const { pluginId } = entry;
    let stopped = false;
    const outcome = yield* host
      .lifecycle(
        Effect.gen(function* () {
          const config = yield* host.config;
          const refused = fleetRefusal(config, pluginId);
          if (refused !== undefined) return yield* new PluginInstallError({ reason: refused });
          const stored = config.fleet?.entries?.[pluginId];
          const current = stored === undefined ? undefined : { pluginId, ...stored };
          const behind = fleetEntryBehind(current, entry);
          if (!behind.files && !behind.switch) return "unchanged" as const;
          const plugin = (yield* host.plugins).find((candidate) => candidate.id === pluginId);
          const sameFiles = current !== undefined && current.revision === entry.revision;
          if (behind.files && !sameFiles) {
            if (entry.revision !== null) {
              return yield* new PluginInstallError({
                reason: `${pluginId} has newer files on another machine, which come as an upload.`,
              });
            }
            const switched = behind.switch || current === undefined ? entry : current;
            const removal = { ...entry, enabled: switched.enabled, enabledAt: switched.enabledAt };
            if (plugin === undefined) {
              yield* host.writeConfig((latest) => withFleetEntry(latest, removal));
              yield* host.rescan;
            } else {
              yield* remove(
                plugin,
                () => {
                  stopped = true;
                },
                removal,
              );
            }
            return "applied" as const;
          }
          // The files stay as this machine has them, taking the later time when they match.
          const files = behind.files ? entry : current;
          const switchFrom = behind.switch || current === undefined ? entry : current;
          const switched: PluginFleetEntry = {
            pluginId,
            revision: files?.revision ?? null,
            ...(files?.version === undefined ? {} : { version: files.version }),
            filesAt: files?.filesAt ?? 0,
            enabled: switchFrom.enabled,
            enabledAt: switchFrom.enabledAt,
          };
          const wasEnabled = config.enabled?.[pluginId] === true;
          // A removed plugin keeps its switch only for when it comes back.
          const runs = plugin !== undefined && switched.revision !== null;
          const switches = runs && behind.switch;
          yield* host.writeConfig((latest) => {
            const next = withFleetEntry(latest, switched);
            return switches
              ? { ...next, enabled: { ...next.enabled, [pluginId]: switched.enabled } }
              : next;
          });
          if (switches && wasEnabled !== switched.enabled) return "switched" as const;
          yield* host.rescan;
          return "applied" as const;
        }),
      )
      .pipe(
        Effect.onError(() => (stopped ? host.restart(pluginId).pipe(Effect.ignore) : Effect.void)),
      );
    // Starts or stops it as plugins.json now says.
    if (outcome === "switched") yield* host.restart(pluginId);
    return { applied: outcome !== "unchanged" };
  });

  const exportFiles: PluginInstaller["Service"]["exportFiles"] = Effect.fn(
    "PluginInstaller.exportFiles",
  )(function* (pluginId) {
    const plugin = yield* host.pluginOf(pluginId);
    if (!("manifest" in plugin)) {
      return yield* new PluginInstallError({
        reason: `${pluginId} can't be copied: ${plugin.failure.message}`,
      });
    }
    return yield* readPluginFolder(plugin.rootDir).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError((error) => new PluginInstallError({ reason: error.reason })),
    );
  });

  const setKeptOff: PluginInstaller["Service"]["setKeptOff"] = Effect.fn(
    "PluginInstaller.setKeptOff",
  )(function* (pluginId, keptOff) {
    let stopped = false;
    yield* host
      .lifecycle(
        Effect.gen(function* () {
          const plugin = (yield* host.plugins).find((candidate) => candidate.id === pluginId);
          if (keptOff && plugin !== undefined && isDuplicate(plugin)) {
            return yield* new PluginInstallError({ reason: plugin.failure.message });
          }
          // Its entry goes too, so this machine neither carries the plugin nor its removal.
          yield* host.writeConfig((current) => {
            const others = (current.fleet?.keptOff ?? []).filter((id) => id !== pluginId);
            const { [pluginId]: _dropped, ...entries } = current.fleet?.entries ?? {};
            return {
              ...current,
              fleet: {
                ...current.fleet,
                ...(keptOff ? { entries } : {}),
                keptOff: keptOff ? [...others, pluginId] : others,
              },
            };
          });
          if (keptOff && plugin !== undefined) {
            yield* remove(plugin, () => {
              stopped = true;
            });
          } else {
            yield* host.rescan;
          }
        }),
      )
      .pipe(
        Effect.onError(() => (stopped ? host.restart(pluginId).pipe(Effect.ignore) : Effect.void)),
      );
  });

  const setSharing: PluginInstaller["Service"]["setSharing"] = (sharing) =>
    host.lifecycle(
      host
        .writeConfig((current) => ({ ...current, fleet: { ...current.fleet, sharing } }))
        .pipe(Effect.andThen(host.rescan)),
    );

  return {
    installer: PluginInstaller.of({
      installFiles,
      link,
      uninstall,
      applyFleet,
      exportFiles,
      setSharing,
      setKeptOff,
    }),
    recoverStaging,
  };
});
