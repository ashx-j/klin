import type { JsonObject, JsonValue, PluginRpcMap } from "./shared.ts";

/** `read` methods need the caller's `orchestration:read` scope, `write` methods `orchestration:operate`. */
export type PluginRpcAccess = "read" | "write";

export interface PluginRpcContext {
  /**
   * Aborts when the caller goes away, the plugin deactivates, or the handler has not answered
   * within 30 seconds, when the call fails.
   */
  readonly signal: AbortSignal;
  /**
   * What the caller's session may call: `write` if it may call `write` methods, else `read`. A
   * `read` method can use it to tell a read-only session, such as a guest's, from the owner's.
   */
  readonly access: PluginRpcAccess;
}

export type PluginRpcHandler<
  Method extends PluginRpcMap["methods"][string] = PluginRpcMap["methods"][string],
> = (
  input: Method["input"],
  context: PluginRpcContext,
) => Method["output"] | Promise<Method["output"]>;

/** How every rejected API call fails. `code` names the server's error; treat it as opaque. */
export interface PluginApiError extends Error {
  readonly code: string;
}

/**
 * A plugin registers at most 32 tools, whose names, descriptions and schemas take at most 24,000
 * characters together, because agents in every thread see them all. A call that hasn't answered
 * within 5 minutes fails with an error the agent reads, and its `signal` aborts.
 */
export interface PluginMcpTool {
  /** Agents see the tool as `plg_<pluginId>_<name>`. Letters, digits, `_` and `-`. */
  readonly name: string;
  /** At most 1000 characters. */
  readonly description: string;
  /** JSON Schema for the tool's arguments, at most 4000 characters as JSON. */
  readonly inputSchema: JsonObject;
  /**
   * Every agent sees the tool. A `write` tool runs only for an agent in a thread set to Full
   * access and not in Plan mode, or an outside agent approved with Full access; others get a
   * refusal that says so. Agents from linked environments can't call it.
   */
  readonly access: PluginRpcAccess;
}

export type PluginMcpToolHandler = (
  input: JsonObject,
  context: {
    /** Aborts when the agent cancels the call, the plugin deactivates, or 5 minutes pass. */
    readonly signal: AbortSignal;
    /** The thread whose agent called the tool, or null for an MCP client outside a thread. */
    readonly threadId: string | null;
  },
) => JsonValue | Promise<JsonValue>;

export interface PluginLogger {
  readonly debug: (message: string, fields?: JsonObject) => void;
  readonly info: (message: string, fields?: JsonObject) => void;
  readonly warn: (message: string, fields?: JsonObject) => void;
  readonly error: (message: string, fields?: JsonObject) => void;
}

/**
 * One orchestration event as the environment stored it. Its payload is T3's own format, which
 * changes between releases, so a plugin that keeps events should keep the JSON text as it is.
 */
export interface PluginStoredEvent {
  /** Grows with every event this environment stores and is never reused there. */
  readonly sequence: number;
  readonly id: string;
  /** Such as `turn-item.updated` or `project.created`. */
  readonly type: string;
  /** `thread` or `project`. */
  readonly aggregate: string;
  /** The id of the thread or project the event belongs to. */
  readonly streamId: string;
  /** An ISO 8601 time. */
  readonly occurredAt: string;
  readonly commandId: string | null;
  /**
   * The payload as JSON text. Tool output in it is what the agent saw: Claude Code cuts most tool
   * output at about 30,000 characters before the agent reads it, and T3 cuts a file change's diff
   * at 32 KB.
   */
  readonly payloadJson: string;
  /** The metadata as JSON text, such as the run, the provider and the node. */
  readonly metadataJson: string;
}

export interface PluginStoredEventBatch {
  /** The next stored events in sequence order. Empty only when `missed` is set. */
  readonly events: ReadonlyArray<PluginStoredEvent>;
  /**
   * Set when T3 may have deleted events after `afterSequence`, through `throughSequence`, before
   * the feed read them. T3 keeps a stored event for about a day once its threads show it, and
   * keeps some older ones, such as each thread's newest event, longer, so the events in that range
   * that are still stored still arrive.
   */
  readonly missed?: { readonly afterSequence: number; readonly throughSequence: number };
}

/**
 * What `activate` receives. Everything is scoped to one activation and released on deactivate.
 * `Rpc` types the methods and channels the web half calls.
 */
export interface PluginApi<Rpc extends PluginRpcMap = PluginRpcMap> {
  /**
   * The server API's version, a separate number from the web half's `api.version`. T3 raises it
   * when `PluginApi` gains a member, whose doc then names the version that added it, so a plugin
   * can check it before using a member an older T3 lacks. To refuse older T3 releases outright, set
   * `engines.t3` in the manifest.
   */
  readonly version: number;
  readonly id: string;
  readonly rootDir: string;
  /**
   * The environment's id, which stays the same across restarts and updates. Added in version 2.
   */
  readonly environmentId: string;
  /**
   * A folder for the plugin's own files, such as a database. T3 creates it before `activate`, keeps
   * it across updates, and deletes it with the plugin's settings and storage when the plugin is
   * removed. Added in version 2.
   */
  readonly dataDir: string;
  readonly log: PluginLogger;
  readonly settings: {
    /**
     * The saved settings, secret values included. Fields nobody saved read as the `default` in
     * the manifest's `settingsSchema`, at the top level and for fields that are not secrets.
     */
    readonly get: () => Promise<JsonObject>;
    /** Yields the settings as `get` reads them after each change, until deactivation. */
    readonly changes: () => AsyncIterable<JsonObject>;
  };
  readonly storage: {
    readonly get: (key: string) => Promise<JsonValue | undefined>;
    readonly set: (key: string, value: JsonValue) => Promise<void>;
    readonly delete: (key: string) => Promise<void>;
    readonly list: (prefix?: string) => Promise<ReadonlyArray<string>>;
  };
  readonly rpc: {
    /**
     * Answers `plugins.invoke` calls for `method` from clients. `input` has the type `Rpc` gives
     * it, but a client can send any JSON, so check input before acting on it.
     */
    readonly register: <Method extends Extract<keyof Rpc["methods"], string>>(
      method: Method,
      handler: PluginRpcHandler<Rpc["methods"][Method]>,
      options: { readonly access: PluginRpcAccess },
    ) => void;
    /**
     * Sends `value` to every `plugins.subscribe` caller on `channel`. Any session that can read
     * this environment may subscribe, so never publish secrets. Throws when `value` is over 256 KB
     * as JSON, the limit a method's result has too.
     */
    readonly publish: <Channel extends Extract<keyof Rpc["channels"], string>>(
      channel: Channel,
      value: Rpc["channels"][Channel],
    ) => void;
  };
  /** Runs when the plugin is disabled or reloaded, or the server stops; at once if that already happened. */
  readonly onDeactivate: (cleanup: () => void | Promise<void>) => void;
  readonly mcp: {
    /**
     * Offers a tool to agents in every thread until the plugin deactivates. Then it leaves new tool
     * lists, and a call to it fails as an unknown tool.
     */
    readonly registerTool: (tool: PluginMcpTool, handler: PluginMcpToolHandler) => void;
  };
  /** The environment's stored orchestration events, read only. Added in version 2. */
  readonly events: {
    /**
     * Yields stored events after `afterSequence` in batches, then new ones as they are stored,
     * until `signal` aborts, the loop stops or the plugin deactivates. It reads a batch only when
     * the loop asks, so a slow plugin falls behind without holding up T3. Save the last sequence
     * you handled and pass it after a restart.
     */
    readonly stored: (options?: {
      /** Starts after this sequence. Without it, the feed starts with the next event stored. */
      readonly afterSequence?: number;
      /** Only events of these types. */
      readonly types?: ReadonlyArray<string>;
      /**
       * At most this many events per batch, from 1 to 500, 100 by default. A batch also stops at
       * about 4 MB of JSON text.
       */
      readonly batchSize?: number;
      readonly signal?: AbortSignal;
    }) => AsyncIterable<PluginStoredEventBatch>;
  };
}

export interface PluginDefinition<Rpc extends PluginRpcMap = PluginRpcMap> {
  readonly activate: (api: PluginApi<Rpc>) => void | Promise<void>;
}

/**
 * Types a server plugin. The CommonJS entry sets `module.exports` to the result. Pass the plugin's
 * `PluginRpcMap`, as in `definePlugin<NotesRpc>({ ... })`, to type `api.rpc`.
 */
export const definePlugin = <Rpc extends PluginRpcMap = PluginRpcMap>(
  definition: PluginDefinition<Rpc>,
): PluginDefinition<Rpc> => definition;
