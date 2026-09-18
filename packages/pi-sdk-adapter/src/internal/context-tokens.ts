/**
 * ONE shared SDK context-token estimator for the sessions/agent seam.
 *
 * Both the live runtime driver (`sdk-runtime.ts`) and the zero-Worker history
 * read (`session-store.ts` readSessionContext) MUST derive the context
 * numerator from the exact same arithmetic, otherwise a history page and a
 * live footer disagree about the same JSONL branch. This module is that single
 * owner: it mirrors the Pi SDK's `AgentSession.getContextUsage()` semantics —
 * `calculateContextTokens`/`estimateTokens` from the SDK itself, the
 * post-compaction "unknown until a valid post-compaction assistant usage
 * arrives" gate, skipping aborted/error/zero usages, and never resurrecting a
 * pre-compaction usage — over caller-supplied RAW selected-branch inputs.
 *
 * Inputs are computed by the caller BEFORE any page limit or thinking/media
 * deferral, so pagination and RPC-frame deferral can never change the result:
 *  - `branchEntries`: the raw selected branch (leaf→root path in file order —
 *    `sessionManager.getBranch()` for the live leaf, the same walk for a
 *    selected history leaf). Used ONLY for the compaction gate, exactly like
 *    the SDK scans `getBranch()`.
 *  - `contextMessages`: the full LLM context messages of the SAME selected
 *    branch (`buildSessionContext().messages` shape).
 *
 * Returns the estimated context tokens, or `null` when the true size is
 * UNKNOWN (post-compaction without a valid assistant usage after it). `0` is a
 * KNOWN-empty branch and must be reported as such.
 *
 * Boundary: Pi SDK arithmetic helpers may be imported ONLY inside
 * `pi-sdk-adapter` (this module); Client/Host/sessiond/Worker never estimate.
 */
import {
  calculateContextTokens,
  estimateTokens,
  getLatestCompactionEntry,
} from "@earendil-works/pi-coding-agent";

// The Pi SDK does not re-export the AgentMessage/Usage types; the arithmetic
// helpers accept them, so cast through their parameter types at the call sites.
export type SdkContextMessage = Parameters<typeof estimateTokens>[0];
type ContextUsageShape = Parameters<typeof calculateContextTokens>[0];

/** Minimal structural shape of a raw selected-branch entry (compaction gate). */
interface BranchEntryLike {
  type: string;
  message?: { role?: string; stopReason?: string; usage?: ContextUsageShape };
}

/** True for an assistant message whose usage is a valid context numerator. */
function isValidAssistantUsage(message: SdkContextMessage | BranchEntryLike["message"]): boolean {
  if (!message || message.role !== "assistant") return false;
  const assistant = message as { stopReason?: string; usage?: ContextUsageShape };
  if (assistant.stopReason === "aborted" || assistant.stopReason === "error") return false;
  if (assistant.usage === undefined) return false;
  return calculateContextTokens(assistant.usage) > 0;
}

/**
 * Estimate the context tokens of ONE selected raw SDK branch.
 *
 * - Post-compaction without a valid non-aborted/non-error positive assistant
 *   usage AFTER the latest compaction entry → `null` (unknown; never a stale
 *   pre-compaction number, never a fake 0%).
 * - Otherwise the SDK `estimateContextTokens` arithmetic: the last valid
 *   assistant usage plus an `estimateTokens` sum of the trailing messages
 *   (or a full `estimateTokens` sum when no usage exists at all).
 *
 * Pure: never mutates its inputs, never touches the filesystem or network.
 */
export function estimateSdkBranchContextTokens(
  branchEntries: readonly BranchEntryLike[],
  contextMessages: readonly SdkContextMessage[],
): number | null {
  const latestCompaction = getLatestCompactionEntry(branchEntries as never[]);
  if (latestCompaction !== null) {
    const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
    let hasPostCompactionUsage = false;
    for (let i = branchEntries.length - 1; i > compactionIndex; i -= 1) {
      const entry = branchEntries[i];
      if (!entry || entry.type !== "message") continue;
      if (isValidAssistantUsage(entry.message)) {
        hasPostCompactionUsage = true;
        break;
      }
    }
    // Mirror the SDK: without a valid assistant usage AFTER the latest
    // compaction the true size is unknown until the next LLM response.
    if (!hasPostCompactionUsage) return null;
  }
  let usageTokens = 0;
  let lastUsageIndex = -1;
  for (let i = contextMessages.length - 1; i >= 0; i -= 1) {
    const message = contextMessages[i];
    if (!message || !isValidAssistantUsage(message)) continue;
    usageTokens = calculateContextTokens(
      (message as { usage?: ContextUsageShape }).usage!,
    );
    lastUsageIndex = i;
    break;
  }
  let trailingTokens = 0;
  for (let i = lastUsageIndex + 1; i < contextMessages.length; i += 1) {
    trailingTokens += estimateTokens(contextMessages[i]!);
  }
  return lastUsageIndex >= 0
    ? usageTokens + trailingTokens
    : contextMessages.reduce((sum, message) => sum + estimateTokens(message), 0);
}
