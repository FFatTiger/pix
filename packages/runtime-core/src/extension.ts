/**
 * Canonical extension UI model — requests, status items and widgets.
 * No extension/SDK objects cross this boundary; the adapter renders backend
 * extension UI state into these serializable shapes.
 */

import type { QuestionnaireQuestion } from "./questionnaire.js";

export const EXTENSION_UI_METHODS = [
  "select",
  "confirm",
  "input",
  "editor",
  "notify",
  "setStatus",
  "setWidget",
  "setTitle",
  "set_editor_text",
  "custom",
  "questionnaire",
] as const;

export type ExtensionUiMethod = (typeof EXTENSION_UI_METHODS)[number];

export type ExtensionWidgetPlacement = "aboveEditor" | "belowEditor";

export interface ExtensionStatusItem {
  key: string;
  text: string;
}

export interface ExtensionWidgetItem {
  key: string;
  lines: readonly string[];
  placement: ExtensionWidgetPlacement;
}

/** Non-error extension notifications (`ctx.ui.notify` with info/warning).
 * Kept as a bounded most-recent ring; errors stay the structured
 * `extension_error` event and are never demoted to notices. */
export const MAX_EXTENSION_NOTIFICATIONS = 20;

export interface ExtensionNotificationItem {
  level: "info" | "warning";
  message: string;
  /** Emission time (epoch ms) for ordering/age display. */
  at: number;
}

/**
 * A pending UI request from an extension. Method-specific fields:
 *
 * - select       → title, options
 * - confirm      → title, message
 * - input        → title, placeholder?
 * - editor       → title, prefill?
 * - notify       → message, notifyType
 * - setStatus    → statusKey, statusText
 * - setWidget    → widgetKey, widgetLines, widgetPlacement
 * - setTitle     → title
 * - set_editor_text → text
 * - custom       → lines
 * - questionnaire → questions
 */
export interface ExtensionUiRequest {
  id: string;
  method: ExtensionUiMethod;
  timeout?: number;
  expiresAt?: number;
  title?: string;
  message?: string;
  options?: readonly string[];
  placeholder?: string;
  prefill?: string;
  notifyType?: "info" | "warning" | "error";
  statusKey?: string;
  statusText?: string;
  widgetKey?: string;
  widgetLines?: readonly string[];
  widgetPlacement?: ExtensionWidgetPlacement;
  text?: string;
  lines?: readonly string[];
  questions?: readonly QuestionnaireQuestion[];
  closed?: boolean;
}

/** Snapshot projection of a pending extension UI request (reconnect/replay). */
export type PendingExtensionUi = ExtensionUiRequest;
