import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Schema for Klin's port of upstream's unmerged multi-repo projects (pingdotgg/t3code#35921 and
 * its stack). A Klin-numbered migration would take ids upstream later uses, and the migrator then
 * refuses to start, so this runs after the numbered migrations and adds only what is missing.
 * When upstream's own migrations for this schema land, guard them during the merge and delete this.
 */
export const ensureKlinSchema = Effect.fn("ensureKlinSchema")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projectColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  if (!projectColumns.some((column) => column.name === "tracked_folders_json")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN tracked_folders_json TEXT NOT NULL DEFAULT '[]'
    `;
  }
});
