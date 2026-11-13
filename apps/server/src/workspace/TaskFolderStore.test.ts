import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, type TaskFolder } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TaskFolderStore from "./TaskFolderStore.ts";

const layer = TaskFolderStore.layer.pipe(
  Layer.provide(Layer.merge(SqlitePersistence.layerMemory, NodeServices.layer)),
);

it.effect("keeps only what the last put of a root recorded", () =>
  Effect.gen(function* () {
    const store = yield* TaskFolderStore.TaskFolderStore;
    const root = "/worktrees/shop/feature";
    const first: TaskFolder = {
      root,
      projectId: ProjectId.make("project:first"),
      projectRoot: "/first/shop",
      anchor: "/first",
      projectPath: `${root}/shop`,
      projectIsWorktree: true,
      repositories: [],
    };
    const second: TaskFolder = {
      root,
      projectId: ProjectId.make("project:second"),
      projectRoot: "/second/shop",
      anchor: "/second/shop",
      projectPath: root,
      projectIsWorktree: false,
      repositories: [
        { repositoryPath: "/second/shop/api", worktreePath: `${root}/api`, name: "api" },
      ],
    };

    yield* store.put(first);
    yield* store.put(second);

    assert.deepEqual(yield* store.list, [second]);
  }).pipe(Effect.provide(layer)),
);
