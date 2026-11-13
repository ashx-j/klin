import {
  PLUGIN_UPLOAD_MAX_BYTES,
  PLUGIN_UPLOAD_MAX_FILES,
  type PluginCreateDownloadUrlResult,
  type PluginCreateUploadUrlResult,
  PluginFleetEntry,
  PluginId,
  PluginMutationResult,
  type PluginState,
  type PluginUploadFile,
  PluginUploadFiles,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse, Multipart } from "effect/http";

import * as PayloadSigner from "../auth/PayloadSigner.ts";
import { base64UrlDecodeUtf8, base64UrlEncode } from "../auth/utils.ts";
import type { PluginNotFoundError } from "./PluginHost.ts";
import * as PluginInstaller from "./PluginInstaller.ts";
import type { PluginConfigError } from "./pluginsConfig.ts";

/**
 * A client installs a dropped plugin folder by uploading it here, to a URL `plugins.createUploadUrl`
 * signed. Up to 25 MB as one WebSocket message would hold up every other stream on the socket.
 * The signature is the upload's credential, as for attachments, so the client sends the request
 * the same way on a local, remote or T3 Connect connection. Each URL installs once.
 */
export const PLUGIN_UPLOAD_ROUTE_PREFIX = "/api/plugin-uploads";
/** Where a client fetches a plugin's files to copy it to another of the user's machines. */
export const PLUGIN_DOWNLOAD_ROUTE_PREFIX = "/api/plugin-downloads";

const SIGNING_SECRET_NAME = "plugin-upload-signing-key";
// The client uploads as soon as it has the URL.
const UPLOAD_URL_TTL_MS = 5 * 60_000;

const UploadClaims = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("plugin-upload"),
    expiresAt: Schema.Number,
    // Tells apart URLs signed in the same millisecond, so each one is used up on its own.
    nonce: Schema.String,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("plugin-download"),
    pluginId: PluginId,
    expiresAt: Schema.Number,
    nonce: Schema.String,
  }),
]);
type UploadClaims = typeof UploadClaims.Type;
const uploadClaimsJson = Schema.fromJsonString(UploadClaims);
const encodeUploadClaims = Schema.encodeSync(uploadClaimsJson);
const decodeUploadClaims = Schema.decodeUnknownOption(uploadClaimsJson);
const claimsOf = (payload: string) => {
  try {
    return decodeUploadClaims(base64UrlDecodeUtf8(payload));
  } catch {
    return Option.none();
  }
};
const decodeUploadFiles = Schema.decodeUnknownEffect(PluginUploadFiles);
const decodeFleetEntry = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginFleetEntry));
const mutationResponse = HttpServerResponse.schemaJson(PluginMutationResult);

export class PluginUploadUrlError extends Schema.TaggedError<PluginUploadUrlError>()(
  "PluginUploadUrlError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not sign a plugin upload URL.";
  }
}

export class PluginUploadUnusableUrlError extends Schema.TaggedError<PluginUploadUnusableUrlError>()(
  "PluginUploadUnusableUrlError",
  {},
) {
  override get message(): string {
    return "The upload URL is not one this server signed, or it expired or was used.";
  }
}

export class PluginUploads extends Context.Service<
  PluginUploads,
  {
    /** Signs a URL that installs one uploaded folder within 5 minutes. */
    readonly issueUrl: Effect.Effect<PluginCreateUploadUrlResult, PluginUploadUrlError>;
    /**
     * Installs `files` like `PluginInstaller.installFiles` if `token` is a URL this server signed
     * that is unexpired and unused, which it then uses up because it installs code. `upload` runs
     * only after that check, so a bad URL never has the server read a body.
     */
    readonly install: <E>(input: {
      readonly token: string;
      readonly upload: Effect.Effect<
        {
          readonly files: ReadonlyArray<PluginUploadFile>;
          readonly fleet: PluginFleetEntry | undefined;
        },
        E
      >;
    }) => Effect.Effect<
      PluginState,
      | E
      | PluginUploadUnusableUrlError
      | PluginInstaller.PluginInstallError
      | PluginNotFoundError
      | PluginConfigError
    >;
    /**
     * Signs a URL that answers once, within 5 minutes, with the plugin's files as they are then.
     * The files may hold what its author put there, so only a client that manages plugins gets one.
     */
    readonly issueDownloadUrl: (
      pluginId: PluginId,
    ) => Effect.Effect<
      PluginCreateDownloadUrlResult,
      PluginUploadUrlError | PluginInstaller.PluginInstallError | PluginNotFoundError
    >;
    readonly download: (
      token: string,
    ) => Effect.Effect<
      { readonly revision: string; readonly files: ReadonlyArray<PluginUploadFile> },
      PluginUploadUnusableUrlError | PluginInstaller.PluginInstallError | PluginNotFoundError
    >;
  }
>()("t3/plugins/PluginUploads") {}

const make = Effect.gen(function* () {
  const signer = yield* PayloadSigner.make(SIGNING_SECRET_NAME);
  const random = yield* SecureRandom.SecureRandom;
  const installer = yield* PluginInstaller.PluginInstaller;
  // Unused URLs by nonce, with when each expires. A restart forgets them, which only refuses more.
  const unused = new Map<string, number>();

  // Inside the span of the request that signs a URL.
  const sign = Effect.fnUntraced(function* (
    claims: (nonce: string, expiresAt: number) => UploadClaims,
  ) {
    const now = yield* Clock.currentTimeMillis;
    for (const [nonce, expiresAt] of unused) if (expiresAt <= now) unused.delete(nonce);
    const expiresAt = now + UPLOAD_URL_TTL_MS;
    const nonce = yield* random
      .uuidV4()
      .pipe(Effect.mapError((cause) => new PluginUploadUrlError({ cause })));
    const payload = base64UrlEncode(encodeUploadClaims(claims(nonce, expiresAt)));
    const signature = yield* signer
      .sign(payload)
      .pipe(Effect.mapError((cause) => new PluginUploadUrlError({ cause })));
    unused.set(nonce, expiresAt);
    return { token: `${payload}.${signature}`, expiresAt };
  });

  const issueUrl = Effect.fn("PluginUploads.issueUrl")(function* () {
    const { token, expiresAt } = yield* sign((nonce, expiresAt) => ({
      version: 1,
      kind: "plugin-upload",
      expiresAt,
      nonce,
    }));
    const result: PluginCreateUploadUrlResult = {
      relativeUrl: `${PLUGIN_UPLOAD_ROUTE_PREFIX}/${token}`,
      expiresAt,
    };
    return result;
  });

  // Inside the span of the request that uses it.
  const claim = Effect.fnUntraced(function* (token: string, kind: UploadClaims["kind"]) {
    const [payload, signature, unexpected] = token.split(".");
    if (!payload || !signature || unexpected !== undefined) return Option.none();
    const verified = yield* signer.verify(payload, signature).pipe(
      Effect.tapError((cause) =>
        Effect.logError("Failed to load the plugin upload signing key.", { cause }),
      ),
      Effect.orElseSucceed(() => false),
    );
    if (!verified) return Option.none();
    const claims = claimsOf(payload);
    if (
      Option.isNone(claims) ||
      claims.value.kind !== kind ||
      claims.value.expiresAt <= (yield* Clock.currentTimeMillis) ||
      !unused.delete(claims.value.nonce)
    ) {
      return Option.none();
    }
    return claims;
  });

  const install: PluginUploads["Service"]["install"] = Effect.fn("PluginUploads.install")(
    function* ({ token, upload }) {
      if (Option.isNone(yield* claim(token, "plugin-upload"))) {
        return yield* new PluginUploadUnusableUrlError();
      }
      const { files, fleet } = yield* upload;
      return yield* installer.installFiles(files, fleet);
    },
  );

  const issueDownloadUrl: PluginUploads["Service"]["issueDownloadUrl"] = Effect.fn(
    "PluginUploads.issueDownloadUrl",
  )(function* (pluginId) {
    // Fails now for a plugin that can't be copied, rather than when the client fetches it.
    const { revision } = yield* installer.exportFiles(pluginId);
    const { token, expiresAt } = yield* sign((nonce, expiresAt) => ({
      version: 1,
      kind: "plugin-download",
      pluginId,
      expiresAt,
      nonce,
    }));
    const result: PluginCreateDownloadUrlResult = {
      relativeUrl: `${PLUGIN_DOWNLOAD_ROUTE_PREFIX}/${token}`,
      expiresAt,
      revision,
    };
    return result;
  });

  const download: PluginUploads["Service"]["download"] = Effect.fn("PluginUploads.download")(
    function* (token) {
      const claims = yield* claim(token, "plugin-download");
      if (Option.isNone(claims) || claims.value.kind !== "plugin-download") {
        return yield* new PluginUploadUnusableUrlError();
      }
      return yield* installer.exportFiles(claims.value.pluginId);
    },
  );

  return PluginUploads.of({ issueUrl: issueUrl(), install, issueDownloadUrl, download });
});

export const layer = Layer.effect(PluginUploads, make);

// The total leaves room for each part's headers, whose file name is a path escaped with
// encodeURIComponent; the schema then checks the exact limits.
const UPLOAD_LIMITS = Multipart.limitsServices({
  maxParts: PLUGIN_UPLOAD_MAX_FILES,
  maxFileSize: PLUGIN_UPLOAD_MAX_BYTES,
  maxTotalSize: PLUGIN_UPLOAD_MAX_BYTES + PLUGIN_UPLOAD_MAX_FILES * 10 * 1024,
  // By default a JSON part is read as a field, which would drop t3-plugin.json.
  fieldMimeTypes: [],
});

const NOT_AN_UPLOAD = "The request is not a plugin folder.";
const text = (body: string, status: number) => HttpServerResponse.text(body, { status });

class PluginUploadBodyError extends Schema.TaggedError<PluginUploadBodyError>()(
  "PluginUploadBodyError",
  { status: Schema.Literals([400, 413]), reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

// A part named with a malformed escape names no file.
const decodePath = (name: string) => {
  try {
    return Option.some(decodeURIComponent(name));
  } catch {
    return Option.none();
  }
};

export const layerRoute = HttpRouter.add(
  "POST",
  `${PLUGIN_UPLOAD_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return text("Bad Request", 400);
    // In memory, as `installFiles` takes them.
    const upload = Effect.gen(function* () {
      let fleetJson: string | undefined;
      const received = yield* request.multipartStream.pipe(
        Stream.tap((part) =>
          Effect.sync(() => {
            if (Multipart.isField(part) && part.key === "fleet") fleetJson = part.value;
          }),
        ),
        Stream.filter(Multipart.isFile),
        Stream.mapEffect((file) =>
          file.contentEffect.pipe(
            Effect.map((contents) =>
              Option.map(decodePath(file.name), (path) => ({ path, contents })),
            ),
          ),
        ),
        Stream.runCollect,
        Effect.provideContext(UPLOAD_LIMITS),
        Effect.mapError((error) =>
          error.reason._tag === "Parse" || error.reason._tag === "InternalError"
            ? new PluginUploadBodyError({ status: 400, reason: NOT_AN_UPLOAD })
            : new PluginUploadBodyError({
                status: 413,
                reason: `A plugin folder can have up to ${PLUGIN_UPLOAD_MAX_FILES} files and ${PLUGIN_UPLOAD_MAX_BYTES / 1024 / 1024} MB.`,
              }),
        ),
      );
      const named = Option.all(received);
      if (Option.isNone(named)) {
        return yield* new PluginUploadBodyError({ status: 400, reason: NOT_AN_UPLOAD });
      }
      const files = yield* decodeUploadFiles(named.value).pipe(
        Effect.mapError(
          (error) => new PluginUploadBodyError({ status: 400, reason: error.message }),
        ),
      );
      const fleet =
        fleetJson === undefined
          ? undefined
          : yield* decodeFleetEntry(fleetJson).pipe(
              Effect.mapError(
                (error) => new PluginUploadBodyError({ status: 400, reason: error.message }),
              ),
            );
      return { files, fleet };
    });
    const uploads = yield* PluginUploads;
    return yield* uploads
      .install({ token: url.value.pathname.slice(`${PLUGIN_UPLOAD_ROUTE_PREFIX}/`.length), upload })
      .pipe(
        Effect.flatMap((plugin) => mutationResponse({ plugin }).pipe(Effect.orDie)),
        Effect.catchTags({
          // An expired, forged or used URL looks like no route at all.
          PluginUploadUnusableUrlError: () => Effect.succeed(text("Not Found", 404)),
          PluginUploadBodyError: (error) => Effect.succeed(text(error.reason, error.status)),
          PluginInstallError: (error) => Effect.succeed(text(error.message, 400)),
          PluginNotFoundError: (error) => Effect.succeed(text(error.message, 404)),
          PluginConfigError: (error) => Effect.succeed(text(error.message, 500)),
        }),
      );
  }),
);

/**
 * Answers a download URL with the plugin's files in the upload's format, so a client can post the
 * same parts to another machine's upload URL.
 */
export const layerDownloadRoute = HttpRouter.add(
  "GET",
  `${PLUGIN_DOWNLOAD_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return text("Bad Request", 400);
    const uploads = yield* PluginUploads;
    return yield* uploads
      .download(url.value.pathname.slice(`${PLUGIN_DOWNLOAD_ROUTE_PREFIX}/`.length))
      .pipe(
        Effect.map(({ revision, files }) => {
          const body = new FormData();
          for (const file of files) {
            body.append("file", new Blob([file.contents]), encodeURIComponent(file.path));
          }
          return HttpServerResponse.formData(body).pipe(
            HttpServerResponse.setHeaders({
              "cache-control": "no-store",
              "t3-plugin-revision": revision,
            }),
          );
        }),
        Effect.catchTags({
          PluginUploadUnusableUrlError: () => Effect.succeed(text("Not Found", 404)),
          PluginInstallError: (error) => Effect.succeed(text(error.message, 409)),
          PluginNotFoundError: (error) => Effect.succeed(text(error.message, 404)),
        }),
      );
  }),
);
