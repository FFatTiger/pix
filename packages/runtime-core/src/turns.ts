import type { ImageAttachment, ThinkingLevel } from "./messages.js";
import type { RuntimeError } from "./errors.js";
import type { ModelSelector } from "./model.js";
import type { RuntimeSnapshot } from "./state.js";

/** One authority-owned prompt intent, before transport identities are added. */
export interface RuntimeTurnStart {
  readonly prompt: string;
  readonly images?: readonly ImageAttachment[];
  readonly activationOverrides?: {
    readonly model?: ModelSelector;
    readonly thinkingLevel?: ThinkingLevel;
  };
}

/** Immediate result of the adapter's prompt-admission barrier. */
export type RuntimeTurnAdmission =
  | { readonly ok: true; readonly snapshot: RuntimeSnapshot }
  | { readonly ok: false; readonly error: RuntimeError; readonly snapshot: RuntimeSnapshot };

/** Terminal result of an admitted turn. The entry id is optional until the
 * backend exposes a structural operation-to-entry correlation. */
export type RuntimeTurnTerminal =
  | { readonly ok: true; readonly snapshot: RuntimeSnapshot; readonly userEntryId?: string }
  | { readonly ok: false; readonly error: RuntimeError; readonly snapshot: RuntimeSnapshot; readonly userEntryId?: string };

/** Admission is quick; completion is a separate promise and never holds the
 * caller's ordinary control lane. */
export interface RuntimeTurnHandle {
  readonly admission: RuntimeTurnAdmission;
  readonly completion: Promise<RuntimeTurnTerminal>;
}
