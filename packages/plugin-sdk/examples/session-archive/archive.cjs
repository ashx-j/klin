// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off - Plugins run as plain Node, outside any Effect runtime.
const NodeCrypto = require("node:crypto");
const NodeFS = require("node:fs");
const NodePath = require("node:path");
const NodeSqlite = require("node:sqlite");

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
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 1000;
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
  last_seen TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gaps (
  machine TEXT NOT NULL,
  after_sequence INTEGER NOT NULL,
  through_sequence INTEGER NOT NULL,
  noticed_at TEXT NOT NULL,
  PRIMARY KEY (machine, after_sequence, through_sequence)
) WITHOUT ROWID;
`;

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
 * Stores an upload in one transaction and returns how many of its events were new. The machine's
 * cursor rises to `cursor` in the same commit and never falls.
 * @type {(db: Database, upload: Upload, cursor?: number) => number}
 */
const storeUpload = (db, upload, cursor = 0) =>
  inTransaction(db, () => {
    const machine = upload.machine.id;
    const insertEvent = db.prepare(
      `INSERT INTO events
         (machine, sequence, event_id, type, aggregate, stream_id, occurred_at, command_id, payload, metadata)
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
    db.prepare(
      `INSERT INTO machines (machine, label, cursor, last_seen) VALUES (?, ?, ?, ?)
       ON CONFLICT (machine) DO UPDATE SET
         label = excluded.label, cursor = max(cursor, excluded.cursor), last_seen = excluded.last_seen`,
    ).run(machine, upload.machine.label, cursor, now);
    return stored;
  });

/**
 * Stores one batch from `api.events.stored` with the cursor to resume after. A batch that is only
 * `missed` means nothing is stored after the cursor, so the cursor moves past the gap. Otherwise
 * it stops at the last event, since kept events inside a reported gap can fill more batches.
 * @type {(db: Database, machine: Machine, batch: import("@t3tools/plugin-sdk/server").PluginStoredEventBatch) => number}
 */
const storeFeedBatch = (db, machine, batch) =>
  inTransaction(db, () => {
    const cursor =
      batch.events.at(-1)?.sequence ??
      Math.max(readCursor(db, machine.id), batch.missed?.throughSequence ?? 0);
    const missed = batch.missed === undefined ? [] : [batch.missed];
    return storeUpload(db, { machine, events: batch.events, missed }, cursor);
  });

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

/** Deletes exactly the outbox rows in `upload`, so rows added while it was in flight stay.
 * @type {(db: Database, upload: Upload) => void}
 */
const deleteUploaded = (db, upload) =>
  inTransaction(db, () => {
    const machine = upload.machine.id;
    const deleteEvent = db.prepare("DELETE FROM events WHERE machine = ? AND sequence = ?");
    for (const event of upload.events) deleteEvent.run(machine, event.sequence);
    const deleteGap = db.prepare(
      "DELETE FROM gaps WHERE machine = ? AND after_sequence = ? AND through_sequence = ?",
    );
    for (const gap of upload.missed) {
      deleteGap.run(machine, gap.afterSequence, gap.throughSequence);
    }
  });

/**
 * Sends the oldest outbox rows to the hub and deletes them once it answers 2xx. Throws when the
 * send fails, and the rows stay. `sent` is 0 when the outbox is empty. An event too big for the
 * hub to ever take would block the outbox for good, so it becomes a gap and `dropped` names it.
 * @type {(options: { db: Database; machine: Machine; hubUrl: string; key: string; signal: AbortSignal }) => Promise<{ sent: number; dropped?: number }>}
 */
const sendOutbox = async ({ db, machine, hubUrl, key, signal }) => {
  const upload = readOutbox(db, machine);
  const [first] = upload.events;
  if (first === undefined && upload.missed.length === 0) return { sent: 0 };
  const body = JSON.stringify(upload);
  if (
    first !== undefined &&
    upload.events.length === 1 &&
    Buffer.byteLength(body) > MAX_BODY_BYTES
  ) {
    inTransaction(db, () => {
      deleteUploaded(db, { machine, events: [first], missed: [] });
      const gap = { afterSequence: first.sequence - 1, throughSequence: first.sequence };
      storeUpload(db, { machine, events: [], missed: [gap] });
    });
    return { sent: 0, dropped: first.sequence };
  }
  const response = await fetch(new URL("/events", hubUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body,
    signal,
  });
  const answer = await response.text();
  if (!response.ok) throw new Error(`The hub answered ${response.status}: ${answer.slice(0, 300)}`);
  deleteUploaded(db, upload);
  return { sent: upload.events.length + upload.missed.length };
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
 * @type {(options: { db: Database; key: string; hubMachineId: string; onError: (error: unknown) => void }) => import("node:http").RequestListener}
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
      try {
        const highest = Math.max(0, ...upload.events.map((event) => event.sequence));
        reply(200, { stored: storeUpload(db, upload, highest) });
      } catch (error) {
        onError(error);
        reply(500, { error: "The hub could not store the events." });
      }
    });
  };
};

/** @type {(db: Database) => number} */
const countEvents = (db) => Number(db.prepare("SELECT count(*) AS count FROM events").get()?.count);

/** @type {(db: Database) => Array<{ label: string; cursor: number; lastSeen: string }>} */
const listMachines = (db) =>
  db
    .prepare("SELECT label, cursor, last_seen FROM machines ORDER BY label")
    .all()
    .map((row) => ({
      label: String(row.label),
      cursor: Number(row.cursor),
      lastSeen: String(row.last_seen),
    }));

module.exports = {
  openDatabase,
  readCursor,
  storeUpload,
  storeFeedBatch,
  sendOutbox,
  createIngestHandler,
  countEvents,
  listMachines,
};
