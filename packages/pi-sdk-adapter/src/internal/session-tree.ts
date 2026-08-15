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
//   response stays shallow (depth cap 200 with a flatten fallback, mirroring
//   the legacy web frontend's projection).
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
import type { SessionTree, SessionTreeNode, SessionTreeNodeKind } from "@fffattiger/pix-runtime-core";
import { redactText } from "./sanitize.js";

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

/** Maximum preview label length in Unicode JS code units (BranchNavigator parity). */
export const MAX_TREE_LABEL_LENGTH = 40;

/**
 * Maximum kept-node depth in the projected tree. Deeper kept descendants are
 * flattened into the nearest kept ancestor (with their contracted ids), so the
 * response tree stays shallow for recursive renderers.
 */
export const MAX_PROJECTED_TREE_DEPTH = 200;

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
  if (singleLine.length > MAX_TREE_LABEL_LENGTH) {
    return { label: singleLine.slice(0, MAX_TREE_LABEL_LENGTH), truncated: true };
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
 * Project the full entry list of a session onto the canonical branch tree.
 *
 * `leafId` is the persisted catalog head (the offline reader's current leaf);
 * it is echoed as `currentLeafId` only when it resolves to an indexed entry
 * that is reachable from a root — the projection never invents a leaf.
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

  // 5. Project with linear-chain contraction and a depth cap. Beyond the cap,
  //    kept descendants are flattened into the nearest kept ancestor (their
  //    contracted ids preserved), keeping the response shallow.
  const projectedRoots = roots.map((root) => toProjected(root));
  const tasks: { source: RawNode; projected: MutableTreeNode; depth: number }[] = roots.map((source, index) => ({
    source,
    projected: projectedRoots[index]!,
    depth: 1,
  }));
  const consumed = new Set<string>(roots.map((root) => root.id));

  const appendFlattened = (source: RawNode, parent: MutableTreeNode, inherited: readonly string[]): void => {
    const pending: { node: RawNode; skipped: readonly string[] }[] = [{ node: source, skipped: inherited }];
    const flattenedSeen = new Set<string>();
    while (pending.length > 0) {
      const { node, skipped } = pending.pop()!;
      if (flattenedSeen.has(node.id)) continue;
      flattenedSeen.add(node.id);
      if (keep.has(node.id) && node.id !== parent.entryId) {
        parent.children.push(toProjected(node, [...skipped]));
      }
      for (const childId of node.childIds) {
        const child = byId.get(childId);
        if (child === undefined || flattenedSeen.has(child.id)) continue;
        pending.push({
          node: child,
          skipped: keep.has(node.id) ? [] : [...skipped, node.id],
        });
      }
    }
  };

  while (tasks.length > 0) {
    const task = tasks.pop()!;
    for (const childId of task.source.childIds) {
      let child = byId.get(childId);
      if (child === undefined) continue;
      if (task.depth >= MAX_PROJECTED_TREE_DEPTH) {
        appendFlattened(child, task.projected, []);
        continue;
      }
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
      if (consumed.has(child.id)) continue; // already projected (duplicate/cycle defense)
      consumed.add(child.id);
      const projectedChild = toProjected(child, skipped);
      task.projected.children.push(projectedChild);
      tasks.push({ source: child, projected: projectedChild, depth: task.depth + 1 });
    }
  }

  // 6. currentLeafId: the persisted head, echoed only when it is an indexed,
  //    root-reachable entry (never fabricated).
  const currentLeafId = typeof leafId === "string" && byId.has(leafId) && reachable.has(leafId) ? leafId : undefined;

  return {
    sessionId,
    ...(currentLeafId === undefined ? {} : { currentLeafId }),
    roots: projectedRoots,
    entryCount: reachable.size,
  };
}
