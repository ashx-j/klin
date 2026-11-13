// @effect-diagnostics nodeBuiltinImport:off - Plugins run as plain Node, outside any Effect runtime.
const NodeWorker = require("node:worker_threads");
const Archive = require("./archive.cjs");

// `Archive.openDatabaseWorker` starts this file. A database that won't open fails the worker,
// which fails the call that started it.
const port = NodeWorker.parentPort;
if (port === null) throw new Error("database-worker.cjs runs only as a Worker.");
const db = Archive.openDatabase(String(NodeWorker.workerData));

port.on("message", (/** @type {import("./archive.cjs").WorkerRequest} */ request) => {
  try {
    port.postMessage({ id: request.id, value: Archive.runQuery(db, request.name, request.args) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    port.postMessage({ id: request.id, error: message });
  }
});
