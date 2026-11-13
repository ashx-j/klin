import {
  CommandId,
  isListedThreadLineage,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ProjectMoveThreadResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";
import * as ProjectService from "./ProjectService.ts";

export class ThreadProjectMoveError extends Schema.TaggedError<ThreadProjectMoveError>()(
  "ThreadProjectMoveError",
  {
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

// Matches how long a settle queued by an agent waits for its turn.
const MOVE_AFTER_RUN_WAIT_MS = 24 * 60 * 60 * 1_000;
const isDispatchError = Schema.is(Orchestrator.OrchestratorDispatchError);
const isMoveError = Schema.is(ThreadProjectMoveError);

export class ThreadProjectMove extends Context.Service<
  ThreadProjectMove,
  {
    /**
     * Shared by the UI, `t3_thread_update` and `t3 thread move`. Side chats and subagents follow.
     * A worktree is kept, so the destination must be its repository; a No project folder is left.
     * An agent moving its own thread mid-turn gets the move once the thread is idle.
     */
    readonly move: (input: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      readonly byOwnAgent: boolean;
    }) => Effect.Effect<ProjectMoveThreadResult, ThreadProjectMoveError>;
  }
>()("t3/project/ThreadProjectMove") {}

const make = Effect.gen(function* () {
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const vcs = yield* VcsDriverRegistry.VcsDriverRegistry;
  const random = yield* SecureRandom.SecureRandom;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const layerScope = yield* Effect.scope;

  const refuse = (reason: string) => new ThreadProjectMoveError({ reason });
  const fail = (reason: string) => (cause: unknown) =>
    new ThreadProjectMoveError({
      // The orchestrator's refusal names the problem, such as a deleted destination.
      reason: isDispatchError(cause) && typeof cause.cause === "string" ? cause.cause : reason,
      cause,
    });

  // Real paths, so a project added through a symlink matches the directory Git reports.
  const gitCommonDir = (cwd: string) =>
    vcs.detect({ cwd }).pipe(
      Effect.orElseSucceed(() => null),
      Effect.flatMap((handle) => {
        if (handle?.kind !== "git" || handle.repository.metadataPath === null) {
          return Effect.succeed(null);
        }
        const dir = path.resolve(cwd, handle.repository.metadataPath);
        return fileSystem.realPath(dir).pipe(Effect.orElseSucceed(() => dir));
      }),
    );

  // Side chats and subagents live in the thread's view and work where it works.
  const followersOf = Effect.fn("ThreadProjectMove.followersOf")(function* (
    thread: OrchestrationV2ThreadShell,
  ) {
    const family = yield* Effect.flatten(threads.readShellSnapshot({ familyOf: thread.id }));
    const members = [...family.threads, ...family.archivedThreads];
    const inside = new Set([thread.id]);
    const followers: Array<OrchestrationV2ThreadShell> = [];
    for (let grew = true; grew;) {
      grew = false;
      for (const member of members) {
        const parent = member.lineage.parentThreadId;
        if (inside.has(member.id) || parent === null || !inside.has(parent)) continue;
        if (isListedThreadLineage(member.lineage)) continue;
        inside.add(member.id);
        grew = true;
        if (member.worktreePath === null || member.worktreePath === thread.worktreePath) {
          followers.push(member);
        }
      }
    }
    return followers;
  });

  const move: ThreadProjectMove["Service"]["move"] = Effect.fn("ThreadProjectMove.move")(
    function* (input) {
      const thread = yield* threads
        .getThreadShell(input.threadId)
        .pipe(Effect.mapError(fail("Could not read the thread.")));
      if (thread === null || thread.deletedAt !== null) {
        return yield* refuse(`Thread ${input.threadId} was not found.`);
      }
      if (!isListedThreadLineage(thread.lineage)) {
        return yield* refuse(
          `Thread ${input.threadId} lives inside its parent thread. Move the parent instead.`,
        );
      }
      if (thread.projectId === input.projectId) {
        // A retry after the thread moved but its tasks did not.
        yield* scheduledTasks
          .moveThreadTasks({ threadIds: [thread.id], projectId: input.projectId })
          .pipe(Effect.mapError(fail("Could not move the thread's scheduled tasks.")));
        return { projectId: input.projectId, worktreePath: thread.worktreePath };
      }
      const target = Option.getOrUndefined(
        yield* projects
          .getById(input.projectId)
          .pipe(Effect.mapError(fail("Could not read the destination project."))),
      );
      if (target === undefined || target.archivedAt != null) {
        return yield* refuse(`No project ${input.projectId}. Pick one from t3_project_list.`);
      }
      // No project's root holds every chat's folder, so a thread cannot work there.
      if (yield* managedFolders.isScratchProject(input.projectId)) {
        return yield* refuse("A thread cannot move into No project. Pick a real project.");
      }
      const scratchFolder =
        thread.worktreePath !== null && (yield* managedFolders.isScratchProject(thread.projectId))
          ? thread.worktreePath
          : undefined;
      if (thread.worktreePath !== null && scratchFolder === undefined) {
        const [worktreeRepo, targetRepo] = yield* Effect.all([
          gitCommonDir(thread.worktreePath),
          gitCommonDir(target.workspaceRoot),
        ]);
        if (worktreeRepo === null || worktreeRepo !== targetRepo) {
          return yield* refuse(
            `Thread ${input.threadId} works in a worktree of another repository than ${target.title}. A worktree thread can only move to a project in the same repository.`,
          );
        }
      }
      const result: ProjectMoveThreadResult = {
        projectId: input.projectId,
        worktreePath: scratchFolder === undefined ? thread.worktreePath : null,
        ...(scratchFolder === undefined ? {} : { scratchFolder }),
      };

      // Checks the whole family first so a busy side chat leaves everything in place.
      const apply = Effect.gen(function* () {
        const members = [...(yield* followersOf(thread)), thread];
        for (const member of members) {
          const records = yield* threads.getThreadRecords(member.id, ["runs", "runtimeRequests"], {
            turnItemTypes: [],
          });
          if (Orchestrator.threadHasUnfinishedWork(records)) {
            return yield* refuse(`"${member.title}" is still working. Finish or stop it first.`);
          }
        }
        yield* Effect.forEach(
          members,
          (member) =>
            Effect.gen(function* () {
              yield* threads.dispatch({
                type: "thread.project.move",
                commandId: CommandId.make(`thread-project-move:${yield* random.uuidV4()}`),
                threadId: member.id,
                projectId: input.projectId,
                clearWorktreePath: scratchFolder !== undefined && member.worktreePath !== null,
              });
            }),
          { discard: true },
        );
        yield* scheduledTasks.moveThreadTasks({
          threadIds: members.map((member) => member.id),
          projectId: input.projectId,
        });
      }).pipe(
        Effect.mapError((cause) =>
          isMoveError(cause) ? cause : fail("Could not move the thread.")(cause),
        ),
        Effect.uninterruptible,
      );

      // The agent asking is the turn that is running, so the move waits for the thread to be idle.
      if (input.byOwnAgent && thread.activeRunId !== null) {
        const runId = thread.activeRunId;
        const attempt = apply.pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        yield* Effect.gen(function* () {
          const { run } = yield* threads.waitForThread({
            projectId: thread.projectId,
            threadId: thread.id,
            runId,
            timeoutMs: MOVE_AFTER_RUN_WAIT_MS,
          });
          if (run?.status !== "completed") {
            return yield* Effect.logInfo(
              "Dropped a queued project move: the turn did not complete",
              {
                threadId: thread.id,
                runId,
              },
            );
          }
          const afterSequence = yield* orchestrator.getThreadEventSequence(thread.id);
          // A queued message may start first; try again whenever a run changes.
          yield* Stream.fromEffect(attempt).pipe(
            Stream.concat(
              orchestrator
                .streamStoredEventsFrom({
                  threadId: thread.id,
                  afterSequence,
                  eventType: "run.updated",
                })
                .pipe(Stream.mapEffect(() => attempt)),
            ),
            Stream.filter((moved) => moved),
            Stream.runHead,
            Effect.timeoutOption(Duration.millis(MOVE_AFTER_RUN_WAIT_MS)),
          );
        }).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(layerScope));
        return { ...result, movesWhenTurnEnds: true as const };
      }
      yield* apply;
      return result;
    },
  );

  return ThreadProjectMove.of({ move });
});

export const layer = Layer.effect(ThreadProjectMove, make);
