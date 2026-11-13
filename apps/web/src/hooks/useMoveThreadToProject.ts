import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { threadMoveTargets } from "../components/threadActionMenu.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProjects, readThreadShell } from "../state/entities";
import { projectEnvironment } from "../state/projects";
import { environmentServerConfigsAtom } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

/** Where Move to project can send this thread. Empty when its server cannot move threads. */
export function readThreadMoveTargets(
  threadRef: ScopedThreadRef,
): ReadonlyArray<EnvironmentProject> {
  const thread = readThreadShell(threadRef);
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(threadRef.environmentId);
  return thread
    ? threadMoveTargets(thread, readProjects(), config?.environment.capabilities.threadProjectMove)
    : [];
}

/** Moves a thread through the server's ThreadProjectMove and reports the outcome in a toast. */
export function useMoveThreadToProject() {
  const moveThread = useAtomCommand(projectEnvironment.moveThread, { reportFailure: false });
  return async (target: ScopedThreadRef, project: Pick<EnvironmentProject, "id" | "title">) => {
    const result = await moveThread({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, projectId: project.id },
    });
    if (result._tag === "Success") {
      const { scratchFolder } = result.value;
      toastManager.add({
        type: "success",
        title: `Moved to ${project.title}`,
        ...(scratchFolder ? { description: `Earlier files stay in ${scratchFolder}.` } : {}),
      });
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not move thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  };
}
