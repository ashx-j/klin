// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Plugins run as plain Node, outside any Effect runtime.
const NodeHttp = require("node:http");
const NodeNet = require("node:net");
const NodeOS = require("node:os");
const NodePath = require("node:path");
const Archive = require("./archive.cjs");

const MIN_RETRY_MS = 5_000;
const MAX_RETRY_MS = 5 * 60_000;
// New outbox rows wake the sender at once; this only bounds how long a missed wake can last.
const IDLE_RECHECK_MS = 60_000;
const MIN_KEY_LENGTH = 16;
const OUTBOX_FILE = "outbox.sqlite";

/** @typedef {{ role: "hub" | "spoke"; archivedEvents?: number; machines?: ReturnType<typeof Archive.listMachines>; outboxEvents?: number; notSending?: string; lastError?: string }} Status */
/** @typedef {{ methods: { status: { input: undefined; output: Status } }; channels: Record<string, never> }} ArchiveRpc */
/** @typedef {import("@t3tools/plugin-sdk/server").PluginApi<ArchiveRpc>} Api */
/** @typedef {{ readonly status: () => Promise<Status>; readonly stop: () => Promise<void> }} Role */
/** @typedef {{ readonly id: string; readonly label: string }} Machine */
/** @typedef {import("./archive.cjs").DatabaseWorker} DatabaseWorker */
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
  if (hubUrl === "") return "Hub address is empty.";
  if (!URL.canParse(hubUrl) || new URL(hubUrl).protocol !== "http:") {
    return "Hub address must be an http:// address, such as http://homeserver:4790.";
  }
  if (key.length < MIN_KEY_LENGTH) {
    return `Shared key must have at least ${MIN_KEY_LENGTH} characters.`;
  }
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

/** @type {(api: Api, file: string) => DatabaseWorker} */
const openDatabase = (api, file) =>
  Archive.openDatabaseWorker(file, (error) =>
    api.log.error("Session archive's database worker stopped.", { error: error.message }),
  );

/**
 * Copies this machine's stored events into `db` from the cursor saved there, until `signal`
 * aborts. Each batch commits with its cursor, so after a failed batch, such as on a locked
 * database, the feed resumes where the last commit ended. `prepare` runs before each start.
 * @type {(api: Api, db: DatabaseWorker, machine: Machine, signal: AbortSignal, problems: Problems, onStored: () => void, prepare?: () => Promise<void>) => Promise<void>}
 */
const followFeed = async (api, db, machine, signal, problems, onStored, prepare) => {
  let delay = MIN_RETRY_MS;
  while (!signal.aborted) {
    try {
      await prepare?.();
      const afterSequence = await db.run("readCursor", machine.id);
      for await (const batch of api.events.stored({ afterSequence, signal })) {
        await db.run("storeFeedBatch", machine, batch);
        problems.set("feed", undefined);
        delay = MIN_RETRY_MS;
        onStored();
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
 * @type {(api: Api, db: DatabaseWorker, machine: Machine, settings: Settings, signal: AbortSignal, problems: Problems, wakeable: { wake?: () => void }) => Promise<void>}
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
      continue;
    } catch (error) {
      if (signal.aborted) return;
      problems.set("send", `Session archive could not send events to the hub: ${describe(error)}`);
    }
    await pause(delay, signal);
    delay = Math.min(delay * 2, MAX_RETRY_MS);
  }
};

/**
 * Serves `server` on the port in `hubUrl`: only at its host when that is an IP address, such as a
 * Tailscale address, and otherwise on every interface. A failed listen, such as before Tailscale
 * has its address, is retried. Returns the function that stops it.
 * @type {(api: Api, server: import("node:http").Server, hubUrl: string, problems: Problems) => () => Promise<void>}
 */
const listen = (api, server, hubUrl, problems) => {
  const url = new URL(hubUrl);
  const port = Number(url.port || 80);
  const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const host = NodeNet.isIP(hostname) === 0 ? undefined : hostname;
  const address = host ?? "every network interface";
  let delay = MIN_RETRY_MS;
  let stopped = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let retry;
  const start = () => (host === undefined ? server.listen(port) : server.listen(port, host));
  server.on("error", (error) => {
    problems.set(
      "listen",
      `Session archive can't listen on port ${port} of ${address}: ${error.message}`,
    );
    if (stopped || server.listening) return;
    retry = setTimeout(start, delay);
    delay = Math.min(delay * 2, MAX_RETRY_MS);
  });
  server.on("listening", () => {
    problems.set("listen", undefined);
    api.log.info("Session archive is listening for other machines.", { port, address });
  });
  start();
  return () =>
    new Promise((resolve) => {
      stopped = true;
      clearTimeout(retry);
      server.close(() => resolve());
      server.closeAllConnections();
    });
};

/**
 * Archives this machine's events into `archivePath`, after moving in what it kept in its outbox
 * as a spoke. When `hubUrl` and `key` are usable, it also stores what spokes send.
 * @type {(api: Api, machine: Machine, settings: Settings) => Role}
 */
const startHub = (api, machine, settings) => {
  const outboxFile = NodePath.resolve(api.dataDir, OUTBOX_FILE);
  if (!NodePath.isAbsolute(settings.archivePath)) {
    throw new Error(
      "Archive file must be an absolute path, such as /srv/archive/klin-sessions.sqlite.",
    );
  }
  if (NodePath.resolve(settings.archivePath) === outboxFile) {
    throw new Error("Archive file can't be this plugin's own outbox.");
  }
  const db = openDatabase(api, settings.archivePath);
  const problems = makeProblems(api.log);
  const controller = new AbortController();
  // A failed move doesn't stop the feed. It is tried again whenever the feed restarts.
  const moveOutbox = async () => {
    try {
      const moved = await db.run("mergeOutbox", outboxFile);
      problems.set("outbox", undefined);
      if (moved !== undefined) {
        api.log.info("Session archive moved this machine's outbox into the archive.", {
          newEvents: moved,
        });
      }
    } catch (error) {
      problems.set(
        "outbox",
        `Session archive could not move this machine's outbox into the archive: ${describe(error)}`,
      );
    }
  };
  const feed = followFeed(api, db, machine, controller.signal, problems, () => {}, moveOutbox);
  let stopListening = async () => {};
  const problem = settings.hubUrl === "" ? undefined : networkProblem(settings);
  if (problem !== undefined) {
    problems.set("listen", `Session archive is not listening for other machines: ${problem}`);
  } else if (settings.hubUrl !== "") {
    const server = NodeHttp.createServer(
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
    stopListening = listen(api, server, settings.hubUrl, problems);
  }
  api.log.info("Session archive is the hub.", { archivePath: settings.archivePath });
  return {
    status: async () => {
      const machines = await db.run("listMachines");
      const lastError = problems.summary();
      return {
        role: "hub",
        archivedEvents: machines.reduce((total, row) => total + row.events, 0),
        machines,
        ...(lastError === undefined ? {} : { lastError }),
      };
    },
    stop: async () => {
      controller.abort();
      await stopListening();
      await feed;
      await db.close();
    },
  };
};

/**
 * Keeps this machine's events in an outbox in `dataDir` from the start, and sends them to the hub
 * once `hubUrl` and `key` are usable, so nothing is lost while the machine is being set up.
 * @type {(api: Api, machine: Machine, settings: Settings) => Role}
 */
const startSpoke = (api, machine, settings) => {
  const db = openDatabase(api, NodePath.join(api.dataDir, OUTBOX_FILE));
  const problems = makeProblems(api.log);
  const controller = new AbortController();
  /** @type {{ wake?: () => void }} */
  const sender = {};
  const loops = [followFeed(api, db, machine, controller.signal, problems, () => sender.wake?.())];
  const problem = networkProblem(settings);
  const notSending =
    problem === undefined
      ? undefined
      : `Session archive keeps this machine's events in its outbox and sends them once Hub address and Shared key are set. ${problem}`;
  if (notSending === undefined) {
    loops.push(shipOutbox(api, db, machine, settings, controller.signal, problems, sender));
    api.log.info("Session archive sends this machine's events to the hub.", {
      hubUrl: settings.hubUrl,
    });
  } else {
    api.log.warn(notSending);
  }
  return {
    status: async () => {
      const outboxEvents = await db.run("countEvents");
      const lastError = problems.summary();
      return {
        role: "spoke",
        outboxEvents,
        ...(notSending === undefined ? {} : { notSending }),
        ...(lastError === undefined ? {} : { lastError }),
      };
    },
    stop: async () => {
      controller.abort();
      await Promise.all(loops);
      await db.close();
    },
  };
};

/** @type {(status: Status) => Role} */
const inertRole = (status) => ({ status: async () => status, stop: async () => {} });

/** @type {import("@t3tools/plugin-sdk/server").PluginDefinition<ArchiveRpc>} */
module.exports = {
  async activate(api) {
    if (api.version < 2) {
      throw new Error("Session archive needs plugin API version 2 or later. Update Klin.");
    }
    const machine = { id: api.environmentId, label: NodeOS.hostname() };
    // `status` waits for `applying`, so it never answers with this placeholder.
    /** @type {Role} */
    let role = inertRole({ role: "spoke" });
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
          const kind = settings.archivePath === "" ? "spoke" : "hub";
          try {
            role =
              kind === "hub"
                ? startHub(api, machine, settings)
                : startSpoke(api, machine, settings);
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
    api.rpc.register(
      "status",
      async () => {
        await applying;
        return role.status();
      },
      { access: "read" },
    );
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
