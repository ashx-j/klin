// @effect-diagnostics nodeBuiltinImport:off globalFetch:off
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import * as Archive from "./archive.cjs";
import plugin from "./server.cjs";

const KEY = "a-shared-key-of-24-chars";
const laptop = { id: "env-laptop", label: "laptop" };

const event = (sequence: number) => ({
  sequence,
  id: `event-${sequence}`,
  type: "turn-item.updated",
  aggregate: "thread",
  streamId: "thread-1",
  occurredAt: "2026-11-13T10:00:00.000Z",
  commandId: null,
  payloadJson: `{"text":"reply ${sequence}"}`,
  metadataJson: "{}",
});

const tempDir = () => {
  const path = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "session-archive-"));
  return { path, [Symbol.dispose]: () => NodeFS.rmSync(path, { recursive: true, force: true }) };
};

const openWorker = (file: string) => {
  const db = Archive.openDatabaseWorker(file, (error) => {
    throw error;
  });
  return { ...db, [Symbol.asyncDispose]: db.close };
};

const serveIngest = async (db: ReturnType<typeof Archive.openDatabaseWorker>) => {
  const handler = Archive.createIngestHandler({
    db,
    key: KEY,
    hubMachineId: "env-hub",
    onError: (error) => {
      throw error;
    },
  });
  const server = NodeHttp.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No port.");
  return {
    url: `http://127.0.0.1:${address.port}`,
    [Symbol.asyncDispose]: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
};

const gapsIn = (db: ReturnType<typeof Archive.openDatabase>) =>
  db.prepare("SELECT machine, after_sequence, through_sequence FROM gaps").all();

describe("session archive", () => {
  it("stores each event once when the same batch is replayed", () => {
    using dir = tempDir();
    using db = Archive.openDatabase(NodePath.join(dir.path, "archive.sqlite"));
    const batch = { events: [event(1), event(2)] };

    expect(Archive.storeFeedBatch(db, laptop, batch)).toBe(2);
    expect(Archive.storeFeedBatch(db, laptop, batch)).toBe(0);
    expect(Archive.countEvents(db)).toBe(2);
  });

  it("commits the cursor together with its rows", () => {
    using dir = tempDir();
    using db = Archive.openDatabase(NodePath.join(dir.path, "archive.sqlite"));
    Archive.storeFeedBatch(db, laptop, { events: [event(1), event(2)] });
    expect(Archive.readCursor(db, laptop.id)).toBe(2);

    const broken = { events: [event(3), { ...event(4), payloadJson: null }] };
    // @ts-expect-error The NOT NULL column refuses the null payload, which fails the whole batch.
    expect(() => Archive.storeFeedBatch(db, laptop, broken)).toThrow("NOT NULL");
    expect(Archive.readCursor(db, laptop.id)).toBe(2);
    expect(Archive.countEvents(db)).toBe(2);

    const onlyMissed = { events: [], missed: { afterSequence: 2, throughSequence: 9 } };
    Archive.storeFeedBatch(db, laptop, onlyMissed);
    expect(Archive.readCursor(db, laptop.id)).toBe(9);
    expect(gapsIn(db)).toEqual([{ machine: laptop.id, after_sequence: 2, through_sequence: 9 }]);
  });

  it("stores an upload only with the right key and a well-formed body", async () => {
    using dir = tempDir();
    await using db = openWorker(NodePath.join(dir.path, "archive.sqlite"));
    await using hub = await serveIngest(db);
    const post = async (body: string, key = KEY) => {
      const response = await fetch(`${hub.url}/events`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
        body,
      });
      return { status: response.status, body: await response.json() };
    };
    const upload = { machine: laptop, events: [event(1), event(2)], missed: [] };

    expect((await post(JSON.stringify(upload), "not-the-shared-key-at-all")).status).toBe(401);
    expect((await post("{")).status).toBe(400);
    const stringSequence = { ...upload, events: [{ ...event(1), sequence: "1" }] };
    expect((await post(JSON.stringify(stringSequence))).status).toBe(400);
    const asHub = { ...upload, machine: { id: "env-hub", label: "hub" } };
    expect((await post(JSON.stringify(asHub))).status).toBe(400);
    expect(await db.run("countEvents")).toBe(0);

    expect(await post(JSON.stringify(upload))).toEqual({ status: 200, body: { stored: 2 } });
    expect(await post(JSON.stringify(upload))).toEqual({ status: 200, body: { stored: 0 } });
    expect(await db.run("listMachines")).toEqual([
      { label: "laptop", cursor: 2, lastSeen: expect.any(String), events: 2 },
    ]);
  });

  it("deletes outbox rows only after the hub stored them", async () => {
    using dir = tempDir();
    const archiveFile = NodePath.join(dir.path, "archive.sqlite");
    await using archive = openWorker(archiveFile);
    await using outbox = openWorker(NodePath.join(dir.path, "outbox", "outbox.sqlite"));
    await using hub = await serveIngest(archive);
    await outbox.run("storeFeedBatch", laptop, { events: [event(1), event(2)] });
    await outbox.run("storeFeedBatch", laptop, {
      events: [event(5)],
      missed: { afterSequence: 2, throughSequence: 4 },
    });
    const send = (key: string) =>
      Archive.sendOutbox({
        db: outbox,
        machine: laptop,
        hubUrl: hub.url,
        key,
        signal: new AbortController().signal,
      });

    await expect(send("not-the-shared-key-at-all")).rejects.toThrow("401");
    expect(await outbox.run("countEvents")).toBe(3);
    expect(await archive.run("countEvents")).toBe(0);

    expect(await send(KEY)).toEqual({ sent: 4 });
    expect(await outbox.run("countEvents")).toBe(0);
    expect(await outbox.run("readCursor", laptop.id)).toBe(5);
    expect(await archive.run("countEvents")).toBe(3);
    expect(await send(KEY)).toEqual({ sent: 0 });
    using reader = Archive.openDatabase(archiveFile);
    expect(gapsIn(reader)).toEqual([
      { machine: laptop.id, after_sequence: 2, through_sequence: 4 },
    ]);
  });

  it("moves a spoke's outbox into the archive when the spoke becomes the hub", () => {
    using dir = tempDir();
    const outboxFile = NodePath.join(dir.path, "outbox.sqlite");
    {
      using outbox = Archive.openDatabase(outboxFile);
      Archive.storeFeedBatch(outbox, laptop, { events: [event(1), event(2)] });
      Archive.storeFeedBatch(outbox, laptop, {
        events: [event(5)],
        missed: { afterSequence: 2, throughSequence: 4 },
      });
    }
    using archive = Archive.openDatabase(NodePath.join(dir.path, "archive.sqlite"));
    Archive.storeUpload(archive, { machine: laptop, events: [event(1)], missed: [] }, 1);

    expect(Archive.mergeOutbox(archive, outboxFile)).toBe(2);
    expect(Archive.countEvents(archive)).toBe(3);
    expect(Archive.readCursor(archive, laptop.id)).toBe(5);
    expect(gapsIn(archive)).toEqual([
      { machine: laptop.id, after_sequence: 2, through_sequence: 4 },
    ]);
    expect(NodeFS.readdirSync(dir.path).filter((name) => name.startsWith("outbox"))).toEqual([]);
    expect(Archive.mergeOutbox(archive, outboxFile)).toBeUndefined();
  });

  it("keeps a machine's events in its outbox before it is set up", async () => {
    using dir = tempDir();
    let fed = () => {};
    const feedRead = new Promise<void>((resolve) => (fed = resolve));
    const cleanups: Array<() => void | Promise<void>> = [];
    const ignore = () => {};
    await plugin.activate({
      version: 2,
      id: "session-archive",
      rootDir: import.meta.dirname,
      environmentId: laptop.id,
      dataDir: dir.path,
      log: { debug: ignore, info: ignore, warn: ignore, error: ignore },
      settings: { get: async () => ({}), changes: async function* () {} },
      storage: {
        get: async () => undefined,
        set: async () => {},
        delete: async () => {},
        list: async () => [],
      },
      rpc: { register: ignore, publish: ignore },
      onDeactivate: (cleanup) => cleanups.push(cleanup),
      mcp: { registerTool: ignore },
      events: {
        stored: async function* (options) {
          expect(options?.afterSequence).toBe(0);
          yield { events: [event(1), event(2)] };
          fed();
          await new Promise((resolve) => options?.signal?.addEventListener("abort", resolve));
        },
      },
    });
    await feedRead;
    for (const cleanup of cleanups) await cleanup();

    using outbox = Archive.openDatabase(NodePath.join(dir.path, "outbox.sqlite"));
    expect(Archive.countEvents(outbox)).toBe(2);
    expect(Archive.readCursor(outbox, laptop.id)).toBe(2);
  });
});
