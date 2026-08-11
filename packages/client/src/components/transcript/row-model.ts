/**
 * Transcript row model — pure data shape, independent of view/virtualizer.
 * Virtualization consumes this model; view components map row → UI.
 */

export type TranscriptRowKind =
  | "user"
  | "assistant"
  | "tool"
  | "system"
  | "divider";

export interface TranscriptRow {
  /** Stable identity for virtualizer keys (never index). */
  id: string;
  kind: TranscriptRowKind;
  /** Plain text body for shell preview / a11y. */
  text: string;
  /** Optional estimated height hint; virtualizer still measures dynamically. */
  estimateHeight?: number;
  meta?: {
    createdAt?: string;
    toolName?: string;
  };
}

export interface BuildRowsOptions {
  /** When true, inject a readonly banner row at the top. */
  readonlyBanner?: boolean;
}

const DEFAULT_ESTIMATE: Record<TranscriptRowKind, number> = {
  user: 72,
  assistant: 96,
  tool: 56,
  system: 40,
  divider: 28,
};

export function estimateRowHeight(row: TranscriptRow): number {
  if (typeof row.estimateHeight === "number" && row.estimateHeight > 0) {
    return row.estimateHeight;
  }
  // Rough text-based estimate so first paint is closer before measure.
  const lines = Math.max(1, Math.ceil(row.text.length / 72));
  const base = DEFAULT_ESTIMATE[row.kind];
  return Math.min(480, base + Math.max(0, lines - 1) * 18);
}

export function buildTranscriptRows(
  messages: readonly TranscriptMessageInput[],
  options: BuildRowsOptions = {},
): TranscriptRow[] {
  const rows: TranscriptRow[] = [];

  if (options.readonlyBanner) {
    rows.push({
      id: "row:system:readonly",
      kind: "system",
      text: "Read-only mode — host has no agent capability. Browsing history only.",
      estimateHeight: 40,
    });
  }

  for (const message of messages) {
    const meta: NonNullable<TranscriptRow["meta"]> = {
      ...(message.createdAt === undefined
        ? {}
        : { createdAt: message.createdAt }),
      ...(message.toolName === undefined ? {} : { toolName: message.toolName }),
    };
    rows.push({
      id: message.id,
      kind: message.role,
      text: message.text,
      ...(message.estimateHeight === undefined
        ? {}
        : { estimateHeight: message.estimateHeight }),
      ...(Object.keys(meta).length === 0 ? {} : { meta }),
    });
  }

  return rows;
}

export interface TranscriptMessageInput {
  id: string;
  role: Exclude<TranscriptRowKind, "divider" | "system"> | "system";
  text: string;
  createdAt?: string;
  toolName?: string;
  estimateHeight?: number;
}

/** Stable key extractor for virtualizer. */
export function getTranscriptRowKey(row: TranscriptRow): string {
  return row.id;
}
