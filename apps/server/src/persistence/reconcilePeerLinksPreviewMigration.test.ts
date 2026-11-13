import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import PeerLinks from "./Migrations/070_PeerLinks.ts";
import PeerLinkFence from "./Migrations/071_PeerLinkFence.ts";
import WaitingLinkRequestIndex from "./Migrations/072_WaitingLinkRequestIndex.ts";

const seedPreview = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 67 });
  yield* Migrator.make({})({
    loader: Migrator.fromRecord({
      "68_PeerLinks": PeerLinks,
      "69_PeerLinkFence": PeerLinkFence,
      "70_WaitingLinkRequestIndex": WaitingLinkRequestIndex,
    }),
  });
  yield* sql`
    INSERT INTO peer_environment_links
      (environment_id, secret_name, label, urls_json, access, linked_at, expires_at, fenced)
    VALUES ('peer', 'peer-secret', 'Laptop', '[]', 'full', '2026-10-22', '2026-11-22', 1)
  `;
});

describe("v0.1.2 peer links preview upgrade", () => {
  it.effect("moves the preview's peer links from 68-70 to 70-72 and keeps them", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedPreview;
      const links = yield* sql`SELECT * FROM peer_environment_links`;
      const executed = yield* runMigrations();
      assert.deepStrictEqual(executed.slice(0, 3), [
        [68, "ShellStopRequestIndex"],
        [69, "ThreadMessageSearch"],
        [73, "ActiveTurnItemIndexes"],
      ]);
      assert.deepStrictEqual(yield* runMigrations(), []);
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        history.map((row) => [row.migration_id, row.name] as const),
        migrationManifest,
      );
      assert.deepStrictEqual(yield* sql`SELECT * FROM peer_environment_links`, links);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("leaves the preview history alone when migrating to an earlier id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedPreview;
      yield* runMigrations({ toMigrationInclusive: 60 });
      assert.deepStrictEqual(
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 68`,
        [
          { migration_id: 68, name: "PeerLinks" },
          { migration_id: 69, name: "PeerLinkFence" },
          { migration_id: 70, name: "WaitingLinkRequestIndex" },
        ],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
