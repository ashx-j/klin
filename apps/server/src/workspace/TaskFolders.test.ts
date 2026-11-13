import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { type ProjectTrackedFolder, type TaskFolder, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as TaskFolders from "./TaskFolders.ts";
import * as TaskFolderStore from "./TaskFolderStore.ts";
import {
  layerTaskFoldersWithGit,
  taskFoldersTestProjectId as projectId,
  type TaskFoldersTestState,
} from "./TaskFolders.testkit.ts";

const threadId = ThreadId.make("thread:task-folders");

/** `fileSystem` and `layerPath` replace what the service uses; the test's own stay real. */
const layerFor = (
  state: TaskFoldersTestState,
  fileSystem: (real: FileSystem.FileSystem) => FileSystem.FileSystem = (real) => real,
  layerPath: Layer.Layer<Path.Path> = NodePath.layer,
) =>
  layerTaskFoldersWithGit(state).pipe(
    Layer.provide(
      Layer.merge(
        Layer.effect(
          FileSystem.FileSystem,
          Effect.map(Effect.service(FileSystem.FileSystem), fileSystem),
        ),
        layerPath,
      ),
    ),
    Layer.provideMerge(
      GitVcsDriver.layer.pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-task-folders-" })),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  );

const fixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const tmp = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-task-folders-" }),
  );
  const run = (cwd: string, ...args: ReadonlyArray<string>) =>
    git
      .execute({ operation: "task-folders-test", cwd, args })
      .pipe(Effect.map((result) => result.stdout.trim()));
  const repository = Effect.fnUntraced(function* (relative: string) {
    const folder = path.join(tmp, relative);
    yield* fileSystem.makeDirectory(folder, { recursive: true });
    yield* run(folder, "init", "-b", "main");
    yield* run(folder, "config", "user.email", "task-folders@example.test");
    yield* run(folder, "config", "user.name", "Task folders");
    yield* fileSystem.writeFileString(path.join(folder, "README.md"), `${relative}\n`);
    yield* run(folder, "add", ".");
    yield* run(folder, "commit", "-m", "initial");
    return folder;
  });
  const isLink = (target: string) =>
    fileSystem.readLink(target).pipe(Effect.option, Effect.map(Option.isSome));
  const worktreeCount = (folder: string) =>
    run(folder, "worktree", "list", "--porcelain").pipe(
      Effect.map((listed) => listed.split("\n").filter((line) => line.startsWith("worktree "))),
      Effect.map((worktrees) => worktrees.length),
    );
  return { fileSystem, path, tmp, run, repository, isLink, worktreeCount };
});

const tracked = (...folders: ReadonlyArray<string>): ReadonlyArray<ProjectTrackedFolder> =>
  folders.map((folder) => ({ path: folder, name: folder.split("/").at(-1)! }));

const create = Effect.fnUntraced(function* (
  branch: string,
  repositories?: ReadonlyArray<{ readonly path: string }>,
  startFromOrigin = false,
) {
  const taskFolders = yield* TaskFolders.TaskFolders;
  const plan = yield* taskFolders.plan({ projectId, repositories });
  assert.isNotNull(plan);
  return yield* taskFolders.create({
    plan: plan!,
    branch,
    projectStart: { refName: "main", baseRefName: "main" },
    startFromOrigin,
  });
});

const withState = <A, E>(
  test: (
    state: TaskFoldersTestState,
  ) => Effect.Effect<A, E, Layer.Success<ReturnType<typeof layerFor>> | Scope.Scope>,
  fileSystem?: Parameters<typeof layerFor>[1],
) => {
  const state: TaskFoldersTestState = { workspaceRoot: "/unset", trackedFolders: [], thread: null };
  return test(state).pipe(Effect.provide(layerFor(state, fileSystem)), Effect.scoped);
};

it.live("lays a plain wrapper out as links around its repositories' worktrees", () =>
  withState((state) =>
    Effect.gen(function* () {
      const { fileSystem, path, tmp, run, repository, isLink } = yield* fixture;
      const shop = path.join(tmp, "shop");
      const api = yield* repository("shop/services/api");
      const web = yield* repository("shop/web");
      const unpicked = yield* repository("shop/unpicked");
      yield* repository("shop/untracked");
      yield* fileSystem.makeDirectory(path.join(shop, "notes"));
      yield* fileSystem.makeDirectory(path.join(shop, ".git-not"));
      yield* fileSystem.writeFileString(path.join(shop, "AGENTS.md"), "root rules\n");
      yield* fileSystem.writeFileString(path.join(shop, "services", "README.md"), "services\n");
      state.workspaceRoot = shop;
      state.trackedFolders = tracked(api, web, unpicked, path.join(shop, "notes"));

      const { taskFolder, branch } = yield* create("feature", [{ path: api }, { path: web }]);
      const root = taskFolder.root;

      assert.equal(branch, "feature");
      assert.deepEqual(
        { ...taskFolder, repositories: taskFolder.repositories.toSorted(byName) },
        {
          root,
          projectId,
          projectRoot: shop,
          anchor: shop,
          projectPath: root,
          projectIsWorktree: false,
          repositories: [
            {
              repositoryPath: api,
              worktreePath: path.join(root, "services", "api"),
              name: "api",
            },
            { repositoryPath: web, worktreePath: path.join(root, "web"), name: "web" },
          ],
        },
      );
      // Shared with the original, never copied.
      assert.equal(
        yield* fileSystem.readLink(path.join(root, "AGENTS.md")),
        path.join(shop, "AGENTS.md"),
      );
      assert.isTrue(yield* isLink(path.join(root, "notes")));
      // The folder leading to a repository is real, and still shows what else it holds.
      assert.isFalse(yield* isLink(path.join(root, "services")));
      assert.isTrue(yield* isLink(path.join(root, "services", "README.md")));
      // A repository without a worktree is absent, tracked or not: a link would be the original.
      assert.isFalse(yield* fileSystem.exists(path.join(root, "unpicked")));
      assert.isFalse(yield* fileSystem.exists(path.join(root, "untracked")));
      assert.isFalse(yield* fileSystem.exists(path.join(root, ".git")));
      for (const worktree of [path.join(root, "services", "api"), path.join(root, "web")]) {
        assert.equal(yield* run(worktree, "symbolic-ref", "--short", "HEAD"), "feature");
      }
      assert.deepEqual(
        yield* (yield* TaskFolders.TaskFolders).find(path.join(root, "web", "src")),
        taskFolder,
      );
    }),
  ),
);

const byName = (left: { readonly name: string }, right: { readonly name: string }) =>
  left.name.localeCompare(right.name);

it.live("keeps a Git project and its sibling repository side by side", () =>
  withState((state) =>
    Effect.gen(function* () {
      const { path, run, repository, worktreeCount } = yield* fixture;
      const ctx = yield* repository("x/ctx");
      const app = yield* repository("x/app");
      state.workspaceRoot = ctx;
      state.trackedFolders = tracked(app);

      const { taskFolder } = yield* create("feature");

      assert.equal(taskFolder.anchor, path.dirname(ctx));
      assert.equal(taskFolder.projectPath, path.join(taskFolder.root, "ctx"));
      assert.isTrue(taskFolder.projectIsWorktree);
      assert.deepEqual(taskFolder.repositories, [
        { repositoryPath: app, worktreePath: path.join(taskFolder.root, "app"), name: "app" },
      ]);
      // `../app` from the thread's folder is the thread's own checkout of it.
      assert.equal(
        yield* run(
          path.join(taskFolder.projectPath, "..", "app"),
          "symbolic-ref",
          "--short",
          "HEAD",
        ),
        "feature",
      );
      assert.equal(
        yield* run(taskFolder.projectPath, "symbolic-ref", "--short", "HEAD"),
        "feature",
      );
      assert.equal(yield* worktreeCount(ctx), 2);
    }),
  ),
);

it.live.each([{ projectIsRepository: true }, { projectIsRepository: false }])(
  "answers an existing thread's worktree request with a task folder, project is a repository=$projectIsRepository",
  ({ projectIsRepository }) =>
    withState((state) =>
      Effect.gen(function* () {
        const { path, tmp, run, repository } = yield* fixture;
        const shop = projectIsRepository ? yield* repository("shop") : path.join(tmp, "shop");
        const api = yield* repository("shop/api");
        const web = yield* repository("web");
        state.workspaceRoot = shop;
        state.trackedFolders = tracked(api, web);
        const taskFolders = yield* TaskFolders.TaskFolders;
        const request = { cwd: shop, refName: "main", newRefName: "feature", path: null };

        const created = yield* taskFolders.createForProjectFolder(request);

        const taskFolder = yield* taskFolders.find(created!.worktree.path);
        assert.deepEqual(created, {
          worktree: { path: taskFolder!.projectPath, refName: "feature" },
        });
        assert.equal(taskFolder!.projectIsWorktree, projectIsRepository);
        assert.sameMembers(
          taskFolder!.repositories.map((entry) => entry.repositoryPath),
          [api, web],
        );
        for (const worktree of [
          ...(projectIsRepository ? [taskFolder!.projectPath] : []),
          ...taskFolder!.repositories.map((entry) => entry.worktreePath),
        ]) {
          assert.equal(yield* run(worktree, "symbolic-ref", "--short", "HEAD"), "feature");
        }
        // A chosen path, an existing branch and a folder that is no project stay single worktrees.
        for (const single of [
          { ...request, path: path.join(tmp, "elsewhere") },
          { cwd: shop, refName: "main", path: null },
          { ...request, cwd: web },
        ]) {
          assert.isNull(yield* taskFolders.createForProjectFolder(single));
        }
      }),
    ),
);

it.live("puts a clone the project ignores inside the project's worktree", () =>
  withState((state) =>
    Effect.gen(function* () {
      const { fileSystem, path, run, repository } = yield* fixture;
      const project = yield* repository("p");
      yield* fileSystem.writeFileString(path.join(project, ".gitignore"), "vendor/\n");
      yield* run(project, "add", ".");
      yield* run(project, "commit", "-m", "ignore vendor");
      const lib = yield* repository("p/vendor/lib");
      state.workspaceRoot = project;
      state.trackedFolders = tracked(lib);

      const { taskFolder } = yield* create("feature");

      assert.equal(taskFolder.projectPath, taskFolder.root);
      assert.equal(
        taskFolder.repositories[0]?.worktreePath,
        path.join(taskFolder.root, "vendor", "lib"),
      );
      assert.equal(
        yield* run(path.join(taskFolder.root, "vendor", "lib"), "symbolic-ref", "--short", "HEAD"),
        "feature",
      );
      assert.equal(yield* run(taskFolder.root, "status", "--porcelain"), "");
    }),
  ),
);

it.live("treats a project folder inside a larger repository as plain", () =>
  withState((state) =>
    Effect.gen(function* () {
      const { fileSystem, path, repository, worktreeCount } = yield* fixture;
      const big = yield* repository("big");
      const pkg = path.join(big, "pkg");
      const tool = yield* repository("big/pkg/tool");
      yield* fileSystem.writeFileString(path.join(pkg, "notes.md"), "notes\n");
      state.workspaceRoot = pkg;
      state.trackedFolders = tracked(tool);

      const { taskFolder } = yield* create("feature");

      assert.isFalse(taskFolder.projectIsWorktree);
      assert.equal(taskFolder.projectPath, taskFolder.root);
      assert.isFalse(yield* fileSystem.exists(path.join(taskFolder.root, ".git")));
      assert.equal(
        yield* fileSystem.readLink(path.join(taskFolder.root, "notes.md")),
        path.join(pkg, "notes.md"),
      );
      // The parent repository is never checked out.
      assert.equal(yield* worktreeCount(big), 1);
      assert.equal(yield* worktreeCount(tool), 2);
    }),
  ),
);

it.live("never shares a folder another creation reserved first", () => {
  let theirs: string | undefined;
  // Another creation takes the folder this one picked, just before this one makes it.
  const racing = (real: FileSystem.FileSystem): FileSystem.FileSystem => ({
    ...real,
    makeDirectory: (target, options) =>
      Effect.suspend(() => {
        if (theirs !== undefined || !/[\\/]feature-[0-9a-f]{16}$/.test(target))
          return real.makeDirectory(target, options);
        theirs = target;
        return real
          .makeDirectory(target, { recursive: true })
          .pipe(
            Effect.andThen(real.writeFileString(`${target}/theirs.md`, "theirs\n")),
            Effect.andThen(real.makeDirectory(target, options)),
          );
      }),
  });
  return withState(
    (state) =>
      Effect.gen(function* () {
        const { fileSystem, path, tmp, repository } = yield* fixture;
        const api = yield* repository("shop/api");
        state.workspaceRoot = path.join(tmp, "shop");
        state.trackedFolders = tracked(api);

        const { taskFolder } = yield* create("feature");

        assert.isDefined(theirs);
        assert.notEqual(taskFolder.root, theirs);
        assert.deepEqual(yield* fileSystem.readDirectory(theirs!), ["theirs.md"]);
      }),
    racing,
  );
});

it.live("gives every repository one branch name when one of them already has it", () =>
  withState((state) =>
    Effect.gen(function* () {
      const { path, tmp, run, repository } = yield* fixture;
      const api = yield* repository("shop/api");
      const web = yield* repository("shop/web");
      yield* run(web, "branch", "feature");
      state.workspaceRoot = path.join(tmp, "shop");
      state.trackedFolders = tracked(api, web);

      const { taskFolder, branch } = yield* create("feature");

      assert.equal(branch, "feature-2");
      for (const repositoryWorktree of taskFolder.repositories) {
        assert.equal(
          yield* run(repositoryWorktree.worktreePath, "symbolic-ref", "--short", "HEAD"),
          "feature-2",
        );
      }
      assert.deepEqual((yield* run(api, "branch", "--format=%(refname:short)")).split("\n"), [
        "feature-2",
        "main",
      ]);

      const renamed = yield* (yield* TaskFolders.TaskFolders).renameBranch({
        root: taskFolder.root,
        oldBranch: "feature-2",
        // Taken in `web` only, so every checkout moves past it together.
        newBranch: "feature",
      });
      assert.equal(renamed.branch, "feature-2");
      yield* run(api, "branch", "fix-login");
      assert.deepEqual(
        yield* (yield* TaskFolders.TaskFolders).renameBranch({
          root: taskFolder.root,
          oldBranch: "feature-2",
          newBranch: "fix-login",
        }),
        { branch: "fix-login-2" },
      );
      assert.equal(
        yield* run(path.join(taskFolder.root, "web"), "symbolic-ref", "--short", "HEAD"),
        "fix-login-2",
      );
    }),
  ),
);

it.live("reports whether a repository started from the commit its remote has", () =>
  withState((state) =>
    Effect.gen(function* () {
      const { path, tmp, run, repository } = yield* fixture;
      const api = yield* repository("shop/api");
      const remote = path.join(tmp, "api.git");
      yield* run(tmp, "init", "--bare", "-b", "main", remote);
      yield* run(api, "remote", "add", "origin", remote);
      yield* run(api, "push", "-u", "origin", "main");
      yield* run(api, "commit", "--allow-empty", "-m", "local only");
      state.workspaceRoot = path.join(tmp, "shop");
      state.trackedFolders = tracked(api);

      const { taskFolder, startedFromOrigin } = yield* create("feature", undefined, true);

      assert.isTrue(startedFromOrigin);
      assert.equal(
        yield* run(taskFolder.repositories[0]!.worktreePath, "rev-parse", "HEAD"),
        yield* run(api, "rev-parse", "origin/main"),
      );
    }),
  ),
);

it.live("removes what it created when one repository fails", () =>
  withState((state) =>
    Effect.gen(function* () {
      const { fileSystem, path, tmp, run, repository, worktreeCount } = yield* fixture;
      const api = yield* repository("shop/api");
      // No commit yet, so no branch can start there.
      const empty = path.join(tmp, "shop", "empty");
      yield* fileSystem.makeDirectory(empty);
      yield* run(empty, "init", "-b", "main");
      yield* fileSystem.writeFileString(path.join(tmp, "shop", "AGENTS.md"), "rules\n");
      state.workspaceRoot = path.join(tmp, "shop");
      state.trackedFolders = tracked(api, empty);
      const config = yield* ServerConfig.ServerConfig;

      const error = yield* create("feature").pipe(Effect.flip);

      assert.include(String((error as { readonly detail?: string }).detail), "empty worktree");
      assert.equal(yield* worktreeCount(api), 1);
      assert.equal(yield* run(api, "branch", "--format=%(refname:short)"), "main");
      assert.deepEqual(yield* fileSystem.readDirectory(path.join(config.worktreesDir, "shop")), []);
      assert.deepEqual(yield* (yield* TaskFolderStore.TaskFolderStore).list, []);
      assert.isTrue(yield* fileSystem.exists(path.join(tmp, "shop", "AGENTS.md")));
    }),
  ),
);

it.live("records every checkout before making one, so a restart midway leaves none unknown", () =>
  withState((state) =>
    Effect.gen(function* () {
      const { path, tmp, repository } = yield* fixture;
      const taskFolders = yield* TaskFolders.TaskFolders;
      state.workspaceRoot = path.join(tmp, "shop");
      state.trackedFolders = tracked(yield* repository("shop/api"), yield* repository("shop/web"));
      const claimed: Array<TaskFolder | null> = [];

      const { taskFolder } = yield* taskFolders.create({
        plan: (yield* taskFolders.plan({ projectId }))!,
        branch: "feature",
        projectStart: { refName: "main", baseRefName: "main" },
        startFromOrigin: false,
        onClaimed: (folder) =>
          taskFolders.find(folder.root).pipe(
            Effect.orDie,
            Effect.map((found) => claimed.push(found)),
          ),
      });

      assert.lengthOf(taskFolder.repositories, 2);
      assert.deepEqual(claimed, [taskFolder]);
    }),
  ),
);

it.live("selects every tracked repository up to eight and none beyond", () =>
  withState((state) =>
    Effect.gen(function* () {
      const { fileSystem, path, tmp } = yield* fixture;
      const taskFolders = yield* TaskFolders.TaskFolders;
      const folders = Array.from({ length: 9 }, (_, index) => path.join(tmp, "shop", `r${index}`));
      for (const folder of folders) {
        yield* fileSystem.makeDirectory(path.join(folder, ".git"), { recursive: true });
      }
      const plain = path.join(tmp, "shop", "notes");
      yield* fileSystem.makeDirectory(plain);
      state.workspaceRoot = path.join(tmp, "shop");

      state.trackedFolders = tracked(plain);
      assert.isNull(yield* taskFolders.plan({ projectId }));

      state.trackedFolders = tracked(...folders.slice(0, 8), plain);
      assert.lengthOf((yield* taskFolders.plan({ projectId }))!.repositories, 8);

      state.trackedFolders = tracked(...folders, plain);
      assert.lengthOf((yield* taskFolders.plan({ projectId }))!.repositories, 0);
      const chosen = yield* taskFolders.plan({
        projectId,
        repositories: [{ path: folders[8]! }, { path: `${folders[8]!}${path.sep}` }],
      });
      assert.deepEqual(chosen?.repositories, [{ name: "r8", path: folders[8]! }]);
      assert.isFalse(chosen?.projectIsRepository);

      for (const [requested, detail] of [
        [path.join(tmp, "shop", "untracked"), "is not a tracked folder"],
        [plain, "is not a Git repository"],
      ] as const) {
        const error = yield* taskFolders
          .plan({ projectId, repositories: [{ path: requested }] })
          .pipe(Effect.flip);
        assert.include(error.detail, detail);
      }
    }),
  ),
);

it.effect(
  "lays out from the folder the project shares with its repositories, none across drives",
  () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      assert.equal(
        TaskFolders.commonAncestor(path, ["C:\\shop", "C:\\shop\\api", "C:\\web"]),
        "C:\\",
      );
      assert.isNull(TaskFolders.commonAncestor(path, ["C:\\shop", "D:\\api"]));
      assert.isNull(TaskFolders.commonAncestor(path, ["\\\\server\\one\\shop", "C:\\api"]));
    }).pipe(Effect.provide(NodePath.layerWin32)),
);

it.effect("plans around a tracked repository on another drive that the task folder leaves out", () => {
  const state: TaskFoldersTestState = {
    workspaceRoot: "C:\\shop",
    trackedFolders: [
      { path: "C:\\shop\\api", name: "api" },
      { path: "D:\\tools", name: "tools" },
    ],
    thread: null,
  };
  const repositories = new Set(["C:\\shop\\api\\.git", "D:\\tools\\.git"]);
  const windows = (real: FileSystem.FileSystem): FileSystem.FileSystem => ({
    ...real,
    exists: (target) => Effect.succeed(repositories.has(target)),
  });
  return Effect.gen(function* () {
    const taskFolders = yield* TaskFolders.TaskFolders;

    const plan = yield* taskFolders.plan({ projectId, repositories: [{ path: "C:\\shop\\api" }] });

    assert.equal(plan?.anchor, "C:\\shop");
    const error = yield* taskFolders
      .plan({ projectId, repositories: [{ path: "D:\\tools" }] })
      .pipe(Effect.flip);
    assert.include(error.detail, "share no folder");
  }).pipe(Effect.provide(layerFor(state, windows, NodePath.layerWin32)), Effect.scoped);
});

it.live("adds a repository to an existing task folder on the thread's branch", () =>
  withState((state) =>
    Effect.gen(function* () {
      const { fileSystem, path, tmp, run, repository, isLink } = yield* fixture;
      const taskFolders = yield* TaskFolders.TaskFolders;
      const shop = path.join(tmp, "shop");
      const api = yield* repository("shop/api");
      const web = yield* repository("shop/web");
      const late = yield* repository("shop/tools/late");
      const taken = yield* repository("shop/taken");
      yield* fileSystem.writeFileString(path.join(shop, "tools", "run.sh"), "#!/bin/sh\n");
      state.workspaceRoot = shop;
      // `late` and `taken` are tracked only after the task folder exists.
      state.trackedFolders = tracked(api, web);
      const { taskFolder } = yield* create("feature", [{ path: api }]);
      const root = taskFolder.root;
      assert.isTrue(yield* isLink(path.join(root, "tools")));
      state.thread = { worktreePath: root, branch: "feature" };
      state.trackedFolders = tracked(api, web, late, taken);

      const withWeb = yield* taskFolders.addRepository({ threadId, repositoryPath: web });
      assert.deepEqual(
        withWeb.repositories.map((entry) => entry.worktreePath),
        [path.join(root, "api"), path.join(root, "web")],
      );
      assert.equal(
        yield* run(path.join(root, "web"), "symbolic-ref", "--short", "HEAD"),
        "feature",
      );

      // The link that stood for `tools` becomes a folder: the worktree, and links to the rest.
      yield* taskFolders.addRepository({ threadId, repositoryPath: late });
      assert.isFalse(yield* isLink(path.join(root, "tools")));
      assert.equal(
        yield* fileSystem.readLink(path.join(root, "tools", "run.sh")),
        path.join(shop, "tools", "run.sh"),
      );
      assert.equal(
        yield* run(path.join(root, "tools", "late"), "symbolic-ref", "--short", "HEAD"),
        "feature",
      );
      assert.equal(yield* run(late, "symbolic-ref", "--short", "HEAD"), "main");

      // A folder the thread filled is not one this service made.
      yield* fileSystem.makeDirectory(path.join(root, "taken"));
      yield* fileSystem.writeFileString(path.join(root, "taken", "draft.md"), "mine\n");
      for (const [repositoryPath, detail] of [
        [taken, "already holds files"],
        [web, "already has a worktree"],
        [path.join(shop, "nowhere"), "is not a tracked folder"],
      ] as const) {
        const error = yield* taskFolders
          .addRepository({ threadId, repositoryPath })
          .pipe(Effect.flip);
        assert.include(error.detail, detail);
      }
      assert.lengthOf((yield* taskFolders.find(root))!.repositories, 3);
    }),
  ),
);

it.live("puts a task folder back with a worktree for every repository it recorded", () =>
  withState((state) =>
    Effect.gen(function* () {
      const { fileSystem, path, tmp, run, repository, isLink } = yield* fixture;
      const taskFolders = yield* TaskFolders.TaskFolders;
      const shop = path.join(tmp, "shop");
      const api = yield* repository("shop/services/api");
      const web = yield* repository("shop/web");
      yield* fileSystem.writeFileString(path.join(shop, "AGENTS.md"), "rules\n");
      yield* fileSystem.writeFileString(path.join(shop, "services", "README.md"), "services\n");
      state.workspaceRoot = shop;
      state.trackedFolders = tracked(api, web);
      const { taskFolder } = yield* create("feature");
      const root = taskFolder.root;
      const restore = taskFolders.restore({
        taskFolder,
        recreate: (checkout) =>
          run(checkout.repositoryPath, "worktree", "add", checkout.worktreePath, "feature"),
      });

      // Cleanup keeps a repository with uncommitted work, and the folders that hold it.
      yield* fileSystem.writeFileString(path.join(root, "services", "api", "a.md"), "draft\n");
      yield* taskFolders.remove({ root, force: false, forget: false });
      assert.isFalse(yield* fileSystem.exists(path.join(root, "AGENTS.md")));
      yield* restore;
      for (const entry of ["AGENTS.md", path.join("services", "README.md")]) {
        assert.equal(yield* fileSystem.readLink(path.join(root, entry)), path.join(shop, entry));
      }
      assert.equal(
        yield* run(path.join(root, "web"), "symbolic-ref", "--short", "HEAD"),
        "feature",
      );

      // Cleanup keeps the record of a folder it removes; the project then stops tracking `api`.
      yield* taskFolders.remove({ root, force: true, forget: false });
      state.trackedFolders = tracked(web);
      yield* restore;

      assert.isFalse(yield* isLink(path.join(root, "services")));
      assert.equal(
        yield* run(path.join(root, "services", "api"), "symbolic-ref", "--short", "HEAD"),
        "feature",
      );
      assert.equal(yield* run(api, "symbolic-ref", "--short", "HEAD"), "main");
    }),
  ),
);

it.live("keeps a repository git will not remove and removes the rest", () =>
  withState((state) =>
    Effect.gen(function* () {
      const { fileSystem, path, tmp, repository, worktreeCount } = yield* fixture;
      const taskFolders = yield* TaskFolders.TaskFolders;
      const shop = path.join(tmp, "shop");
      const api = yield* repository("shop/api");
      const web = yield* repository("shop/web");
      yield* fileSystem.writeFileString(path.join(shop, "AGENTS.md"), "rules\n");
      state.workspaceRoot = shop;
      state.trackedFolders = tracked(api, web);
      const { taskFolder } = yield* create("feature");
      const root = taskFolder.root;
      yield* fileSystem.writeFileString(path.join(root, "api", "README.md"), "uncommitted\n");

      const first = yield* taskFolders.remove({ root, force: false, forget: true });

      assert.deepEqual(first.removed, [path.join(root, "web")]);
      assert.deepEqual(
        first.kept.map((entry) => entry.path),
        [path.join(root, "api")],
      );
      assert.equal(
        yield* fileSystem.readFileString(path.join(root, "api", "README.md")),
        "uncommitted\n",
      );
      assert.equal(yield* worktreeCount(web), 1);
      // The record now lists only what is still on disk.
      assert.deepEqual(
        (yield* taskFolders.find(root))?.repositories.map((entry) => entry.repositoryPath),
        [api],
      );

      const second = yield* taskFolders.remove({ root, force: true, forget: true });

      assert.deepEqual(second.kept, []);
      assert.isFalse(yield* fileSystem.exists(root));
      assert.isNull(yield* taskFolders.find(root));
      assert.equal(yield* worktreeCount(api), 1);
      // Links went; what they pointed at did not.
      assert.equal(yield* fileSystem.readFileString(path.join(shop, "AGENTS.md")), "rules\n");
    }),
  ),
);
