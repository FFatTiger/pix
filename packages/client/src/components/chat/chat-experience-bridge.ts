/**
 * Chat experience bridge — tiny module-scoped connectors between the sibling
 * chat surfaces the frozen pix AppShell renders as separate children
 * (TranscriptList / Composer). The source shell owned these wires through
 * props on a single ChatWindow; pix keeps the AppShell untouched, so the
 * exact components share three narrowly-typed bridges instead:
 *
 *  - `chatInputHandle`: the Composer's ChatInputHandle (TranscriptList's
 *    MessageView "edit" action restores the user message into the composer).
 *  - `transcriptScrollRef`: the TranscriptList scroll element (ChatInput caps
 *    its floating menus at the transcript's top edge, exactly like source).
 *  - `openFileTarget`: the optional file-open receiver. The pix shell does
 *    not mount a file viewer yet, so `useChatOpenFile()` only hands MessageView
 *    an onOpenFile once a target registers — until then the source components
 *    keep their built-in plain-anchor fallback (no dead handlers).
 *
 * Nothing here touches runtime/protocol state: pure refs + a subscribe gate.
 */
import { useSyncExternalStore, type RefObject } from "react";
import type { ChatInputHandle } from "./ChatInput";

/** Shared composer handle — set by Composer, read by the transcript rows. */
export const chatInputHandle: RefObject<ChatInputHandle | null> = { current: null };

/** Shared transcript scroll element — set by TranscriptList, read by ChatInput. */
export const transcriptScrollRef: RefObject<HTMLDivElement | null> = { current: null };

export type ChatOpenFileHandler = (filePath: string, options?: { initialDisplayMode?: "diff" }) => void;

let openFileTarget: ChatOpenFileHandler | null = null;
const openFileListeners = new Set<() => void>();

function notifyOpenFileListeners(): void {
  for (const listener of openFileListeners) listener();
}

/**
 * Register the chat file-open receiver (a mounted file viewer). Returns the
 * unregister function; registering twice replaces the previous target.
 */
export function registerChatOpenFileTarget(handler: ChatOpenFileHandler | null): () => void {
  openFileTarget = handler;
  notifyOpenFileListeners();
  return () => {
    if (openFileTarget === handler) {
      openFileTarget = null;
      notifyOpenFileListeners();
    }
  };
}

function subscribeOpenFile(listener: () => void): () => void {
  openFileListeners.add(listener);
  return () => openFileListeners.delete(listener);
}

/**
 * The current onOpenFile for MessageView/ProcessGroup. Undefined (not a no-op
 * function) while no receiver is mounted, so the source components render
 * their plain-link fallback instead of a handler that silently does nothing.
 */
export function useChatOpenFile(): ChatOpenFileHandler | undefined {
  const target = useSyncExternalStore(
    subscribeOpenFile,
    () => openFileTarget,
    () => null,
  );
  return target === null ? undefined : target;
}
