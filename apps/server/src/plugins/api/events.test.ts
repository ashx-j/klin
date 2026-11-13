import { assert, it } from "@effect/vitest";
import { CommandId, EventId, PluginId, ProjectId } from "@t3tools/contracts";
import type { PluginStoredEventBatch } from "@t3tools/plugin-sdk/server";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as OrchestrationEventStore from "../../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { makePluginActivation } from "../PluginApi.ts";
import { makeEventsApi } from "./events.ts";
import { makeFacadeContext } from "./facade.ts";

const layer = it.layer(
  OrchestrationEventStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
);

const projectId = ProjectId.make("project-feed");

/** Stores and publishes one project event, as the event sink does after its commit. */
const append = Effect.fn(function* (
  key: string,
  type: "project.meta-updated" | "project.deleted" = "project.meta-updated",
) {
  const store = yield* OrchestrationEventStore.OrchestrationEventStore;
  const at = "2026-11-13T00:00:00.000Z";
  const base = {
    eventId: EventId.make(`event-feed-${key}`),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: at,
    commandId: CommandId.make(`command-feed-${key}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
  } as const;
  const stored = yield* store.appendProjectEvent(
    type === "project.deleted"
      ? { ...base, type, payload: { projectId, deletedAt: at } }
      : { ...base, type, payload: { projectId, title: key, updatedAt: at } },
  );
  yield* store.publishCommitted([stored]);
  return stored.sequence;
});

type Store = OrchestrationEventStore.OrchestrationEventStore["Service"];

/**
 * The feed as a plugin gets it, with the activation that disabling it would end. `wrap` replaces
 * store methods, such as to record what the feed reads.
 */
const openFeed = Effect.fn(function* (
  options: Parameters<ReturnType<typeof makeEventsApi>["stored"]>[0],
  wrap: (store: Store) => Partial<Store> = () => ({}),
) {
  const real = yield* OrchestrationEventStore.OrchestrationEventStore;
  const store: Store = { ...real, ...wrap(real) };
  const activation = makePluginActivation();
  const facade = makeFacadeContext({
    pluginId: PluginId.make("feed-test"),
    activation,
    context: yield* Effect.context<never>(),
  });
  const iterator = makeEventsApi(facade, store).stored(options)[Symbol.asyncIterator]();
  const next = Effect.promise(() => iterator.next());
  const batch = next.pipe(
    Effect.map((result): PluginStoredEventBatch => {
      assert.isFalse(result.done);
      return result.value;
    }),
  );
  return { next, batch, activation };
});

const sequencesOf = (batch: PluginStoredEventBatch) => batch.events.map((event) => event.sequence);

layer("plugin event feed", (it) => {
  it.effect("resumes after a sequence in ordered batches, then follows new events once each", () =>
    Effect.gen(function* () {
      yield* append("one");
      const second = yield* append("two");
      const third = yield* append("three");
      const fourth = yield* append("four");
      const fifth = yield* append("five");
      const feed = yield* openFeed({ afterSequence: second, batchSize: 2 });
      const first = yield* feed.batch;
      assert.deepStrictEqual(sequencesOf(first), [third, fourth]);
      assert.deepStrictEqual(JSON.parse(first.events[0]!.payloadJson), {
        projectId,
        title: "three",
        updatedAt: "2026-11-13T00:00:00.000Z",
      });
      assert.deepStrictEqual(sequencesOf(yield* feed.batch), [fifth]);
      // Caught up, the next pull waits for the next commit.
      const waiting = yield* Effect.forkChild(feed.batch);
      const sixth = yield* append("six");
      assert.deepStrictEqual(sequencesOf(yield* Fiber.join(waiting)), [sixth]);
    }),
  );

  it.effect("yields only the requested types", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore.OrchestrationEventStore;
      const after = yield* store.latestApplicationSequence;
      yield* append("kept-out");
      const deleted = yield* append("deleted", "project.deleted");
      yield* append("kept-out-too");
      const feed = yield* openFeed({ afterSequence: after, types: ["project.deleted"] });
      const batch = yield* feed.batch;
      assert.deepStrictEqual(
        batch.events.map((event) => [event.sequence, event.type]),
        [[deleted, "project.deleted"]],
      );
    }),
  );

  it.effect("passes the rows a type filter leaves out instead of reading them again", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore.OrchestrationEventStore;
      const after = yield* store.latestApplicationSequence;
      yield* append("skipped-1");
      const headBefore = yield* append("skipped-2");
      const readsFrom: Array<number> = [];
      const feed = yield* openFeed(
        { afterSequence: after, types: ["project.deleted"] },
        (real) => ({
          readStoredRows: (input) => {
            readsFrom.push(input.afterSequence);
            return real.readStoredRows(input);
          },
        }),
      );
      const waiting = yield* Effect.forkChild(feed.batch);
      yield* append("skipped-3");
      const deleted = yield* append("filtered-deleted", "project.deleted");
      assert.deepStrictEqual(sequencesOf(yield* Fiber.join(waiting)), [deleted]);
      // The first read covered everything up to the head, so no later read starts below it.
      assert.strictEqual(readsFrom[0], after);
      assert.isTrue(readsFrom.slice(1).every((from) => from >= headBefore));
    }),
  );

  it.effect("reports events T3 pruned before the feed read them, once", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore.OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const after = yield* store.latestApplicationSequence;
      const gone = yield* append("pruned");
      const kept = yield* append("kept-by-pruning");
      yield* sql`DELETE FROM orchestration_events WHERE sequence = ${gone}`;
      yield* sql`
        INSERT INTO orchestration_v2_projection_metadata
          (projection_name, schema_version, last_sequence, updated_at)
        VALUES (${OrchestrationEventStore.EVENT_LOG_PRUNED_THROUGH}, 2, ${kept}, '2026-11-13')
        ON CONFLICT(projection_name) DO UPDATE SET last_sequence = excluded.last_sequence
      `;
      const feed = yield* openFeed({ afterSequence: after });
      const first = yield* feed.batch;
      assert.deepStrictEqual(sequencesOf(first), [kept]);
      assert.deepStrictEqual(first.missed, { afterSequence: after, throughSequence: kept });
      const later = yield* append("later");
      const second = yield* feed.batch;
      assert.deepStrictEqual(sequencesOf(second), [later]);
      assert.isUndefined(second.missed);
    }),
  );

  it.effect("closes its subscription when the plugin stops, without another pull", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore.OrchestrationEventStore;
      const after = yield* store.latestApplicationSequence;
      const released = yield* Deferred.make<void>();
      const feed = yield* openFeed({ afterSequence: after }, (real) => ({
        subscribeCommitted: real.subscribeCommitted.pipe(
          Effect.tap(() => Effect.addFinalizer(() => Deferred.succeed(released, undefined))),
        ),
      }));
      const waiting = yield* Effect.forkChild(feed.next);
      yield* append("wakes-it");
      yield* Fiber.join(waiting);
      // The plugin is busy elsewhere and never asks for the next batch.
      feed.activation.controller.abort();
      yield* Deferred.await(released);
    }),
  );

  it.effect("ends a waiting pull when the plugin deactivates", () =>
    Effect.gen(function* () {
      const feed = yield* openFeed({});
      const waiting = yield* Effect.forkChild(feed.next);
      feed.activation.controller.abort();
      assert.isTrue((yield* Fiber.join(waiting)).done);
    }),
  );
});
