// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Plugins run as plain Node, outside any Effect runtime.
const NodeHttp = require("node:http");
const NodeOS = require("node:os");
const NodePath = require("node:path");
const Archive = require("./archive.cjs");

const MIN_RETRY_MS = 5_000;
const MAX_RETRY_MS = 5 * 60_000;
// New outbox rows wake the sender at once; this only bounds how long a missed wake can last.
const IDLE_RECHECK_MS = 60_000;
const MIN_KEY_LENGTH = 16;

/** @typedef {{ role: "hub" | "spoke" | "idle"; archivedEvents?: number; machines?: Array<{ label: string; cursor: number; lastSeen: string }>; outboxEvents?: number; lastError?: string }} Status */
/** @typedef {{ methods: { status: { input: undefined; output: Status } }; channels: Record<string, never> }} ArchiveRpc */
/** @typedef {import("@t3tools/plugin-sdk/server").PluginApi<ArchiveRpc>} Api */
/** @typedef {{ readonly status: () => Status; readonly stop: () => Promise<void> }} Role */
/** @typedef {ReturnType<typeof readSettings>} Settings */
/** @typedef {ReturnType<typeof makeProblems>} Problems */

/** @type {(error: unknown) => string} */
const describe = (error) => (error instanceof Error ? error.message : String(error));

/**
 * Waits `ms`, or less when `signal` aborts or `wakeable.wake` is called. Never rejects.
 * @type {(ms: number, signal: AbortSignal, wakeable?: { wake?: () => void }) => Promise<void>}
 */
const pause = (ms, signal, wakeable) =>
  new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      if (wakeable) delete wakeable.wake;
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
    if (wakeable) wakeable.wake = done;
    if (signal.aborted) done();
  });

/** @type {() => Promise<void>} */
const yieldToServer = () => new Promise((resolve) => setImmediate(resolve));

/** @type {(settings: import("@t3tools/plugin-sdk/shared").JsonObject) => { archivePath: string; hubUrl: string; key: string; signature: string }} */
const readSettings = (settings) => {
  /** @type {(name: string) => string} */
  const text = (name) => {
    const value = settings[name];
    return typeof value === "string" ? value.trim() : "";
  };
  const archivePath = text("archivePath");
  const hubUrl = text("hubUrl");
  const key = text("key");
  return { archivePath, hubUrl, key, signature: JSON.stringify([archivePath, hubUrl, key]) };
};

/**
 * Why this machine can't reach or serve the hub with these settings, if it can't.
 * @type {(settings: Settings) => string | undefined}
 */
const networkProblem = ({ hubUrl, key }) => {
  if (!URL.canParse(hubUrl) || new URL(hubUrl).protocol !== "http:") {
    return "hubUrl must be an http:// address, such as http://homeserver:4790.";
  }
  if (key.length < MIN_KEY_LENGTH) return `key must have at least ${MIN_KEY_LENGTH} characters.`;
  return undefined;
};

/**
 * Each loop's current problem, logged when it starts or ends. `status` shows them all.
 * @type {(log: Api["log"]) => { set: (source: string, problem: string | undefined) => void; summary: () => string | undefined }}
 */
const makeProblems = (log) => {
  /** @type {Map<string, string>} */
  const problems = new Map();
  return {
    set: (source, problem) => {
      if (problems.get(source) === problem) return;
      if (problem === undefined) {
        problems.delete(source);
        log.info("Session archive recovered.", { source });
      } else {
        problems.set(source, problem);
        log.warn(problem, { source });
      }
    },
    summary: () => (problems.size === 0 ? undefined : [...problems.values()].join(" ")),
  };
};

/**
 * Copies this machine's stored events into `db` from the cursor saved there, until `signal`
 * aborts. Each batch commits with its cursor, so a restart resumes where the last commit ended.
 * @type {(api: Api, db: import("node:sqlite").DatabaseSync, machine: { id: string; label: string }, signal: AbortSignal, problems: Problems, onStored: () => void) => Promise<void>}
 */
const followFeed = async (api, db, machine, signal, problems, onStored) => {
  let delay = MIN_RETRY_MS;
  while (!signal.aborted) {
    try {
      const afterSequence = Archive.readCursor(db, machine.id);
      for await (const batch of api.events.stored({ afterSequence, signal })) {
        Archive.storeFeedBatch(db, machine, batch);
        problems.set("feed", undefined);
        delay = MIN_RETRY_MS;
        onStored();
        await yieldToServer();
      }
    } catch (error) {
      if (signal.aborted) return;
      problems.set("feed", `Session archive could not save events: ${describe(error)}`);
    }
    await pause(delay, signal);
    delay = Math.min(delay * 2, MAX_RETRY_MS);
  }
};

/**
 * Ships the outbox to the hub until `signal` aborts. Waits for new rows while it is empty, and
 * backs off from 5 seconds to 5 minutes while the hub can't be reached.
 * @type {(api: Api, db: import("node:sqlite").DatabaseSync, machine: { id: string; label: string }, settings: Settings, signal: AbortSignal, problems: Problems, wakeable: { wake?: () => void }) => Promise<void>}
 */
const shipOutbox = async (api, db, machine, settings, signal, problems, wakeable) => {
  let delay = MIN_RETRY_MS;
  while (!signal.aborted) {
    try {
      const { sent, dropped } = await Archive.sendOutbox({
        db,
        machine,
        hubUrl: settings.hubUrl,
        key: settings.key,
        signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      });
      problems.set("send", undefined);
      delay = MIN_RETRY_MS;
      if (dropped !== undefined) {
        api.log.error("Session archive dropped an event too big for the hub.", {
          sequence: dropped,
        });
      }
      if (sent === 0 && dropped === undefined) await pause(IDLE_RECHECK_MS, signal, wakeable);
      else await yieldToServer();
      continue;
    } catch (error) {
      if (signal.aborted) return;
      problems.set("send", `Session archive could not send events to the hub: ${describe(error)}`);
    }
    await pause(delay, signal);
    delay = Math.min(delay * 2, MAX_RETRY_MS);
  }
};

/** @type {(server: import("node:http").Server) => Promise<void>} */
const closeServer = (server) =>
  new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });

/**
 * Archives this machine's events into `archivePath`, and when `hubUrl` and `key` are usable,
 * stores what spokes send to the port in `hubUrl`, on every network interface.
 * @type {(api: Api, machine: { id: string; label: string }, settings: Settings) => Role}
 */
const startHub = (api, machine, settings) => {
  if (!NodePath.isAbsolute(settings.archivePath)) {
    throw new Error(
      "archivePath must be an absolute path, such as /srv/archive/klin-sessions.sqlite.",
    );
  }
  const db = Archive.openDatabase(settings.archivePath);
  const problems = makeProblems(api.log);
  const controller = new AbortController();
  const feed = followFeed(api, db, machine, controller.signal, problems, () => {});
  /** @type {import("node:http").Server | undefined} */
  let server;
  const problem = settings.hubUrl === "" ? undefined : networkProblem(settings);
  if (problem !== undefined) {
    problems.set("listen", `Session archive is not listening for other machines: ${problem}`);
  } else if (settings.hubUrl !== "") {
    const port = Number(new URL(settings.hubUrl).port || 80);
    server = NodeHttp.createServer(
      Archive.createIngestHandler({
        db,
        key: settings.key,
        hubMachineId: machine.id,
        onError: (error) =>
          api.log.error("Session archive could not store events a machine sent.", {
            error: describe(error),
          }),
      }),
    );
    server.on("error", (error) =>
      problems.set("listen", `Session archive can't listen on port ${port}: ${error.message}`),
    );
    server.on("listening", () => {
      problems.set("listen", undefined);
      api.log.info("Session archive is listening for other machines.", { port });
    });
    server.listen(port);
  }
  api.log.info("Session archive is the hub.", { archivePath: settings.archivePath });
  return {
    status: () => {
      const lastError = problems.summary();
      return {
        role: "hub",
        archivedEvents: Archive.countEvents(db),
        machines: Archive.listMachines(db),
        ...(lastError === undefined ? {} : { lastError }),
      };
    },
    stop: async () => {
      controller.abort();
      if (server !== undefined) await closeServer(server);
      await feed;
      db.close();
    },
  };
};

/**
 * Keeps this machine's events in an outbox in `dataDir` and sends them to the hub. The outbox
 * fills even while `key` is missing, so nothing is lost while the machine is being set up.
 * @type {(api: Api, machine: { id: string; label: string }, settings: Settings) => Role}
 */
const startSpoke = (api, machine, settings) => {
  const db = Archive.openDatabase(NodePath.join(api.dataDir, "outbox.sqlite"));
  const problems = makeProblems(api.log);
  const controller = new AbortController();
  /** @type {{ wake?: () => void }} */
  const sender = {};
  const loops = [followFeed(api, db, machine, controller.signal, problems, () => sender.wake?.())];
  const problem = networkProblem(settings);
  if (problem !== undefined) {
    problems.set("send", `Session archive is not sending events: ${problem}`);
  } else {
    loops.push(shipOutbox(api, db, machine, settings, controller.signal, problems, sender));
  }
  api.log.info("Session archive sends events to the hub.", { hubUrl: settings.hubUrl });
  return {
    status: () => {
      const lastError = problems.summary();
      return {
        role: "spoke",
        outboxEvents: Archive.countEvents(db),
        ...(lastError === undefined ? {} : { lastError }),
      };
    },
    stop: async () => {
      controller.abort();
      await Promise.all(loops);
      db.close();
    },
  };
};

/** @type {(status: Status) => Role} */
const inertRole = (status) => ({ status: () => status, stop: async () => {} });

/** @type {import("@t3tools/plugin-sdk/server").PluginDefinition<ArchiveRpc>} */
module.exports = {
  async activate(api) {
    if (api.version < 2) {
      throw new Error("Session archive needs plugin API version 2 or later. Update Klin.");
    }
    const machine = { id: api.environmentId, label: NodeOS.hostname() };
    /** @type {Role} */
    let role = inertRole({ role: "idle" });
    let appliedSignature = "";
    let deactivated = false;
    // Settings apply one at a time, so the old role has stopped before the new one starts.
    /** @type {Promise<void>} */
    let applying = Promise.resolve();
    /** @type {(values: import("@t3tools/plugin-sdk/shared").JsonObject) => void} */
    const apply = (values) => {
      applying = applying
        .then(async () => {
          const settings = readSettings(values);
          if (deactivated || settings.signature === appliedSignature) return;
          await role.stop();
          role = inertRole({ role: "idle" });
          const kind =
            settings.archivePath !== "" ? "hub" : settings.hubUrl !== "" ? "spoke" : "idle";
          try {
            if (kind === "hub") role = startHub(api, machine, settings);
            if (kind === "spoke") role = startSpoke(api, machine, settings);
            appliedSignature = settings.signature;
          } catch (error) {
            // The signature stays unapplied, so saving the same settings again retries.
            appliedSignature = "";
            const lastError = `Session archive could not start as the ${kind}: ${describe(error)}`;
            api.log.error(lastError);
            role = inertRole({ role: kind, lastError });
          }
        })
        .catch((error) =>
          api.log.error("Session archive could not apply its settings.", {
            error: describe(error),
          }),
        );
    };
    api.rpc.register("status", () => role.status(), { access: "read" });
    api.onDeactivate(async () => {
      deactivated = true;
      await applying;
      await role.stop();
    });
    apply(await api.settings.get());
    void (async () => {
      for await (const values of api.settings.changes()) apply(values);
    })().catch((error) =>
      api.log.error("Session archive stopped following its settings.", { error: describe(error) }),
    );
  },
};
