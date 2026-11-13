import type { PreparedHttpAuthorization } from "@t3tools/client-runtime/connection";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  type AtomCommandResult,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type PluginFleetEntry,
  PluginMutationResult,
  type PluginState,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { pluginEnvironment } from "../state/plugins";
import { readPreparedConnection } from "../state/session";
import type { PluginFolderFile } from "./pluginFolders";

// Bearer and cookie sessions can fetch plugin files directly. A DPoP proof needs the relay
// signer, which only the client runtime holds.
async function pluginFileRequestInit(
  authorization: PreparedHttpAuthorization | null,
  url: URL,
): Promise<RequestInit> {
  if (authorization === null) return { credentials: "include" };
  if (authorization._tag === "Bearer") {
    return { headers: { authorization: `Bearer ${authorization.token}` } };
  }
  const headers = await runAtomCommand(
    appAtomRegistry,
    pluginEnvironment.pluginFileHeaders,
    { authorization, url: url.href },
    { reportFailure: false },
  );
  if (headers._tag !== "Success")
    throw new Error("Could not authorize the request over T3 Connect.");
  return { headers: { ...headers.value } };
}

class PluginFileRequestError extends Schema.TaggedError<PluginFileRequestError>()(
  "PluginFileRequestError",
  { status: Schema.Number, filePath: Schema.String },
) {
  override get message(): string {
    return `The request for ${this.filePath} failed with ${this.status}.`;
  }
}

const isPluginFileRequestError = Schema.is(PluginFileRequestError);

// A dropped connection or a gateway error, such as one bad gateway over T3 Connect, can pass.
const isPassingDownloadFailure = (error: unknown) =>
  error instanceof TypeError ||
  (isPluginFileRequestError(error) && [502, 503, 504].includes(error.status));
const DOWNLOAD_RETRY_DELAYS_MS = [1_000, 5_000, 30_000];

// A file whose URL names its contents, such as the web bundle, is one the server lets browsers
// cache for good.
export async function fetchPluginFile(
  environmentId: EnvironmentId,
  plugin: PluginState,
  filePath: string,
  revision = plugin.version ?? "0",
): Promise<Response> {
  const connection = readPreparedConnection(environmentId);
  if (connection === null) throw new Error("The environment is not connected.");
  const authorization = connection.httpAuthorization;
  const url = new URL(
    `/api/plugins/${encodeURIComponent(plugin.id)}${filePath}`,
    connection.httpBaseUrl,
  );
  url.searchParams.set("v", revision);
  const response = await fetch(url, await pluginFileRequestInit(authorization, url));
  if (!response.ok) throw new PluginFileRequestError({ status: response.status, filePath });
  return response;
}

/** Resolves undefined when `cancelled` turns true during a wait between tries. */
export async function withDownloadRetries<A>(
  download: () => Promise<A>,
  cancelled: () => boolean,
): Promise<A | undefined> {
  for (const delay of [...DOWNLOAD_RETRY_DELAYS_MS, undefined]) {
    try {
      return await download();
    } catch (error) {
      if (delay === undefined || !isPassingDownloadFailure(error)) throw error;
      await new Promise((resume) => setTimeout(resume, delay));
      if (cancelled()) return undefined;
    }
  }
  return undefined;
}

const decodeMutationResult = Schema.decodeUnknownSync(Schema.fromJsonString(PluginMutationResult));

/** Signs a transfer URL on `environmentId` and resolves it against that environment. */
async function signedUrl<A extends { readonly relativeUrl: string }>(
  environmentId: EnvironmentId,
  mint: () => Promise<AtomCommandResult<A, unknown>>,
): Promise<{ readonly url: string; readonly minted: A }> {
  const minted = await mint();
  if (minted._tag !== "Success") {
    const error = squashAtomCommandFailure(minted);
    throw error instanceof Error ? error : new Error("Could not start the transfer.");
  }
  const connection = readPreparedConnection(environmentId);
  const url =
    connection === null ? null : resolveAssetUrl(connection.httpBaseUrl, minted.value.relativeUrl);
  if (url === null) throw new Error("The environment is not connected.");
  return { url, minted: minted.value };
}

// The files go over HTTP to a URL the server signs, which needs no other credentials, so a large
// folder does not hold up the WebSocket.
async function postPluginForm(environmentId: EnvironmentId, body: FormData): Promise<PluginState> {
  const { url } = await signedUrl(environmentId, () =>
    runAtomCommand(
      appAtomRegistry,
      pluginEnvironment.createPluginUploadUrl,
      { environmentId, input: {} },
      { reportFailure: false },
    ),
  );
  const response = await fetch(url, { method: "POST", body });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `The upload failed with ${response.status}.`);
  return decodeMutationResult(text).plugin;
}

export async function uploadPluginFolder(
  environmentId: EnvironmentId,
  files: ReadonlyArray<PluginFolderFile>,
): Promise<PluginState> {
  const body = new FormData();
  // Escaped, so no browser or parser changes a path's quotes, slashes or other characters.
  for (const { path, file } of files) body.append("file", file, encodeURIComponent(path));
  return postPluginForm(environmentId, body);
}

/**
 * Copies a plugin's files from one of the user's machines to another, with the shared entry that
 * says which files they are and whether the plugin is on. The download comes in the upload's
 * format, so its parts go back out as they are.
 */
export async function copyPlugin(
  from: EnvironmentId,
  to: EnvironmentId,
  entry: PluginFleetEntry,
): Promise<PluginState> {
  const { url, minted } = await signedUrl(from, () =>
    runAtomCommand(
      appAtomRegistry,
      pluginEnvironment.createPluginDownloadUrl,
      { environmentId: from, input: { pluginId: entry.pluginId } },
      { reportFailure: false },
    ),
  );
  if (minted.revision !== entry.revision) {
    // A rescan records an installed copy's new files as a newer change, which then copies itself.
    await runAtomCommand(
      appAtomRegistry,
      pluginEnvironment.rescanPlugins,
      { environmentId: from, input: {} },
      { reportFailure: false },
    );
    throw new Error(
      "Its files changed on the machine it is copied from since they were shared. A linked folder shares its changes when you choose Reload there.",
    );
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error((await response.text()) || `The download failed with ${response.status}.`);
  }
  const body = await response.formData();
  body.append("fleet", JSON.stringify(entry));
  return postPluginForm(to, body);
}
