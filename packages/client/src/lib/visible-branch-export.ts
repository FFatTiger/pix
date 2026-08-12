/**
 * Client-only visible-branch export (D1B-3).
 *
 * Builds a normalized JSON document from an already-fetched SessionContext
 * branch. Never calls Host helpers (/export, /thinking, /bash-output), never
 * walks raw JSONL or all branches, and never snapshots live runtime state.
 */

import type {
  AgentMessage,
  ImageContent,
  SessionContext,
  SessionEntry,
  UserContent,
} from "@fffattiger/pix-protocol";

export const VISIBLE_BRANCH_FORMAT = "pix-visible-branch" as const;
export const VISIBLE_BRANCH_VERSION = 1 as const;
export const VISIBLE_BRANCH_SCOPE = "selected-session-context-branch" as const;
export const VISIBLE_BRANCH_DISCLAIMER =
  "Selected SessionContext branch snapshot only; not an archive, all branches, or raw session truth." as const;
export const VISIBLE_BRANCH_EXPORT_ERROR = "Could not export visible branch." as const;

export type VisibleBranchImagePlaceholder = {
  type: "image";
  omitted: true;
  sourceType: "base64" | "url";
  mediaType?: string;
};

export type VisibleBranchTextBlock = { type: "text"; text: string };
export type VisibleBranchThinkingBlock = {
  type: "thinking";
  thinking: string;
  deferred?: boolean;
};
export type VisibleBranchToolCallBlock = {
  type: "toolCall";
  id: string;
  name: string;
  input: unknown;
};

export type VisibleBranchContentBlock =
  | VisibleBranchTextBlock
  | VisibleBranchImagePlaceholder
  | VisibleBranchThinkingBlock
  | VisibleBranchToolCallBlock;

export type VisibleBranchUserEntry = {
  entryId: string;
  parentEntryId?: string;
  role: "user";
  content: VisibleBranchContentBlock[];
  timestamp?: number;
};

export type VisibleBranchAssistantEntry = {
  entryId: string;
  parentEntryId?: string;
  role: "assistant";
  model: string;
  provider: string;
  stopReason?: string;
  errorMessage?: string;
  content: VisibleBranchContentBlock[];
  timestamp?: number;
};

export type VisibleBranchToolResultEntry = {
  entryId: string;
  parentEntryId?: string;
  role: "toolResult";
  id: string;
  name?: string;
  isError?: boolean;
  content: VisibleBranchContentBlock[];
  timestamp?: number;
};

export type VisibleBranchCustomEntry = {
  entryId: string;
  parentEntryId?: string;
  role: "custom";
  customType: string;
  display: boolean;
  content: VisibleBranchContentBlock[];
  timestamp?: number;
};

export type VisibleBranchBashEntry = {
  entryId: string;
  parentEntryId?: string;
  role: "bashExecution";
  command: string;
  output: string;
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
  excludeFromContext?: boolean;
  timestamp?: number;
};

export type VisibleBranchEntry =
  | VisibleBranchUserEntry
  | VisibleBranchAssistantEntry
  | VisibleBranchToolResultEntry
  | VisibleBranchCustomEntry
  | VisibleBranchBashEntry;

export type VisibleBranchDocument = {
  format: typeof VISIBLE_BRANCH_FORMAT;
  version: typeof VISIBLE_BRANCH_VERSION;
  scope: typeof VISIBLE_BRANCH_SCOPE;
  disclaimer: typeof VISIBLE_BRANCH_DISCLAIMER;
  exportedAt: string;
  sessionId: string;
  leafId?: string;
  entries: VisibleBranchEntry[];
};

export type DownloadDeps = {
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  appendChild: (node: HTMLElement) => void;
  removeChild: (node: HTMLElement) => void;
  createElement: (tag: "a") => HTMLAnchorElement;
  setTimeout: (fn: () => void, ms: number) => unknown;
  Blob: typeof Blob;
};

export class VisibleBranchExportError extends Error {
  readonly uiMessage = VISIBLE_BRANCH_EXPORT_ERROR;

  constructor(message = VISIBLE_BRANCH_EXPORT_ERROR) {
    super(message);
    this.name = "VisibleBranchExportError";
  }
}

/**
 * Sanitize sessionId for a download filename segment.
 * NFKC → replace runs of non-[A-Za-z0-9._-] with `-` → strip leading/trailing
 * `._-` → slice 48 → empty falls back to `session`.
 */
export function filenameSegmentFromSessionId(sessionId: string): string {
  const normalized = sessionId.normalize("NFKC");
  const replaced = normalized.replace(/[^A-Za-z0-9._-]+/g, "-");
  const trimmed = replaced.replace(/^[._-]+|[._-]+$/g, "");
  const sliced = trimmed.slice(0, 48);
  return sliced.length > 0 ? sliced : "session";
}

export function buildVisibleBranchFilename(sessionId: string): string {
  return `pix-visible-branch-${filenameSegmentFromSessionId(sessionId)}.json`;
}

/**
 * Recursively clone a value into a JSON-safe structure.
 * Accepts only primitives, arrays, plain objects (Object.prototype), and
 * null-prototype objects. Rejects Date/Map/Set/RegExp/class instances and any
 * exotic prototype; never calls toJSON.
 * Own enumerable accessors (get/set) are rejected without invoking getters;
 * data values are read via property descriptors only.
 * Cycle detection uses an active recursion stack (not a global visited set):
 * true cycles reject; legitimate shared subtrees clone independently.
 * Arrays keep index order; objects keep only own enumerable string keys
 * (including `__proto__` / `constructor`) as own data properties without
 * prototype pollution. Proxy traps on keys/prototype/descriptors map to the
 * fixed export error with no raw leakage.
 */
export function cloneJsonSafe(value: unknown, stack = new WeakSet<object>()): unknown {
  if (value === null) return null;
  const t = typeof value;
  if (t === "string" || t === "boolean") return value;
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new VisibleBranchExportError(VISIBLE_BRANCH_EXPORT_ERROR);
    }
    return value;
  }
  if (t === "bigint" || t === "undefined" || t === "function" || t === "symbol") {
    throw new VisibleBranchExportError(VISIBLE_BRANCH_EXPORT_ERROR);
  }
  if (t !== "object") {
    throw new VisibleBranchExportError(VISIBLE_BRANCH_EXPORT_ERROR);
  }

  const obj = value as object;
  if (stack.has(obj)) {
    throw new VisibleBranchExportError(VISIBLE_BRANCH_EXPORT_ERROR);
  }
  stack.add(obj);

  try {
    // Array.isArray is safe; iteration may throw on revoked proxies / broken iterators.
    let isArray: boolean;
    try {
      isArray = Array.isArray(obj);
    } catch {
      throw new VisibleBranchExportError(VISIBLE_BRANCH_EXPORT_ERROR);
    }

    if (isArray) {
      const out: unknown[] = [];
      let length: number;
      try {
        length = (obj as unknown[]).length;
      } catch {
        throw new VisibleBranchExportError(VISIBLE_BRANCH_EXPORT_ERROR);
      }
      // Index walk avoids for..of / iterator protocol side effects.
      for (let i = 0; i < length; i++) {
        let item: unknown;
        try {
          // Descriptor-only read so own accessors never execute; holes stay undefined.
          const desc = Object.getOwnPropertyDescriptor(obj, String(i));
          if (desc === undefined) {
            item = undefined;
          } else if (
            Object.prototype.hasOwnProperty.call(desc, "get") ||
            Object.prototype.hasOwnProperty.call(desc, "set")
          ) {
            throw new VisibleBranchExportError(VISIBLE_BRANCH_EXPORT_ERROR);
          } else {
            item = desc.value;
          }
        } catch (error) {
          if (error instanceof VisibleBranchExportError) throw error;
          throw new VisibleBranchExportError(VISIBLE_BRANCH_EXPORT_ERROR);
        }
        // Sparse holes / undefined elements are not JSON-safe.
        out.push(cloneJsonSafe(item, stack));
      }
      return out;
    }

    // Only plain Object.prototype or null-prototype bags. Exotic prototypes
    // (Date/Map/Set/RegExp/class instances) must not silently become {}.
    let proto: object | null;
    try {
      proto = Object.getPrototypeOf(obj);
    } catch {
      throw new VisibleBranchExportError(VISIBLE_BRANCH_EXPORT_ERROR);
    }
    if (proto !== Object.prototype && proto !== null) {
      throw new VisibleBranchExportError(VISIBLE_BRANCH_EXPORT_ERROR);
    }

    // Null-prototype bag + defineProperty so keys like `__proto__` stay own data
    // properties and never trigger Object.prototype setters / pollution.
    const out = Object.create(null) as Record<string, unknown>;
    let keys: string[];
    try {
      keys = Object.keys(obj);
    } catch {
      throw new VisibleBranchExportError(VISIBLE_BRANCH_EXPORT_ERROR);
    }
    for (const key of keys) {
      let child: unknown;
      try {
        const desc = Object.getOwnPropertyDescriptor(obj, key);
        if (desc === undefined) {
          throw new VisibleBranchExportError(VISIBLE_BRANCH_EXPORT_ERROR);
        }
        // Reject own enumerable accessors without invoking the getter.
        if (Object.prototype.hasOwnProperty.call(desc, "get") || Object.prototype.hasOwnProperty.call(desc, "set")) {
          throw new VisibleBranchExportError(VISIBLE_BRANCH_EXPORT_ERROR);
        }
        child = desc.value;
      } catch (error) {
        if (error instanceof VisibleBranchExportError) throw error;
        throw new VisibleBranchExportError(VISIBLE_BRANCH_EXPORT_ERROR);
      }
      const cloned = cloneJsonSafe(child, stack);
      try {
        Object.defineProperty(out, key, {
          value: cloned,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      } catch {
        throw new VisibleBranchExportError(VISIBLE_BRANCH_EXPORT_ERROR);
      }
    }
    return out;
  } finally {
    // Active stack: pop on both success and failure so siblings can re-enter
    // the same shared child independently, and aborted paths do not poison later clones.
    stack.delete(obj);
  }
}

function imagePlaceholder(image: ImageContent): VisibleBranchImagePlaceholder {
  const source = image.source;
  if (source.type === "base64") {
    const placeholder: VisibleBranchImagePlaceholder = {
      type: "image",
      omitted: true,
      sourceType: "base64",
    };
    if (source.media_type !== undefined) {
      placeholder.mediaType = source.media_type;
    }
    return placeholder;
  }
  const placeholder: VisibleBranchImagePlaceholder = {
    type: "image",
    omitted: true,
    sourceType: "url",
  };
  if (source.media_type !== undefined) {
    placeholder.mediaType = source.media_type;
  }
  return placeholder;
}

function normalizeUserContent(content: UserContent): VisibleBranchContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return content.map((block) => {
    if (block.type === "text") {
      return { type: "text", text: block.text };
    }
    return imagePlaceholder(block);
  });
}

function normalizeAssistantContent(
  content: Extract<AgentMessage, { role: "assistant" }>["content"],
): VisibleBranchContentBlock[] {
  // Preserve block order; do NOT merge adjacent text/thinking.
  return content.map((block) => {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text };
      case "thinking": {
        const out: VisibleBranchThinkingBlock = {
          type: "thinking",
          thinking: block.thinking,
        };
        if (block.deferred !== undefined) out.deferred = block.deferred;
        return out;
      }
      case "toolCall":
        return {
          type: "toolCall",
          id: block.toolCallId,
          name: block.toolName,
          input: cloneJsonSafe(block.input),
        };
      case "image":
        return imagePlaceholder(block);
      default: {
        const _exhaustive: never = block;
        void _exhaustive;
        throw new VisibleBranchExportError(VISIBLE_BRANCH_EXPORT_ERROR);
      }
    }
  });
}

function normalizeToolResultContent(
  content: Extract<AgentMessage, { role: "toolResult" }>["content"],
): VisibleBranchContentBlock[] {
  return content.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    return imagePlaceholder(block);
  });
}

function projectEntry(entry: SessionEntry): VisibleBranchEntry {
  const base: { entryId: string; parentEntryId?: string; timestamp?: number } = {
    entryId: entry.entryId,
  };
  if (entry.parentEntryId !== undefined) base.parentEntryId = entry.parentEntryId;

  const message = entry.message;
  const timestamp = message.timestamp;

  switch (message.role) {
    case "user": {
      const out: VisibleBranchUserEntry = {
        ...base,
        role: "user",
        content: normalizeUserContent(message.content),
      };
      if (timestamp !== undefined) out.timestamp = timestamp;
      return out;
    }
    case "assistant": {
      const out: VisibleBranchAssistantEntry = {
        ...base,
        role: "assistant",
        model: message.model,
        provider: message.provider,
        content: normalizeAssistantContent(message.content),
      };
      if (message.stopReason !== undefined) out.stopReason = message.stopReason;
      if (message.errorMessage !== undefined) out.errorMessage = message.errorMessage;
      if (timestamp !== undefined) out.timestamp = timestamp;
      // usage / writtenFiles intentionally omitted
      return out;
    }
    case "toolResult": {
      const out: VisibleBranchToolResultEntry = {
        ...base,
        role: "toolResult",
        id: message.toolCallId,
        content: normalizeToolResultContent(message.content),
      };
      if (message.toolName !== undefined) out.name = message.toolName;
      if (message.isError !== undefined) out.isError = message.isError;
      if (timestamp !== undefined) out.timestamp = timestamp;
      // details intentionally omitted
      return out;
    }
    case "custom": {
      const out: VisibleBranchCustomEntry = {
        ...base,
        role: "custom",
        customType: message.customType,
        display: message.display,
        content: normalizeUserContent(message.content),
      };
      if (timestamp !== undefined) out.timestamp = timestamp;
      // details intentionally omitted; display:false still retained
      return out;
    }
    case "bashExecution": {
      const out: VisibleBranchBashEntry = {
        ...base,
        role: "bashExecution",
        command: message.command,
        // Export raw output — never invent the UI `(no output)` sentinel.
        output: message.output,
      };
      if (message.exitCode !== undefined) out.exitCode = message.exitCode;
      if (message.cancelled !== undefined) out.cancelled = message.cancelled;
      if (message.truncated !== undefined) out.truncated = message.truncated;
      if (message.excludeFromContext !== undefined) {
        out.excludeFromContext = message.excludeFromContext;
      }
      if (timestamp !== undefined) out.timestamp = timestamp;
      // fullOutputPath intentionally omitted
      return out;
    }
    default: {
      const _exhaustive: never = message;
      void _exhaustive;
      throw new VisibleBranchExportError(VISIBLE_BRANCH_EXPORT_ERROR);
    }
  }
}

/**
 * Build the frozen document from a SessionContext. Throws VisibleBranchExportError
 * (fixed UI message) on any JSON-unsafe toolCall.input or projection failure.
 */
export function buildVisibleBranchDocument(
  context: SessionContext,
  options: { exportedAt?: string } = {},
): VisibleBranchDocument {
  try {
    const entries = context.entries.map(projectEntry);
    const doc: VisibleBranchDocument = {
      format: VISIBLE_BRANCH_FORMAT,
      version: VISIBLE_BRANCH_VERSION,
      scope: VISIBLE_BRANCH_SCOPE,
      disclaimer: VISIBLE_BRANCH_DISCLAIMER,
      exportedAt: options.exportedAt ?? new Date().toISOString(),
      sessionId: context.sessionId,
      entries,
    };
    if (context.leafId !== undefined) doc.leafId = context.leafId;
    return doc;
  } catch (cause) {
    if (cause instanceof VisibleBranchExportError) throw cause;
    throw new VisibleBranchExportError(VISIBLE_BRANCH_EXPORT_ERROR);
  }
}

/**
 * Serialize with pretty JSON + trailing newline, then escape literal
 * `& < > U+2028 U+2029` to unicode escapes. JSON.parse of the result must
 * recover the original document content.
 */
export function serializeVisibleBranchDocument(doc: VisibleBranchDocument): string {
  const raw = `${JSON.stringify(doc, null, 2)}\n`;
  return raw
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function defaultDownloadDeps(): DownloadDeps {
  return {
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    appendChild: (node) => {
      document.body.appendChild(node);
    },
    removeChild: (node) => {
      node.remove();
    },
    createElement: (tag) => document.createElement(tag),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    Blob,
  };
}

/**
 * Build + serialize first, then trigger a browser download via a temporary
 * object URL. Cleanup (remove anchor + delayed revoke) always runs and swallows
 * errors so a failed cleanup never surfaces as the export failure.
 */
export function downloadVisibleBranch(
  context: SessionContext,
  options: {
    deps?: Partial<DownloadDeps>;
    exportedAt?: string;
  } = {},
): { filename: string; bytes: string } {
  const doc = buildVisibleBranchDocument(context, {
    ...(options.exportedAt === undefined ? {} : { exportedAt: options.exportedAt }),
  });
  const bytes = serializeVisibleBranchDocument(doc);
  const filename = buildVisibleBranchFilename(context.sessionId);

  const deps: DownloadDeps = { ...defaultDownloadDeps(), ...options.deps };
  let objectUrl: string | null = null;
  let anchor: HTMLAnchorElement | null = null;
  let downloadError: VisibleBranchExportError | null = null;
  try {
    const blob = new deps.Blob([bytes], { type: "application/json;charset=utf-8" });
    objectUrl = deps.createObjectURL(blob);
    anchor = deps.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.style.display = "none";
    anchor.setAttribute("aria-hidden", "true");
    deps.appendChild(anchor);
    anchor.click();
  } catch {
    downloadError = new VisibleBranchExportError(VISIBLE_BRANCH_EXPORT_ERROR);
  } finally {
    // Cleanup must never mask the fixed export result/error: swallow remove,
    // setTimeout scheduling, and revoke failures independently.
    if (anchor) {
      try {
        deps.removeChild(anchor);
      } catch {
        // swallow cleanup errors
      }
    }
    if (objectUrl) {
      const url = objectUrl;
      try {
        deps.setTimeout(() => {
          try {
            deps.revokeObjectURL(url);
          } catch {
            // swallow cleanup errors
          }
        }, 0);
      } catch {
        // swallow schedule failures so they never cover the export outcome
      }
    }
  }

  if (downloadError) throw downloadError;
  return { filename, bytes };
}
