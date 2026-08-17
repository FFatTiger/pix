// Normalized session branch-tree projector (BranchNavigator slice).
//
// Pure projection from the read-only SDK session entries (the SAME
// SessionManager.getEntries() list the detail/context paths already read) onto
// the canonical runtime-core SessionTree. This module is deliberately
// SDK-type-free: it accepts a loose structural entry shape so no Pi SDK type
// crosses into the projection, and it never touches a backend manager, file
// write, network or worker.
//
// Hard boundaries of the projection:
// - NO SDK tree node, raw file path, raw message object, thinking text, tool
//   input/output or secret ever crosses into the result — nodes carry only
//   entry ids, structural parent/children links, a normalized kind and a
//   single-line, length-capped, secret-redacted preview label.
// - Roots, branch points and leaves are kept; single-child linear chains
//   between them are contracted into `skippedEntryIds` on the next kept node,
//   so a leaf selected inside a contracted chain stays addressable and the
//   response stays shallow (depth cap with a flatten fallback, mirroring the
//   legacy web frontend's projection).
// - Malformed input fails closed and deterministically, never hangs:
//   non-object entries and entries without a usable id are skipped; duplicate
//   ids keep the FIRST occurrence (append-order truth); unknown/self parents
//   and orphans surface as roots; parent cycles are unreachable from roots by
//   construction and every walk carries a visited guard anyway.
// - `currentLeafId` is the persisted catalog head (the JSONL file-order last
//   entry the offline reader resolves) and is only reported when it is
//   actually reachable from a root — the projection NEVER fabricates a live
//   worker leaf (live consumers take the active leaf from the runtime
//   snapshot; see the SessionTree contract in runtime-core).
//
// Bounded Tree Wire Contract (very large sessions): the projection honors the
// node / skipped-id / frame budgets centralized in runtime-core
// (`MAX_SESSION_TREE_NODES`, `MAX_SESSION_TREE_SKIPPED_IDS`,
// `MAX_SESSION_TREE_FRAME`). Truncation is ALWAYS explicit — when any budget
// is hit the tree carries `pageInfo` with real counts (`truncated: true`);
// it is never a silent omission. Two coherence guarantees hold under
// truncation:
// - `currentLeafId` stays coherent: the root→currentLeaf kept-node path is
//   RESERVED (projected first, never cut by the node budget), so the leaf
//   always remains addressable in the returned tree.
// - The parent graph stays coherent: every node's `parentEntryId` resolves to
//   a kept ancestor or the LAST element of its own `skippedEntryIds`. A
//   contracted chain that would exceed the remaining skipped-id/frame budget
//   is tail-truncated (the ids nearest the kept node are preserved). Two
//   truncation/structural edges are re-anchored instead of dangling: a kept
//   node flattened under the depth-cap ancestor whose raw parent is a kept
//   sibling, and a kept node whose entire contracted chain was lost to the
//   budget — both get `parentEntryId` re-pointed at the actual kept ancestor.
//   A non-leaf-path node that cannot fit is dropped together with its whole
//   subtree (never a half-coherent node), flagged by `pageInfo`.
// Roots are never dropped (malformed/orphaned entries surface as roots, the
// leaf-path root is reserved) — the budgets bound non-root nodes.
import type { SessionTree, SessionTreeNode, SessionTreeNodeKind } from "@fffattiger/pix-runtime-core";
import {
  MAX_SESSION_TREE_DEPTH,
  MAX_SESSION_TREE_FRAME,
  MAX_SESSION_TREE_LABEL_LENGTH,
  MAX_SESSION_TREE_NODES,
  MAX_SESSION_TREE_SKIPPED_IDS,
} from "@fffattiger/pix-runtime-core";
import { redactText } from "./sanitize.js";

// Back-compat aliases so existing consumers/tests keep working; the canonical
// values are the runtime-core authority constants above.
export {
  MAX_SESSION_TREE_LABEL_LENGTH as MAX_TREE_LABEL_LENGTH,
  MAX_SESSION_TREE_DEPTH as MAX_PROJECTED_TREE_DEPTH,
};

/** Loose structural view of an SDK session entry (no SDK types cross here). */
interface TreeEntryLike {
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
  timestamp?: unknown;
  message?: unknown;
  customType?: unknown;
  content?: unknown;
}

/** Normalized classification fields of a node (no ids/structure). */
type NodeClassification = Pick<SessionTreeNode, "kind" | "label" | "truncated">;

/**
 * Mutable builder shape of {@link SessionTreeNode}; structurally compatible
 * with the canonical readonly model, so the finished tree converts without a
 * copy (T[] is assignable to readonly T[]).
 */
interface MutableTreeNode {
  entryId: string;
  parentEntryId?: string;
  kind: SessionTreeNodeKind;
  label: string;
  truncated: boolean;
  children: MutableTreeNode[];
  skippedEntryIds?: string[];
}

interface RawNode {
  readonly id: string;
  readonly parentId: string | undefined;
  readonly node: NodeClassification;
  readonly childIds: string[];
  readonly order: number;
  readonly timestamp: number;
}

function entryTimestamp(entry: TreeEntryLike, order: number): number {
  const raw = entry.timestamp;
  const parsed = typeof raw === "string" || typeof raw === "number" ? new Date(raw).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : order;
}

/** Single-line, secret-redacted preview text. Never carries raw thinking/tool payloads. */
function previewText(text: string): { label: string; truncated: boolean } {
  const redacted = redactText(text).split("\n")[0] ?? "";
  const singleLine = redacted.replace(/\s+/g, " ").trim();
  if (singleLine.length > MAX_SESSION_TREE_LABEL_LENGTH) {
    return { label: singleLine.slice(0, MAX_SESSION_TREE_LABEL_LENGTH), truncated: true };
  }
  return { label: singleLine, truncated: false };
}

/** Extract display text from a message content value (string or content blocks). */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (
        block !== null &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        parts.push((block as { text: string }).text);
      }
    }
    return parts.join(" ");
  }
  return "";
}

/** Normalize a message role onto the pix node-kind vocabulary (never a raw role string). */
function messageKind(role: unknown): SessionTreeNodeKind {
  switch (role) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "toolResult":
      return "toolResult";
    case "bashExecution":
      return "bashExecution";
    case "custom":
      return "custom";
    default:
      return "system";
  }
}

/** Fixed, safe label for an entry that must not echo raw payloads. */
function fixedLabel(kind: SessionTreeNodeKind): string {
  switch (kind) {
    case "assistant":
      return "[assistant]";
    case "user":
      return "[user]";
    case "toolResult":
      return "[tool result]";
    case "bashExecution":
      return "[bash]";
    case "custom":
      return "[custom]";
    default:
      return "system";
  }
}

/**
 * Project one entry onto the node's kind + preview label. Only plain text
 * content is ever surfaced (never thinking blocks, tool calls, tool results,
 * bash commands/outputs, model metadata or extension details).
 */
function classify(entry: TreeEntryLike): NodeClassification {
  if (entry.type === "message") {
    const message = entry.message;
    const record = message !== null && typeof message === "object" ? (message as { role?: unknown; content?: unknown }) : {};
    const kind = messageKind(record.role);
    // Only conversational roles surface a text preview. Tool results and bash
    // executions carry raw tool payloads — they get a fixed placeholder and
    // NEVER echo their content/command/output.
    if (kind === "user" || kind === "assistant" || kind === "custom") {
      const text = contentText(record.content);
      if (text !== "") return { kind, ...previewText(text) };
    }
    // No addressable text (images only, empty content, tool/bash): a fixed
    // placeholder — never the raw content value.
    return { kind, label: fixedLabel(kind), truncated: false };
  }
  if (entry.type === "custom_message") {
    const text = contentText(entry.content);
    const kind: SessionTreeNodeKind = "custom";
    if (text !== "") return { kind, ...previewText(text) };
    return { kind, label: fixedLabel(kind), truncated: false };
  }
  // Structural entries (model/thinking/label/session-info changes, plain
  // custom state, compaction and branch summaries): a fixed normalized label.
  const label =
    entry.type === "compaction" ? "compaction"
      : entry.type === "branch_summary" ? "branch summary"
        : entry.type === "model_change" ? "model change"
          : entry.type === "thinking_level_change" ? "thinking level"
            : entry.type === "label" ? "label"
              : entry.type === "session_info" ? "session info"
                : entry.type === "custom" ? "custom"
                  : "entry";
  return { kind: "system", label, truncated: false };
}

/**
 * Project the full entry list of a session onto the canonical branch tree,
 * honoring the Bounded Tree Wire Contract (see the module docstring).
 *
 * `leafId` is the persisted catalog head (the offline reader's current leaf);
 * it is echoed as `currentLeafId` only when it resolves to an indexed entry
 * that is reachable from a root — the projection never invents a leaf. The
 * root→currentLeaf kept-node path is reserved, so `currentLeafId` remains
 * addressable even when the node budget bounds the rest of the tree.
 */
export function projectSessionTree(sessionId: string, entries: readonly unknown[], leafId: string | null | undefined): SessionTree {
  // 1. Index (first occurrence wins, file order) and drop malformed entries.
  const byId = new Map<string, RawNode>();
  let order = 0;
  for (const value of entries) {
    if (value === null || typeof value !== "object") continue;
    const entry = value as TreeEntryLike;
    if (typeof entry.id !== "string" || entry.id.length === 0) continue;
    if (byId.has(entry.id)) continue; // duplicate id: keep the first (append truth)
    const parentId = typeof entry.parentId === "string" && entry.parentId.length > 0 && entry.parentId !== entry.id
      ? entry.parentId
      : undefined;
    const node: RawNode = {
      id: entry.id,
      parentId,
      node: classify(entry),
      childIds: [],
      order,
      timestamp: entryTimestamp(entry, order),
    };
    order += 1;
    byId.set(entry.id, node);
  }

  // 2. Link children. Unknown/self parents and orphans surface as roots.
  const roots: RawNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId === undefined ? undefined : byId.get(node.parentId);
    if (parent === undefined || parent === node) {
      roots.push(node);
    } else {
      parent.childIds.push(node.id);
    }
  }
  // Children render oldest-first (timestamp, then file order as the tiebreak).
  for (const node of byId.values()) {
    node.childIds.sort((a, b) => {
      const left = byId.get(a)!;
      const right = byId.get(b)!;
      return left.timestamp !== right.timestamp
        ? left.timestamp - right.timestamp
        : left.order - right.order;
    });
  }

  // 3. Reachable set from the roots (cycles are unreachable by construction;
  //    the visited guard makes that a property, not an assumption).
  const reachable = new Set<string>();
  const reachStack = [...roots];
  while (reachStack.length > 0) {
    const current = reachStack.pop()!;
    if (reachable.has(current.id)) continue;
    reachable.add(current.id);
    for (const childId of current.childIds) {
      const child = byId.get(childId);
      if (child !== undefined && !reachable.has(child.id)) reachStack.push(child);
    }
  }

  // 4. Which nodes stay visible: roots, branch points and leaves. A node with
  //    exactly one child is always contracted into its child.
  const keep = new Set<string>();
  const seen = new Set<string>();
  const keepStack = [...roots];
  while (keepStack.length > 0) {
    const current = keepStack.pop()!;
    if (seen.has(current.id)) continue;
    seen.add(current.id);
    if (current.childIds.length !== 1) keep.add(current.id);
    for (const childId of current.childIds) {
      const child = byId.get(childId);
      if (child !== undefined && !seen.has(child.id)) keepStack.push(child);
    }
  }
  for (const root of roots) keep.add(root.id);

  const toProjected = (node: RawNode, skippedEntryIds?: string[]): MutableTreeNode => ({
    entryId: node.id,
    ...(node.parentId === undefined ? {} : { parentEntryId: node.parentId }),
    kind: node.node.kind,
    label: node.node.label,
    truncated: node.node.truncated,
    children: [],
    ...(skippedEntryIds === undefined || skippedEntryIds.length === 0 ? {} : { skippedEntryIds }),
  });

  // 5. Bounded projection with linear-chain contraction and a depth cap.
  //    Beyond the cap, kept descendants are flattened into the nearest kept
  //    ancestor (their contracted ids preserved), keeping the response
  //    shallow. The root→currentLeaf kept-node path is RESERVED: its nodes
  //    are projected first (never cut by the node budget) and its contracted
  //    chains get budget first (tail-preserved), so the leaf stays
  //    addressable and its parent graph stays coherent even in a bounded tree.
  const currentLeafResolves =
    typeof leafId === "string" && byId.has(leafId) && reachable.has(leafId);

  // All nodes on the root→currentLeaf path (root first), plus the kept subset
  // (used to keep flattened leaf-path nodes reserved during depth-cap flatten).
  const leafPathAll: RawNode[] = [];
  const leafKept = new Set<string>();
  if (currentLeafResolves) {
    let cursor = byId.get(leafId as string);
    while (cursor !== undefined) {
      leafPathAll.push(cursor);
      cursor = cursor.parentId === undefined ? undefined : byId.get(cursor.parentId);
    }
    leafPathAll.reverse();
    for (const node of leafPathAll) if (keep.has(node.id)) leafKept.add(node.id);
  }

  let nodeCount = 0;
  let skippedCount = 0;
  let truncated = false;

  // Roots are never dropped (malformed/orphaned entries surface as roots);
  // they are still counted against the node/frame budgets so a pathological
  // root flood is flagged as truncated rather than silent.
  const projectedRoots: MutableTreeNode[] = [];
  const projectedRootById = new Map<string, MutableTreeNode>();
  const consumed = new Set<string>();
  for (const root of roots) {
    nodeCount += 1;
    const projected = toProjected(root);
    projectedRoots.push(projected);
    projectedRootById.set(root.id, projected);
    consumed.add(root.id);
  }

  /** Tail-truncate a contracted chain to the remaining skipped-id AND frame
   *  budgets (keeps the tail nearest the kept node so its parentEntryId stays
   *  inside its own skippedEntryIds). Returns the kept tail. */
  const reserveChain = (chain: readonly string[]): string[] => {
    const room = Math.max(0, Math.min(
      MAX_SESSION_TREE_SKIPPED_IDS - skippedCount,
      MAX_SESSION_TREE_FRAME - nodeCount - skippedCount,
    ));
    const kept = Math.min(chain.length, room);
    if (kept < chain.length) truncated = true;
    skippedCount += kept;
    return chain.slice(chain.length - kept);
  };

  // Depth-cap flattening (shared by Phase A leaf-path flattening and the
  // general DFS): kept descendants beyond the cap are appended to `parent` in
  // the canonical oldest-first order, each with its own contracted chain.
  // Budget-aware: leaf-path nodes are reserved; non-leaf-path nodes (with
  // their whole subtree) are skipped when they cannot fit — explicit
  // truncation, never a half-coherent node.
  const appendFlattened = (source: RawNode, parent: MutableTreeNode, inherited: readonly string[]): void => {
    const pending: { node: RawNode; skipped: readonly string[] }[] = [{ node: source, skipped: inherited }];
    const flattenedSeen = new Set<string>();
    while (pending.length > 0) {
      const { node, skipped } = pending.pop()!;
      if (flattenedSeen.has(node.id)) continue;
      flattenedSeen.add(node.id);
      consumed.add(node.id);
      if (keep.has(node.id) && node.id !== parent.entryId) {
        const reserved = leafKept.has(node.id);
        const room = Math.max(0, Math.min(
          MAX_SESSION_TREE_SKIPPED_IDS - skippedCount,
          MAX_SESSION_TREE_FRAME - nodeCount - skippedCount,
        ));
        const chainKept = Math.min(skipped.length, room);
        const fits =
          reserved ||
          (nodeCount + 1 <= MAX_SESSION_TREE_NODES &&
            nodeCount + skippedCount + chainKept + 1 <= MAX_SESSION_TREE_FRAME);
        if (!fits) {
          truncated = true;
          continue;
        }
        if (chainKept < skipped.length) truncated = true;
        skippedCount += chainKept;
        nodeCount += 1;
        const keptChain = skipped.slice(skipped.length - chainKept);
        const projectedChild = toProjected(node, [...keptChain]);
        // Parent-coherence under flattening: a kept node's raw parent is
        // normally either a kept ancestor or the tail of its own contracted
        // chain. Flattening sibling-izes kept descendants under the depth-cap
        // ancestor, and the budget may drop a chain entirely — in both cases
        // the raw parent would dangle. Re-anchor `parentEntryId` to this
        // flattened (kept) ancestor so it ALWAYS resolves to a kept ancestor
        // or the chain tail (explicit truncation, never a dangling reference).
        const rawParent = node.parentId;
        const rawParentFlattenedSibling =
          rawParent !== undefined && keep.has(rawParent) && rawParent !== parent.entryId;
        const rawParentChainLost = rawParent !== undefined && !keep.has(rawParent) && keptChain.length === 0;
        if (rawParentFlattenedSibling || rawParentChainLost) projectedChild.parentEntryId = parent.entryId;
        parent.children.push(projectedChild);
      }
      // `pending` is LIFO: push children newest-first so they are consumed in
      // the canonical oldest-first order used by the non-flattened tree.
      for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
        const child = byId.get(node.childIds[index]!);
        if (child === undefined || flattenedSeen.has(child.id)) continue;
        pending.push({
          node: child,
          skipped: keep.has(node.id) ? [] : [...skipped, node.id],
        });
      }
    }
  };

  // Phase A: project the reserved leaf path (root → currentLeaf). Kept nodes
  // on the path are PRE-COMPUTED (with their reserved chains) but NOT attached
  // yet, so the general DFS can attach every child in canonical oldest-first
  // order. Beyond the depth cap the remaining path is flattened (attached).
  const leafPathById = new Map<string, { node: MutableTreeNode; depth: number }>();
  if (leafPathAll.length > 0) {
    const rootNode = leafPathAll[0]!;
    let anchor = { node: projectedRootById.get(rootNode.id)!, depth: 1 };
    let pendingChain: string[] = [];
    for (let index = 1; index < leafPathAll.length; index += 1) {
      const node = leafPathAll[index]!;
      if (!keep.has(node.id)) {
        pendingChain.push(node.id);
        continue;
      }
      if (anchor.depth >= MAX_SESSION_TREE_DEPTH) {
        // Depth cap: flatten the remaining leaf-path subtree into the
        // depth-cap ancestor. The leaf stays addressable as a flattened node.
        appendFlattened(node, anchor.node, []);
        pendingChain = [];
        break;
      }
      const projectedChild = toProjected(node, reserveChain(pendingChain));
      nodeCount += 1;
      leafPathById.set(node.id, { node: projectedChild, depth: anchor.depth + 1 });
      anchor = { node: projectedChild, depth: anchor.depth + 1 };
      pendingChain = [];
    }
  }

  // Phase B: general DFS over everything else, within the remaining budgets.
  // Leaf-path chain nodes are attached from `leafPathById` (reserved, already
  // counted); every other kept node is budget-checked.
  const tasks: { source: RawNode; projected: MutableTreeNode; depth: number }[] = [];
  for (const root of roots) {
    tasks.push({ source: root, projected: projectedRootById.get(root.id)!, depth: 1 });
  }
  for (const node of leafPathAll) {
    if (node === leafPathAll[0]) continue; // root already seeded
    const entry = leafPathById.get(node.id);
    if (entry !== undefined) tasks.push({ source: node, projected: entry.node, depth: entry.depth });
  }

  while (tasks.length > 0) {
    const task = tasks.pop()!;
    for (const childId of task.source.childIds) {
      const directChild = byId.get(childId);
      if (directChild === undefined) continue;
      if (consumed.has(directChild.id)) continue; // already projected / flattened
      if (task.depth >= MAX_SESSION_TREE_DEPTH) {
        appendFlattened(directChild, task.projected, []);
        continue;
      }
      let child = directChild;
      const skipped: string[] = [];
      // Contract the linear chain: every intermediate single-child node folds
      // into the next kept descendant. (keep ⇒ kept node ends the walk.)
      while (!keep.has(child.id) && child.childIds.length === 1) {
        skipped.push(child.id);
        const next = byId.get(child.childIds[0]!);
        if (next === undefined || consumed.has(next.id) || next === child) break; // cycle guard
        child = next;
      }
      if (!keep.has(child.id)) continue;
      const precomputed = leafPathById.get(child.id);
      if (precomputed !== undefined) {
        // Reserved leaf-path node: attach the pre-computed node in canonical
        // child order (its chain was already reserved in Phase A).
        if (consumed.has(child.id)) continue;
        consumed.add(child.id);
        task.projected.children.push(precomputed.node);
        tasks.push({ source: child, projected: precomputed.node, depth: precomputed.depth });
        continue;
      }
      if (consumed.has(child.id)) continue; // already projected (duplicate/cycle defense)
      // Non-leaf-path node: budget-check node + chain + frame.
      const room = Math.max(0, Math.min(
        MAX_SESSION_TREE_SKIPPED_IDS - skippedCount,
        MAX_SESSION_TREE_FRAME - nodeCount - skippedCount,
      ));
      const chainKept = Math.min(skipped.length, room);
      const fits =
        nodeCount + 1 <= MAX_SESSION_TREE_NODES &&
        nodeCount + skippedCount + chainKept + 1 <= MAX_SESSION_TREE_FRAME;
      if (!fits) {
        truncated = true;
        continue;
      }
      if (chainKept < skipped.length) truncated = true;
      consumed.add(child.id);
      skippedCount += chainKept;
      nodeCount += 1;
      const keptChain = skipped.slice(skipped.length - chainKept);
      const projectedChild = toProjected(child, keptChain);
      // Parent-coherence under budget truncation: when the raw parent (a
      // non-kept chain node, the tail of `skipped`) was entirely lost to the
      // skipped-id/frame budget, re-anchor `parentEntryId` to the kept
      // ancestor so it always resolves to a kept ancestor or the chain tail
      // — never a dangling reference. (A kept raw parent is always the direct
      // kept ancestor here, so it resolves on its own.)
      if (child.parentId !== undefined && !keep.has(child.parentId) && keptChain.length === 0) {
        projectedChild.parentEntryId = task.projected.entryId;
      }
      task.projected.children.push(projectedChild);
      tasks.push({ source: child, projected: projectedChild, depth: task.depth + 1 });
    }
  }

  // 6. currentLeafId: the persisted head, echoed only when it is an indexed,
  //    root-reachable entry (never fabricated). Because the leaf path is
  //    reserved, a reachable leaf is ALWAYS addressable in the returned tree —
  //    even a bounded one. pageInfo is emitted only when a budget was hit
  //    (explicit truncation; never silent omission).
  const currentLeafId = currentLeafResolves ? (leafId as string) : undefined;
  const pageInfo = truncated
    ? {
        truncated: true,
        nodeCount,
        skippedIdCount: skippedCount,
        frameCount: nodeCount + skippedCount,
      }
    : undefined;

  return {
    sessionId,
    ...(currentLeafId === undefined ? {} : { currentLeafId }),
    roots: projectedRoots,
    entryCount: reachable.size,
    ...(pageInfo === undefined ? {} : { pageInfo }),
  };
}
