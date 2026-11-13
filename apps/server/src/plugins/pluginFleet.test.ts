import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { PluginId } from "@t3tools/contracts";
import { describe } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import { recordLocalChanges, type FoundPlugin } from "./pluginFleet.ts";
import * as PluginHost from "./PluginHost.ts";
import {
  fixturesDir,
  fleetEntries,
  layerConfig,
  layerHost,
  listStates,
  stateOf,
  waitForStatuses,
  writeFile,
} from "./pluginHostTestHarness.ts";
import * as PluginInstaller from "./PluginInstaller.ts";

const notes = PluginId.make("notes");
const found = (overrides: Partial<FoundPlugin> = {}): FoundPlugin => ({
  pluginId: notes,
  version: "1.0.0",
  revision: "a".repeat(64),
  modifiedAt: 500,
  ...overrides,
});
const record = (input: Partial<Parameters<typeof recordLocalChanges>[0]>) =>
  recordLocalChanges({
    config: {},
    found: [],
    present: new Set(),
    complete: true,
    now: 1_000,
    ...input,
  });

describe("recordLocalChanges", () => {
  it("records a new folder, with off as a default any decision beats", () => {
    assert.deepStrictEqual(record({ found: [found()], present: new Set([notes]) })?.fleet, {
      entries: {
        notes: {
          revision: "a".repeat(64),
          version: "1.0.0",
          filesAt: 500,
          enabled: false,
          enabledAt: 0,
        },
      },
    });
    const on = record({
      config: { enabled: { notes: true } },
      found: [found()],
      present: new Set([notes]),
    });
    assert.include(on?.fleet?.entries?.notes, { enabled: true, enabledAt: 500 });
  });

  it("dates a change made here after the entry it replaces, and keeps the switch", () => {
    const config = {
      fleet: {
        entries: {
          notes: { revision: "a".repeat(64), filesAt: 900, enabled: true, enabledAt: 900 },
        },
      },
    };
    const changed = record({
      config,
      found: [found({ revision: "b".repeat(64), version: "1.1.0" })],
      present: new Set([notes]),
    });
    assert.deepStrictEqual(changed?.fleet?.entries?.notes, {
      revision: "b".repeat(64),
      version: "1.1.0",
      filesAt: 901,
      enabled: true,
      enabledAt: 900,
    });
    assert.isUndefined(record({ config, found: [found()], present: new Set([notes]) }));
  });

  it("records a removal only after a discovery that read every folder", () => {
    const config = {
      fleet: {
        entries: {
          notes: { revision: "a".repeat(64), filesAt: 900, enabled: true, enabledAt: 900 },
        },
      },
    };
    assert.deepStrictEqual(record({ config })?.fleet?.entries?.notes, {
      revision: null,
      filesAt: 1_000,
      enabled: false,
      enabledAt: 1_000,
    });
    assert.isUndefined(record({ config, complete: false }));
    // Listed but failed, such as two folders with its id: not removed.
    assert.isUndefined(record({ config, present: new Set([notes]) }));
  });
});

const hello = PluginId.make("hello-plugin");

/** The hello fixture copied into the plugins folder by hand, turned off. */
const installHello = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  for (const file of ["t3-plugin.json", "server.cjs"]) {
    yield* writeFile(
      `${stateDir}/plugins/hello-plugin/${file}`,
      yield* fs.readFileString(`${fixturesDir}hello-plugin/${file}`),
    );
  }
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("plugin sharing", (it) => {
  it.effect("applies a switch and a removal from another machine, only when newer", () =>
    Effect.gen(function* () {
      yield* installHello;
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const installer = yield* PluginInstaller.PluginInstaller;
        yield* waitForStatuses(host, { "hello-plugin": "disabled" });
        const shared = (yield* fleetEntries(host)).get(hello);
        assert.isDefined(shared);
        if (shared === undefined) return;

        const turnedOn = { ...shared, enabled: true, enabledAt: shared.filesAt + 10 };
        assert.isTrue((yield* installer.applyFleet(turnedOn)).applied);
        yield* waitForStatuses(host, { "hello-plugin": "active" });
        assert.isFalse((yield* installer.applyFleet(turnedOn)).applied);
        const olderOff = { ...shared, enabled: false, enabledAt: shared.filesAt + 5 };
        assert.isFalse((yield* installer.applyFleet(olderOff)).applied);
        assert.strictEqual(stateOf(yield* listStates(host), "hello-plugin")?.status, "active");

        const removed = {
          pluginId: hello,
          revision: null,
          filesAt: shared.filesAt + 20,
          enabled: false,
          enabledAt: shared.filesAt + 20,
        };
        assert.isTrue((yield* installer.applyFleet(removed)).applied);
        assert.isUndefined(stateOf(yield* listStates(host), "hello-plugin"));
        assert.deepStrictEqual((yield* fleetEntries(host)).get(hello), removed);
        // Newer files never come without them.
        const reinstalled = { ...shared, filesAt: shared.filesAt + 30 };
        const refused = yield* installer.applyFleet(reinstalled).pipe(Effect.flip);
        assert.strictEqual(refused._tag, "PluginInstallError");
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("records the switch the user flips here as newer than the one it had", () =>
    Effect.gen(function* () {
      yield* installHello;
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        yield* waitForStatuses(host, { "hello-plugin": "disabled" });
        const before = Option.fromNullishOr((yield* fleetEntries(host)).get(hello));
        assert.isTrue(Option.isSome(before));
        yield* host.setEnabled(hello, true);
        const after = (yield* fleetEntries(host)).get(hello);
        assert.include(after, { enabled: true });
        assert.isAbove(after?.enabledAt ?? 0, Option.getOrThrow(before).enabledAt);
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );
});
