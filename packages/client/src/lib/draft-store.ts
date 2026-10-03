export interface ChatDraftImage {
  data: string;
  mimeType: string;
}

/**
 * Browser File objects cannot be serialized safely. They remain in this
 * process-local draft layer so session switches and new-session promotion do
 * not lose pending attachments; a page reload intentionally drops them.
 */
export interface ChatDraftFile {
  id: string;
  name: string;
  kind: "upload" | "reference";
  file?: File;
  mentionPath?: string;
}

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
}

// In-memory working copy, mirrored to localStorage so unsent input survives a
// page refresh. The Map keeps the hot path synchronous; persistence is
// best-effort (image-heavy drafts may exceed the storage quota — in that case
// the in-memory draft still works, it just won't survive a refresh).
const drafts = new Map<string, ChatDraft>();
const draftFiles = new Map<string, ChatDraftFile[]>();

const STORAGE_KEY = "pi-drafts";

let loaded = false;

function ensureLoaded(): void {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return;
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const { key, draft } = entry as { key?: unknown; draft?: unknown };
      if (typeof key !== "string" || typeof draft !== "object" || draft === null) continue;
      drafts.set(key, draft as ChatDraft);
    }
  } catch {
    // Ignore corrupt storage data.
  }
}

function persist(): void {
  if (typeof window === "undefined") return;
  try {
    if (drafts.size === 0) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([...drafts].map(([key, draft]) => ({ key, draft }))),
    );
  } catch {
    // Quota exceeded or storage unavailable — keep the in-memory draft only.
  }
}

function cloneDraft(draft: ChatDraft): ChatDraft {
  return {
    value: draft.value,
    images: draft.images.map((image) => ({ ...image })),
  };
}

function isEmptyDraft(draft: ChatDraft): boolean {
  return !draft.value && draft.images.length === 0;
}

export function getDraft(key: string): ChatDraft | null {
  ensureLoaded();
  const draft = drafts.get(key);
  return draft ? cloneDraft(draft) : null;
}

export function setDraft(key: string, draft: ChatDraft): void {
  ensureLoaded();
  if (isEmptyDraft(draft)) {
    drafts.delete(key);
  } else {
    drafts.set(key, cloneDraft(draft));
  }
  persist();
}

export function getDraftFiles(key: string): ChatDraftFile[] {
  return (draftFiles.get(key) ?? []).map((file) => ({ ...file }));
}

export function setDraftFiles(key: string, files: readonly ChatDraftFile[]): void {
  if (files.length === 0) {
    draftFiles.delete(key);
    return;
  }
  draftFiles.set(key, files.map((file) => ({ ...file })));
}

export function clearDraft(key: string): void {
  ensureLoaded();
  drafts.delete(key);
  draftFiles.delete(key);
  persist();
}
