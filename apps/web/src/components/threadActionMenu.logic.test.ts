import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadActionMenuItems,
  threadMoveTargets,
  type ThreadActionMenuState,
} from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("disables archive, turning into a project and moving while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
      moveTargets: [{ id: ProjectId.make("billing"), title: "billing" }],
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "move-to-project")?.disabled).toBe(true);
  });
});

describe("threadMoveTargets", () => {
  const environmentId = EnvironmentId.make("local");
  const repository = (canonicalKey: string) => ({
    canonicalKey,
    locator: {
      source: "git-remote" as const,
      remoteName: "origin",
      remoteUrl: `https://${canonicalKey}.git`,
    },
  });
  const project = (id: string, extra: object = {}) => ({
    environmentId,
    id: ProjectId.make(id),
    archivedAt: null,
    repositoryIdentity: repository("github.com/acme/app"),
    ...extra,
  });
  const projects = [
    project("app"),
    project("app-docs"),
    project("billing", { repositoryIdentity: repository("github.com/acme/billing") }),
    project("old", { archivedAt: "2026-01-01T00:00:00.000Z" }),
    project("scratch", { isScratch: true as const, repositoryIdentity: null }),
    project("remote", { environmentId: EnvironmentId.make("remote") }),
  ];
  const lineage = {
    parentThreadId: null,
    relationshipToParent: null,
    rootThreadId: ThreadId.make("t"),
  };
  const ids = (thread: { projectId: string; worktreePath: string | null }, supported = true) =>
    threadMoveTargets(
      {
        environmentId,
        projectId: ProjectId.make(thread.projectId),
        worktreePath: thread.worktreePath,
        lineage,
      },
      projects,
      supported,
    ).map((target) => target.id);

  it("lists live projects on the thread's machine, without No project", () => {
    expect(ids({ projectId: "app", worktreePath: null })).toEqual(["app-docs", "billing"]);
    expect(ids({ projectId: "app", worktreePath: null }, false)).toEqual([]);
  });

  it("lists only the same repository for a worktree, but anything for a No project folder", () => {
    expect(ids({ projectId: "app", worktreePath: "/wt/app-fix" })).toEqual(["app-docs"]);
    expect(ids({ projectId: "scratch", worktreePath: "/scratch/plan" })).toEqual([
      "app",
      "app-docs",
      "billing",
    ]);
  });
});
