// Pure helpers over the normalized session branch tree DTO
// (GET /v1/sessions/:id/tree) for the BranchNavigator slice. No UI, no
// network, no runtime imports — only strict DTO traversal.
//
// Frozen leaf semantics (mirrors the server contract in
// packages/protocol/src/domain.ts):
// - The tree's `currentLeafId` is the PERSISTED catalog head (exactly the leaf
//   a leaf-less context read resolves). It is the history-mode default.
// - History mode selects an explicit leaf via `sessions.context?leafId` and
//   passes it here as `selectedLeafId`.
// - LIVE mode must take the active leaf from the runtime snapshot
//   (`RuntimeState.leafId`), because a live runtime can hold an in-memory
//   navigated leaf that has not been persisted — the catalog tree never
//   fabricates it. Callers override with the snapshot value; nothing here
//   reads runtime state.
import type { SessionTree, SessionTreeNode } from "@fffattiger/pix-protocol";

export type { SessionTree, SessionTreeNode };

/**
 * Find the path of nodes from a root to the node that carries `targetId`
 * (either as its own entryId or inside a contracted `skippedEntryIds`
 * chain). Iterative — never recurses, so a malformed deep tree cannot
 * overflow. Returns `null` when the id is not present in the tree.
 */
export function findTreeNodePath(
  roots: readonly SessionTreeNode[],
  targetId: string | null | undefined,
): readonly SessionTreeNode[] | null {
  if (targetId === null || targetId === undefined || targetId === "") return null;
  // Depth-first with an explicit stack; each frame carries its own path
  // (branch trees are shallow — the server contracts linear chains and caps
  // depth at 200).
  const stack: { node: SessionTreeNode; path: SessionTreeNode[] }[] = roots.map((node) => ({
    node,
    path: [node],
  }));
  const visited = new Set<string>();
  while (stack.length > 0) {
    const { node, path } = stack.pop()!;
    if (visited.has(node.entryId)) continue; // malformed-cycle defense
    visited.add(node.entryId);
    if (node.entryId === targetId || node.skippedEntryIds?.includes(targetId)) return path;
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) stack.push({ node: child, path: [...path, child] });
    }
  }
  return null;
}

/**
 * Entry ids on the visible path root → the node carrying `targetId` (the
 * node's own id plus its contracted chain ids). Drives active-path
 * highlighting; empty when the target is not in the tree.
 */
export function activePathEntryIds(
  roots: readonly SessionTreeNode[],
  targetId: string | null | undefined,
): ReadonlySet<string> {
  const path = findTreeNodePath(roots, targetId);
  if (path === null) return new Set();
  const ids = new Set<string>();
  for (const node of path) {
    ids.add(node.entryId);
    for (const skipped of node.skippedEntryIds ?? []) ids.add(skipped);
  }
  return ids;
}

/**
 * Whether the tree has any branch point (a node with more than one child).
 * A purely linear session renders no branch navigator.
 */
export function hasBranchPoint(roots: readonly SessionTreeNode[]): boolean {
  const stack = [...roots];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (visited.has(node.entryId)) continue;
    visited.add(node.entryId);
    if (node.children.length > 1) return true;
    stack.push(...node.children);
  }
  return false;
}

/**
 * Resolve the effective active leaf for branch navigation:
 * - an explicitly selected leaf (history mode: the selected context leaf)
 *   wins when it is present in the tree;
 * - otherwise the tree's persisted `currentLeafId` (the history default);
 * - `null` when neither resolves (empty tree / leaf not in this tree — the
 *   caller keeps its current selection instead of guessing).
 *
 * LIVE mode callers pass the runtime snapshot leaf as `selectedLeafId` so a
 * live in-memory navigated leaf (not yet persisted) still resolves; when it
 * is absent from the persisted tree this honestly returns `null` — the tree
 * never fabricates persistence.
 */
export function resolveActiveLeafId(
  tree: SessionTree,
  selectedLeafId?: string | null,
): string | null {
  if (selectedLeafId !== null && selectedLeafId !== undefined && selectedLeafId !== "") {
    return findTreeNodePath(tree.roots, selectedLeafId) === null ? null : selectedLeafId;
  }
  if (tree.currentLeafId === undefined) return null;
  return findTreeNodePath(tree.roots, tree.currentLeafId) === null ? null : tree.currentLeafId;
}
