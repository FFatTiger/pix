/**
 * Production sessiond workspace-flags seam (round 5 redo): the narrow RPC
 * client for `workspace.setFlags` / `workspace.flags.get` plus the shared
 * mutation guard and the AllowedRoots classifier for project keys.
 */
import { SessiondRpcClient } from "@fffattiger/pix-sessiond/client";
import type { MutationGuard } from "../resources/types.js";
import type { AllowedRootService } from "../resources/allowed-roots.js";
import type { WorkspaceFlagsClient, WorkspaceFlagsSeam } from "../routes/workspace-flags.js";

export interface SessiondWorkspaceFlagsSeamOptions {
  endpoint: string;
  secret: string;
  mutationGuard: MutationGuard;
  allowedRoots: AllowedRootService;
}

export function createSessiondWorkspaceFlagsSeam(options: SessiondWorkspaceFlagsSeamOptions): WorkspaceFlagsSeam {
  const client = new SessiondRpcClient({
    endpoint: options.endpoint,
    secret: options.secret,
  });
  const flagsClient: WorkspaceFlagsClient = {
    async getWorkspaceFlags() {
      return client.call("workspace.flags.get", {});
    },
    async setWorkspaceFlags(kind, key, flags) {
      return client.call("workspace.setFlags", {
        kind,
        key,
        ...(flags.pinned === undefined ? {} : { pinned: flags.pinned }),
        ...(flags.archived === undefined ? {} : { archived: flags.archived }),
      });
    },
  };
  return {
    client: flagsClient,
    mutationGuard: options.mutationGuard,
    isAllowedPath: (path) => options.allowedRoots.roots().some((root) => path === root || path.startsWith(`${root}/`)),
  };
}
