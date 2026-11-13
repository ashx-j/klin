import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as AnalyticsService from "./AnalyticsService.ts";

// AnalyticsService.test.ts turns the switch on to cover delivery. This file runs with Klin's
// real identity, where the PostHog project and ingest host belong to T3 Code.
it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("AnalyticsService in Klin", (it) => {
  it.effect("sends nothing, even when the environment turns telemetry on", () =>
    Effect.gen(function* () {
      let requests = 0;
      const client = HttpClient.make((request) => {
        requests += 1;
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })),
        );
      });
      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        for (let index = 0; index < 20; index += 1) {
          yield* analytics.record("test.event", { index });
        }
        yield* analytics.flush;
      }).pipe(
        Effect.provide(
          AnalyticsService.layer.pipe(
            Layer.provideMerge(
              ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "klin-telemetry-off-" }),
            ),
            Layer.provide(
              ConfigProvider.layer(ConfigProvider.fromUnknown({ T3CODE_TELEMETRY_ENABLED: true })),
            ),
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(HostProcess.Platform, "linux"),
                Layer.succeed(HostProcess.Architecture, "x64"),
                Layer.succeed(HttpClient.HttpClient, client),
                ManagedPolicy.layerTest(undefined),
              ),
            ),
          ),
        ),
      );
      assert.equal(requests, 0);
    }),
  );
});
