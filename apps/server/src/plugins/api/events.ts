import type {
  PluginApi,
  PluginStoredEvent,
  PluginStoredEventBatch,
} from "@t3tools/plugin-sdk/server";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type * as OrchestrationEventStore from "../../persistence/OrchestrationEventStore.ts";
import type { FacadeContext } from "./facade.ts";

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 500;
const MAX_TYPES = 64;
// One read covers at most this many sequences, so a filter that matches rarely never scans the
// whole table in one query.
const MAX_SCAN_SEQUENCES = 10_000;
// Payloads hold whole tool outputs, so a batch also stops by size and its memory stays bounded.
const MAX_BATCH_CHARS = 4 * 1024 * 1024;

const toPluginEvent = (row: OrchestrationEventStore.StoredEventRow): PluginStoredEvent => ({
  sequence: row.sequence,
  id: row.eventId,
  type: row.eventType,
  aggregate: row.aggregateKind,
  streamId: row.streamId,
  occurredAt: row.occurredAt,
  commandId: row.commandId,
  payloadJson: row.payloadJson,
  metadataJson: row.metadataJson,
});

const checkOptions = (options: Parameters<PluginApi["events"]["stored"]>[0]) => {
  const { afterSequence, batchSize, types } = options ?? {};
  if (afterSequence !== undefined && (!Number.isSafeInteger(afterSequence) || afterSequence < 0)) {
    throw new RangeError("afterSequence must be a whole number of 0 or more.");
  }
  if (
    batchSize !== undefined &&
    (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE)
  ) {
    throw new RangeError(`batchSize must be a whole number from 1 to ${MAX_BATCH_SIZE}.`);
  }
  if (
    types !== undefined &&
    (!Array.isArray(types) ||
      types.length === 0 ||
      types.length > MAX_TYPES ||
      types.some((type) => typeof type !== "string"))
  ) {
    throw new TypeError(`types must be a list of 1 to ${MAX_TYPES} event types.`);
  }
};

/**
 * The read-only event feed. It reads pages from the store's reader connection only when the plugin
 * pulls, and keeps no events in memory between pulls, so a slow plugin falls behind on its own and
 * never holds up commits or other readers. While caught up it waits for a commit, through a
 * one-slot queue that every commit refills.
 */
export const makeEventsApi = (
  facade: FacadeContext,
  eventStore: OrchestrationEventStore.OrchestrationEventStore["Service"],
): PluginApi["events"] => ({
  stored: (options) => {
    checkOptions(options);
    const batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE;
    const types = options?.types === undefined ? undefined : [...new Set(options.types)];
    const stream = Stream.unwrap(
      Effect.gen(function* () {
        // Subscribed before the first read, so a commit right after a read that found nothing
        // still wakes the feed.
        const committed = yield* eventStore.subscribeCommitted;
        const wake = yield* Queue.sliding<void>(1);
        yield* PubSub.take(committed).pipe(
          Effect.andThen(Queue.offer(wake, undefined)),
          Effect.forever,
          Effect.forkScoped,
        );
        let cursor = options?.afterSequence ?? (yield* eventStore.latestApplicationSequence);
        // The newest pruned sequence already reported, so each deletion is reported once.
        let reported = cursor;
        const nextBatch = Effect.gen(function* () {
          while (true) {
            // Every row up to the head is committed, so a page that ends short covers the whole
            // range it read. The cursor then passes rows `types` left out instead of reading them
            // again after each commit, and each read covers a bounded range.
            const head = yield* eventStore.latestApplicationSequence;
            const through = Math.min(head, cursor + MAX_SCAN_SEQUENCES);
            const rows =
              through <= cursor
                ? []
                : yield* eventStore.readStoredRows({
                    afterSequence: cursor,
                    throughSequence: through,
                    limit: batchSize,
                    ...(types === undefined ? {} : { eventTypes: types }),
                  });
            // Read after the rows: a prune between the two reads is reported, never missed.
            const prunedThrough = yield* eventStore.prunedThroughSequence;
            const missed =
              prunedThrough > Math.max(cursor, reported)
                ? { afterSequence: Math.max(cursor, reported), throughSequence: prunedThrough }
                : undefined;
            if (missed !== undefined) reported = prunedThrough;
            const events: Array<PluginStoredEvent> = [];
            let chars = 0;
            for (const row of rows) {
              chars += row.payloadJson.length + row.metadataJson.length;
              if (events.length > 0 && chars > MAX_BATCH_CHARS) break;
              events.push(toPluginEvent(row));
            }
            cursor =
              events.length === rows.length && rows.length < batchSize
                ? Math.max(cursor, through)
                : (events.at(-1)?.sequence ?? cursor);
            if (events.length > 0 || missed !== undefined) {
              const batch: PluginStoredEventBatch =
                missed === undefined
                  ? { events, resumeAfter: cursor }
                  : { events, resumeAfter: cursor, missed };
              return batch;
            }
            if (cursor < head) continue;
            yield* Queue.take(wake);
          }
        });
        return Stream.fromEffectRepeat(nextBatch);
      }),
    );
    return facade.iterate(stream, options?.signal);
  },
});
