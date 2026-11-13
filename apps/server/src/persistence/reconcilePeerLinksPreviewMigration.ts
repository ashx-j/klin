import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import ShellStopRequestIndex from "./Migrations/068_ShellStopRequestIndex.ts";
import ThreadMessageSearch from "./Migrations/069_ThreadMessageSearch.ts";

type MigrationRow = { readonly id: number; readonly name: string };

const PREVIEW_HISTORY = ["PeerLinks", "PeerLinkFence", "WaitingLinkRequestIndex"];

function isPeerLinksPreviewHistory(history: ReadonlyArray<MigrationRow>): boolean {
  const later = history.filter((row) => row.id >= 68).toSorted((a, b) => a.id - b.id);
  return (
    later.length === PREVIEW_HISTORY.length &&
    later.every((row, index) => row.id === 68 + index && row.name === PREVIEW_HISTORY[index])
  );
}

/** The history as startup's peer links preview reconciliation leaves it. */
export function reconciledPeerLinksPreviewHistory(
  history: ReadonlyArray<MigrationRow>,
): ReadonlyArray<MigrationRow> {
  if (!isPeerLinksPreviewHistory(history)) return history;
  return [
    ...history.filter((row) => row.id < 68),
    { id: 68, name: "ShellStopRequestIndex" },
    { id: 69, name: "ThreadMessageSearch" },
    ...PREVIEW_HISTORY.map((name, index) => ({ id: 70 + index, name })),
  ];
}

// v0.1.2 previews recorded main's 70-72 as 68-70. Move them up and run main's 68/69 in their place,
// since the migrator would skip any id below the highest recorded one.
export const reconcilePeerLinksPreviewMigration = Effect.fn("reconcilePeerLinksPreviewMigration")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const tables = yield* sql`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
        `;
        if (tables.length === 0) return [];
        const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
          SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 68
        `;
        if (
          !isPeerLinksPreviewHistory(
            history.map((row) => ({ id: row.migration_id, name: row.name })),
          )
        ) {
          return [];
        }
        yield* ShellStopRequestIndex;
        yield* ThreadMessageSearch;
        // Move the highest id first to avoid a primary-key collision.
        yield* sql`UPDATE effect_sql_migrations SET migration_id = 72 WHERE migration_id = 70`;
        yield* sql`UPDATE effect_sql_migrations SET migration_id = 71 WHERE migration_id = 69`;
        yield* sql`UPDATE effect_sql_migrations SET migration_id = 70 WHERE migration_id = 68`;
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (68, 'ShellStopRequestIndex'), (69, 'ThreadMessageSearch')
        `;
        return [
          [68, "ShellStopRequestIndex"],
          [69, "ThreadMessageSearch"],
        ] as const;
      }),
    );
  },
);
