// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off - Plugins run as plain Node, outside any Effect runtime.
const NodeCrypto = require("node:crypto");
const NodeFS = require("node:fs");
const NodePath = require("node:path");
const NodeSqlite = require("node:sqlite");
const NodeWorker = require("node:worker_threads");

/** @typedef {import("node:sqlite").DatabaseSync} Database */
/** @typedef {import("@t3tools/plugin-sdk/server").PluginStoredEvent} StoredEvent */
/** @typedef {{ readonly afterSequence: number; readonly throughSequence: number }} Gap */
/** @typedef {{ readonly id: string; readonly label: string }} Machine */
/** @typedef {{ readonly machine: Machine; readonly events: ReadonlyArray<StoredEvent>; readonly missed: ReadonlyArray<Gap> }} Upload */

// The hub refuses bigger request bodies. A spoke's upload stays far below it.
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_UPLOAD_EVENTS = 1000;
const MAX_UPLOAD_GAPS = 1000;
const UPLOAD_EVENTS = 300;
const UPLOAD_CHARS = 2 * 1024 * 1024;
const UPLOAD_GAPS = 100;
const MAX_MACHINE_TEXT = 200;

// A rowid table, not WITHOUT ROWID: payloads run to tens of KB, and SQLite advises against
// WITHOUT ROWID for rows that large. Inserts skip a repeated primary key with `ON CONFLICT DO
// NOTHING`, not `INSERT OR IGNORE`, which would also skip a row that breaks NOT NULL.
// `machines.event_count` counts each machine's rows in `events`, so counting never scans them.
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
-- Only the worker waits on another process's lock. The feed and the sender retry what still fails.
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS events (
  machine TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  aggregate TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  command_id TEXT,
  payload TEXT NOT NULL,
  metadata TEXT NOT NULL,
  PRIMARY KEY (machine, sequence)
);
CREATE INDEX IF NOT EXISTS events_by_stream ON events (stream_id, sequence);
CREATE TABLE IF NOT EXISTS machines (
  machine TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  cursor INTEGER NOT NULL,
  last_seen TEXT NOT NULL,
  event_count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS gaps (
  machine TEXT NOT NULL,
  after_sequence INTEGER NOT NULL,
  through_sequence INTEGER NOT NULL,
  noticed_at TEXT NOT NULL,
  PRIMARY KEY (machine, after_sequence, through_sequence)
) WITHOUT ROWID;
`;
const EVENT_COLUMNS =
  "machine, sequence, event_id, type, aggregate, stream_id, occurred_at, command_id, payload, metadata";

/**
 * Opens an archive, or a spoke's outbox, which has the same tables. Creates the file and its
 * folder when they are missing. The `machines` row of the machine that follows its own feed into
 * this file holds that feed's cursor.
 * @type {(file: string) => Database}
 */
const openDatabase = (file) => {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  const db = new NodeSqlite.DatabaseSync(file);
  try {
    db.exec(SCHEMA);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
};

/** Commits everything `work` writes together, or nothing if it throws. Joins an open transaction.
 * @type {<T>(db: Database, work: () => T) => T}
 */
const inTransaction = (db, work) => {
  if (db.isTransaction) return work();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
};

/** @type {(db: Database, machineId: string) => number} */
const readCursor = (db, machineId) => {
  const row = db.prepare("SELECT cursor FROM machines WHERE machine = ?").get(machineId);
  return row === undefined ? 0 : Number(row.cursor);
};

/**
 * Adds `machine`, or updates its label, raises its cursor to `cursor` and adds `added` to its
 * event count. The cursor never falls.
 * @type {(db: Database, machine: Machine, cursor: number, added: number) => void}
 */
const saveMachine = (db, machine, cursor, added) => {
  db.prepare(
    `INSERT INTO main.machines (machine, label, cursor, last_seen, event_count) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (machine) DO UPDATE SET
       label = excluded.label, cursor = max(cursor, excluded.cursor),
       last_seen = excluded.last_seen, event_count = event_count + excluded.event_count`,
  ).run(machine.id, machine.label, cursor, new Date().toISOString(), added);
};

/**
 * Stores an upload in one transaction and returns how many of its events were new. The machine's
 * cursor rises to `cursor` in the same commit and never falls.
 * @type {(db: Database, upload: Upload, cursor?: number) => number}
 */
const storeUpload = (db, upload, cursor = 0) =>
  inTransaction(db, () => {
    const machine = upload.machine.id;
    const insertEvent = db.prepare(
      `INSERT INTO events (${EVENT_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    );
    let stored = 0;
    for (const event of upload.events) {
      const { changes } = insertEvent.run(
        machine,
        event.sequence,
        event.id,
        event.type,
        event.aggregate,
        event.streamId,
        event.occurredAt,
        event.commandId,
        event.payloadJson,
        event.metadataJson,
      );
      stored += Number(changes);
    }
    const now = new Date().toISOString();
    const insertGap = db.prepare(
      `INSERT INTO gaps (machine, after_sequence, through_sequence, noticed_at)
       VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    );
    for (const gap of upload.missed) {
      insertGap.run(machine, gap.afterSequence, gap.throughSequence, now);
    }
    saveMachine(db, upload.machine, cursor, stored);
    return stored;
  });

/**
 * Stores one batch from `api.events.stored` with the feed's own position to resume after, so a
 * restart never skips events still stored inside a reported gap.
 * @type {(db: Database, machine: Machine, batch: import("@t3tools/plugin-sdk/server").PluginStoredEventBatch) => number}
 */
const storeFeedBatch = (db, machine, batch) =>
  inTransaction(db, () => {
    const missed = batch.missed === undefined ? [] : [batch.missed];
    return storeUpload(db, { machine, events: batch.events, missed }, batch.resumeAfter);
  });

/**
 * Moves the outbox at `outboxFile` into `db` in one transaction, then deletes the outbox. Returns
 * how many of its events were new to `db`, or `undefined` when there is no outbox. Running it
 * again after a crash between the commit and the delete stores nothing twice.
 * @type {(db: Database, outboxFile: string) => number | undefined}
 */
const mergeOutbox = (db, outboxFile) => {
  if (!NodeFS.existsSync(outboxFile)) return undefined;
  db.prepare("ATTACH DATABASE ? AS outbox").run(outboxFile);
  let moved = 0;
  try {
    inTransaction(db, () => {
      const copyEvents = db.prepare(
        `INSERT INTO main.events (${EVENT_COLUMNS})
         SELECT ${EVENT_COLUMNS} FROM outbox.events WHERE machine = ? ON CONFLICT DO NOTHING`,
      );
      for (const row of db.prepare("SELECT machine, label, cursor FROM outbox.machines").all()) {
        const added = Number(copyEvents.run(String(row.machine)).changes);
        const machine = { id: String(row.machine), label: String(row.label) };
        saveMachine(db, machine, Number(row.cursor), added);
        moved += added;
      }
      db.exec(
        `INSERT INTO main.gaps SELECT machine, after_sequence, through_sequence, noticed_at
         FROM outbox.gaps WHERE true ON CONFLICT DO NOTHING`,
      );
    });
  } finally {
    db.exec("DETACH DATABASE outbox");
  }
  for (const suffix of ["", "-wal", "-shm"])
    NodeFS.rmSync(`${outboxFile}${suffix}`, { force: true });
  return moved;
};

/** @type {(row: Record<string, import("node:sqlite").SQLOutputValue>) => StoredEvent} */
const toEvent = (row) => ({
  sequence: Number(row.sequence),
  id: String(row.event_id),
  type: String(row.type),
  aggregate: String(row.aggregate),
  streamId: String(row.stream_id),
  occurredAt: String(row.occurred_at),
  commandId: row.command_id === null ? null : String(row.command_id),
  payloadJson: String(row.payload),
  metadataJson: String(row.metadata),
});

/** The oldest outbox rows that fit one upload: at most 300 events and about 2 MB of JSON.
 * @type {(db: Database, machine: Machine) => Upload}
 */
const readOutbox = (db, machine) => {
  /** @type {Array<StoredEvent>} */
  const events = [];
  let chars = 0;
  const rows = db
    .prepare(
      `SELECT sequence, event_id, type, aggregate, stream_id, occurred_at, command_id, payload, metadata
       FROM events WHERE machine = ? ORDER BY sequence LIMIT ?`,
    )
    .iterate(machine.id, UPLOAD_EVENTS);
  for (const row of rows) {
    const event = toEvent(row);
    chars += event.payloadJson.length + event.metadataJson.length + event.id.length + 300;
    if (events.length > 0 && chars > UPLOAD_CHARS) break;
    events.push(event);
  }
  const missed = db
    .prepare(
      `SELECT after_sequence, through_sequence FROM gaps WHERE machine = ?
       ORDER BY after_sequence LIMIT ?`,
    )
    .all(machine.id, UPLOAD_GAPS)
    .map((row) => ({
      afterSequence: Number(row.after_sequence),
      throughSequence: Number(row.through_sequence),
    }));
  return { machine, events, missed };
};

/** Deletes exactly the sent outbox rows, so rows added while they were in flight stay.
 * @type {(db: Database, machineId: string, sequences: ReadonlyArray<number>, missed: ReadonlyArray<Gap>) => void}
 */
const deleteSent = (db, machineId, sequences, missed) =>
  inTransaction(db, () => {
    const deleteEvent = db.prepare("DELETE FROM events WHERE machine = ? AND sequence = ?");
    let deleted = 0;
    for (const sequence of sequences)
      deleted += Number(deleteEvent.run(machineId, sequence).changes);
    db.prepare("UPDATE machines SET event_count = event_count - ? WHERE machine = ?").run(
      deleted,
      machineId,
    );
    const deleteGap = db.prepare(
      "DELETE FROM gaps WHERE machine = ? AND after_sequence = ? AND through_sequence = ?",
    );
    for (const gap of missed) deleteGap.run(machineId, gap.afterSequence, gap.throughSequence);
  });

/**
 * The oldest outbox rows as one upload's JSON body, or `undefined` when the outbox is empty. An
 * event too big for the hub to ever take would block the outbox for good, so it becomes a gap
 * instead and `dropped` names it.
 * @type {(db: Database, machine: Machine) => { body: string; sequences: Array<number>; missed: ReadonlyArray<Gap> } | { dropped: number } | undefined}
 */
const nextUpload = (db, machine) => {
  const upload = readOutbox(db, machine);
  const [first] = upload.events;
  if (first === undefined && upload.missed.length === 0) return undefined;
  const body = JSON.stringify(upload);
  if (
    first !== undefined &&
    upload.events.length === 1 &&
    Buffer.byteLength(body) > MAX_BODY_BYTES
  ) {
    inTransaction(db, () => {
      deleteSent(db, machine.id, [first.sequence], []);
      const gap = { afterSequence: first.sequence - 1, throughSequence: first.sequence };
      storeUpload(db, { machine, events: [], missed: [gap] });
    });
    return { dropped: first.sequence };
  }
  return { body, sequences: upload.events.map((event) => event.sequence), missed: upload.missed };
};

/** @type {(db: Database) => number} */
const countEvents = (db) =>
  Number(db.prepare("SELECT coalesce(sum(event_count), 0) AS count FROM machines").get()?.count);

/** @type {(db: Database) => Array<{ label: string; cursor: number; lastSeen: string; events: number }>} */
const listMachines = (db) =>
  db
    .prepare("SELECT label, cursor, last_seen, event_count FROM machines ORDER BY label")
    .all()
    .map((row) => ({
      label: String(row.label),
      cursor: Number(row.cursor),
      lastSeen: String(row.last_seen),
      events: Number(row.event_count),
    }));

/** @type {(db: Database) => void} */
const closeDatabase = (db) => db.close();

/** What the database worker answers, each run against the database it opened. */
const queries = {
  readCursor,
  storeUpload,
  storeFeedBatch,
  mergeOutbox,
  nextUpload,
  deleteSent,
  countEvents,
  listMachines,
  close: closeDatabase,
};

/** @typedef {typeof queries} Queries */
/** @typedef {keyof Queries} QueryName */
/** @typedef {{ [Name in QueryName]: Parameters<Queries[Name]> extends [Database, ...infer Args] ? Args : never }} QueryArgs */
/** @typedef {{ [Name in QueryName]: ReturnType<Queries[Name]> }} QueryResults */
/** @typedef {{ readonly id: number; readonly name: QueryName; readonly args: QueryArgs[QueryName] }} WorkerRequest */
/** @typedef {{ readonly id: number; readonly value: unknown } | { readonly id: number; readonly error: string }} WorkerReply */

/** @type {{ readonly [Name in QueryName]: (db: Database, ...args: QueryArgs[Name]) => QueryResults[Name] }} */
const typedQueries = queries;

/** @type {<Name extends QueryName>(db: Database, name: Name, args: QueryArgs[Name]) => QueryResults[Name]} */
const runQuery = (db, name, args) => typedQueries[name](db, ...args);

/**
 * Runs `queries` on the database at `file` in a Worker, so SQLite never blocks the server's event
 * loop. Calls run in order. The worker starts on the first call and again on the first call after
 * it stopped. When it stops, its unanswered calls fail and `onStop` gets why.
 * @type {(file: string, onStop: (error: Error) => void) => { readonly run: <Name extends QueryName>(name: Name, ...args: QueryArgs[Name]) => Promise<QueryResults[Name]>; readonly close: () => Promise<void> }}
 */
const openDatabaseWorker = (file, onStop) => {
  /** @type {import("node:worker_threads").Worker | undefined} */
  let worker;
  let closed = false;
  let nextId = 0;
  /** @type {Map<number, { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }>} */
  const calls = new Map();
  /** @type {(stopped: import("node:worker_threads").Worker, error: Error) => void} */
  const onStopped = (stopped, error) => {
    if (worker !== stopped) return;
    worker = undefined;
    for (const call of calls.values()) call.reject(error);
    calls.clear();
    onStop(error);
  };
  const start = () => {
    const started = new NodeWorker.Worker(NodePath.join(__dirname, "database-worker.cjs"), {
      workerData: file,
    });
    started.unref();
    started.on("message", (/** @type {WorkerReply} */ reply) => {
      const call = calls.get(reply.id);
      calls.delete(reply.id);
      if ("error" in reply) call?.reject(new Error(reply.error));
      else call?.resolve(reply.value);
    });
    started.on("error", (/** @type {unknown} */ error) =>
      onStopped(started, error instanceof Error ? error : new Error(String(error))),
    );
    started.on("exit", (code) =>
      onStopped(started, new Error(`The database worker exited with code ${code}.`)),
    );
    return started;
  };
  /** @type {<Name extends QueryName>(name: Name, ...args: QueryArgs[Name]) => Promise<QueryResults[Name]>} */
  const run = (name, ...args) =>
    new Promise((resolve, reject) => {
      if (closed) throw new Error("The archive database is closed.");
      worker ??= start();
      const id = nextId++;
      /** @type {WorkerRequest} */
      const request = { id, name, args };
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
      worker.postMessage(request);
      // The one place a value crosses back from the worker; `queries` decides its type.
      calls.set(id, { resolve: /** @type {(value: unknown) => void} */ (resolve), reject });
    });
  return {
    run,
    // Waits for the calls already sent, then stops the worker.
    close: async () => {
      if (closed) return;
      if (worker !== undefined) await run("close").catch(() => {});
      closed = true;
      const stopping = worker;
      worker = undefined;
      await stopping?.terminate();
    },
  };
};

/** @typedef {ReturnType<typeof openDatabaseWorker>} DatabaseWorker */

/**
 * Sends the oldest outbox rows to the hub and deletes them once it answers 2xx. Throws when the
 * send fails, and the rows stay. `sent` is 0 when the outbox is empty, and `dropped` names an
 * event too big for the hub that became a gap.
 * @type {(options: { db: DatabaseWorker; machine: Machine; hubUrl: string; key: string; signal: AbortSignal }) => Promise<{ sent: number; dropped?: number }>}
 */
const sendOutbox = async ({ db, machine, hubUrl, key, signal }) => {
  const upload = await db.run("nextUpload", machine);
  if (upload === undefined) return { sent: 0 };
  if ("dropped" in upload) return { sent: 0, dropped: upload.dropped };
  const response = await fetch(new URL("/events", hubUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: upload.body,
    signal,
  });
  const answer = await response.text();
  if (!response.ok) throw new Error(`The hub answered ${response.status}: ${answer.slice(0, 300)}`);
  await db.run("deleteSent", machine.id, upload.sequences, upload.missed);
  return { sent: upload.sequences.length + upload.missed.length };
};

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** @type {(value: unknown) => value is ReadonlyArray<unknown>} */
const isList = (value) => Array.isArray(value);
/**
 * @param {unknown} value
 * @returns {value is number}
 */
const isWhole = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** @type {(value: unknown) => StoredEvent | undefined} */
const parseEvent = (value) => {
  if (!isRecord(value)) return undefined;
  const { sequence, id, type, aggregate, streamId, occurredAt, commandId } = value;
  const { payloadJson, metadataJson } = value;
  if (
    !isWhole(sequence) ||
    typeof id !== "string" ||
    typeof type !== "string" ||
    typeof aggregate !== "string" ||
    typeof streamId !== "string" ||
    typeof occurredAt !== "string" ||
    (commandId !== null && typeof commandId !== "string") ||
    typeof payloadJson !== "string" ||
    typeof metadataJson !== "string"
  ) {
    return undefined;
  }
  return {
    sequence,
    id,
    type,
    aggregate,
    streamId,
    occurredAt,
    commandId,
    payloadJson,
    metadataJson,
  };
};

/** @type {(value: unknown) => Gap | undefined} */
const parseGap = (value) => {
  if (!isRecord(value)) return undefined;
  const { afterSequence, throughSequence } = value;
  if (!isWhole(afterSequence) || !isWhole(throughSequence) || throughSequence < afterSequence) {
    return undefined;
  }
  return { afterSequence, throughSequence };
};

/** Checks a request body field by field. Returns the upload, or why it was refused.
 * @type {(value: unknown) => Upload | string}
 */
const parseUpload = (value) => {
  if (!isRecord(value) || !isRecord(value.machine)) return "The body needs a machine object.";
  const { id, label } = value.machine;
  if (typeof id !== "string" || id === "" || id.length > MAX_MACHINE_TEXT) {
    return "machine.id must be a non-empty string.";
  }
  if (typeof label !== "string" || label.length > MAX_MACHINE_TEXT) {
    return "machine.label must be a string.";
  }
  if (!isList(value.events) || value.events.length > MAX_UPLOAD_EVENTS) {
    return `events must be a list of at most ${MAX_UPLOAD_EVENTS} events.`;
  }
  if (!isList(value.missed) || value.missed.length > MAX_UPLOAD_GAPS) {
    return `missed must be a list of at most ${MAX_UPLOAD_GAPS} ranges.`;
  }
  /** @type {Array<StoredEvent>} */
  const events = [];
  for (const item of value.events) {
    const event = parseEvent(item);
    if (event === undefined) return `events[${events.length}] is malformed.`;
    events.push(event);
  }
  /** @type {Array<Gap>} */
  const missed = [];
  for (const item of value.missed) {
    const gap = parseGap(item);
    if (gap === undefined) return `missed[${missed.length}] is malformed.`;
    missed.push(gap);
  }
  return { machine: { id, label }, events, missed };
};

/** @type {(text: string) => Buffer} */
const sha256 = (text) => NodeCrypto.createHash("sha256").update(text).digest();

/**
 * Answers spokes on the hub. Only `POST /events` with `Authorization: Bearer <key>` and a valid
 * body stores anything, in one transaction. Uploads that claim `hubMachineId` are refused, so a
 * spoke can never move the cursor of the hub's own feed.
 * @type {(options: { db: DatabaseWorker; key: string; hubMachineId: string; onError: (error: unknown) => void }) => import("node:http").RequestListener}
 */
const createIngestHandler = ({ db, key, hubMachineId, onError }) => {
  const expectedKey = sha256(key);
  return (request, response) => {
    request.on("error", () => {});
    response.on("error", () => {});
    /** @type {(status: number, body: object) => void} */
    const reply = (status, body) => {
      if (response.headersSent) return;
      response.writeHead(status, {
        "content-type": "application/json",
        ...(status === 200 ? {} : { connection: "close" }),
      });
      response.end(JSON.stringify(body));
    };
    if (request.method !== "POST" || request.url?.split("?")[0] !== "/events") {
      reply(404, { error: "Only POST /events is served here." });
      return;
    }
    const header = request.headers.authorization ?? "";
    const givenKey = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!NodeCrypto.timingSafeEqual(sha256(givenKey), expectedKey)) {
      reply(401, { error: "The key is wrong." });
      return;
    }
    const tooLarge = { error: `The body is over ${MAX_BODY_BYTES} bytes.` };
    if (Number(request.headers["content-length"] ?? 0) > MAX_BODY_BYTES) {
      reply(413, tooLarge);
      return;
    }
    /** @type {Array<Buffer>} */
    const chunks = [];
    let size = 0;
    request.on(
      "data",
      /** @param {Buffer} chunk */ (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          chunks.length = 0;
          reply(413, tooLarge);
        } else if (!response.headersSent) {
          chunks.push(chunk);
        }
      },
    );
    request.on("end", () => {
      if (response.headersSent) return;
      /** @type {unknown} */
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        reply(400, { error: "The body is not JSON." });
        return;
      }
      const upload = parseUpload(body);
      if (typeof upload === "string") {
        reply(400, { error: upload });
        return;
      }
      if (upload.machine.id === hubMachineId) {
        reply(400, { error: "machine.id is the hub's own environment." });
        return;
      }
      const highest = Math.max(0, ...upload.events.map((event) => event.sequence));
      db.run("storeUpload", upload, highest).then(
        (stored) => reply(200, { stored }),
        (error) => {
          reply(500, { error: "The hub could not store the events." });
          onError(error);
        },
      );
    });
  };
};

module.exports = {
  openDatabase,
  readCursor,
  storeUpload,
  storeFeedBatch,
  mergeOutbox,
  countEvents,
  listMachines,
  runQuery,
  openDatabaseWorker,
  sendOutbox,
  createIngestHandler,
};
