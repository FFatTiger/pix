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

/**
 * Ordered content parts for an assistant (or multi-block) row.
 * History and live projections share this shape so interleaving is preserved.
 */
export type TranscriptPart =
  | { type: "text"; text: string }
  | {
      type: "thinking";
      /** Raw thinking body — never trimmed/rewritten by the projector. */
      thinking: string;
      /** True while this part belongs to the live streaming partial. */
      streaming?: boolean;
    }
  | { type: "toolCall"; text: string }
  | { type: "image"; text: string };

export interface TranscriptRow {
  /** Stable identity for virtualizer keys (never index). */
  id: string;
  kind: TranscriptRowKind;
  /** Plain text body for height estimate / a11y / fallback. */
  text: string;
  /**
   * Structured, order-preserving content blocks. Present for assistant rows
   * (and any message that projects multi-block content). The virtualizer still
   * keys the top-level row by `id` — parts are never independent list rows.
   */
  parts?: TranscriptPart[];
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
      ...(message.parts === undefined ? {} : { parts: message.parts }),
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
  /** Structured parts when the source message carries content blocks. */
  parts?: TranscriptPart[];
  createdAt?: string;
  toolName?: string;
  estimateHeight?: number;
}

/** Stable key extractor for virtualizer. */
export function getTranscriptRowKey(row: TranscriptRow): string {
  return row.id;
}

/** Flatten structured parts into the plain-text fallback used by estimate/a11y. */
export function flattenTranscriptParts(parts: readonly TranscriptPart[]): string {
  return parts
    .map((part) => {
      switch (part.type) {
        case "text":
          return part.text;
        case "thinking":
          return part.thinking;
        case "toolCall":
        case "image":
          return part.text;
        default: {
          const _exhaustive: never = part;
          return _exhaustive;
        }
      }
    })
    .join("\n");
}
