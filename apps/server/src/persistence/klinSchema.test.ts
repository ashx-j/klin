import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { hasPendingMigrations, migrationManifest, runMigrations } from "./Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("ensureKlinSchema", (it) => {
  it.effect("adds Klin's schema without a numbered migration, and again is a no-op", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // A CLI migrates only while it owns the database, so missing Klin schema counts as pending.
      yield* runMigrations({ toMigrationInclusive: migrationManifest.at(-1)![0] });
      assert.isTrue(yield* hasPendingMigrations());
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.isFalse(yield* hasPendingMigrations());
      const recorded = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        recorded.map((row) => [row.migration_id, row.name]),
        migrationManifest.map(([id, name]) => [id, name]),
      );
      yield* sql`
        INSERT INTO projection_projects
          (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES ('project', 'repo', '/tmp/repo', '[]', '2026-11-13', '2026-11-13')
      `;
      assert.deepStrictEqual(yield* sql`SELECT tracked_folders_json FROM projection_projects`, [
        { tracked_folders_json: "[]" },
      ]);
      assert.deepStrictEqual(yield* sql`SELECT COUNT(*) AS count FROM task_folders`, [
        { count: 0 },
      ]);
    }),
  );
});
