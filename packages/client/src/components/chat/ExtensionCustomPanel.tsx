import { Fragment, useEffect, useRef, type ReactNode } from "react";
import type { ExtensionUiRequest } from "@fffattiger/pix-protocol";
import { useI18n } from "@/hooks/useI18n";
import { normalizeCustomPanelLines, parseAnsiLine } from "@/lib/ansi";

export type ExtensionCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;

/**
 * Exact port of the source `lib/terminal-input.ts` key mapping (the source
 * ChatWindow's custom-ui-terminal feeds every keydown through this). Maps a
 * DOM keydown to raw terminal bytes; returns null when the event must not
 * become terminal input (meta combos, and Ctrl+V which is handled by paste).
 */
interface TerminalKeyEventLike {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

const SPECIAL_KEY_SEQUENCES: Record<string, string> = {
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  Home: "\x1b[H",
  End: "\x1b[F",
  Insert: "\x1b[2~",
  Delete: "\x1b[3~",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  Escape: "\x1b",
  Backspace: "\x7f",
};

const ALT_ARROW_SEQUENCES: Record<string, string> = {
  ArrowLeft: "\x1bb",
  ArrowRight: "\x1bf",
  ArrowUp: "\x1bp",
  ArrowDown: "\x1bn",
};

function legacyCtrlSequence(key: string): string | null {
  if (key.length !== 1) return null;
  const code = key.toUpperCase().charCodeAt(0);
  if (code >= 64 && code <= 95) return String.fromCharCode(code & 0x1f);
  if (key === "?") return "\x7f";
  return null;
}

export function toTerminalKeyData(event: TerminalKeyEventLike): string | null {
  if (event.metaKey) return null;
  if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === "v") return null;

  if (event.ctrlKey && !event.altKey) {
    const control = legacyCtrlSequence(event.key);
    if (control) return control;
  }

  if (event.altKey && !event.ctrlKey) {
    if (event.key === "Backspace") return "\x1b\x7f";
    const arrow = ALT_ARROW_SEQUENCES[event.key];
    if (arrow) return arrow;
    if (event.key.length === 1) return `\x1b${event.key}`;
  }

  if (event.key === "Enter") return event.shiftKey ? "\n" : "\r";
  if (event.key === "Tab") return event.shiftKey ? "\x1b[Z" : "\t";

  return SPECIAL_KEY_SEQUENCES[event.key] ?? null;
}

/** Exact port of the source bracketed-paste wrapper (terminal paste protocol). */
export function asBracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}

function renderAnsiLine(line: string, keyPrefix: string): ReactNode[] {
  return parseAnsiLine(line).map((segment, index) => (
    Object.keys(segment.style).length > 0
      ? <span key={`${keyPrefix}-${index}`} style={segment.style}>{segment.text}</span>
      : segment.text
  ));
}

/**
 * Exact port of the source ExtensionCustomPanel (custom-ui-terminal,
 * components/ChatWindow.tsx). A hidden textarea owns keyboard/IME/paste input
 * exactly like the source: keydown travels through {@link toTerminalKeyData}
 * as raw terminal bytes, pastes become bracketed-paste, IME composition is
 * guarded, and every chunk is forwarded through `onInput` — FIFO ordering,
 * retries and the independent final response slot are owned by the
 * exact controller extension-UI input lane. Close sends `\x03` exactly like the
 * source.
 */
export function ExtensionCustomPanel({
  request,
  onInput,
}: {
  request: ExtensionCustomRequest;
  onInput: (request: ExtensionCustomRequest, data: string) => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const displayLines = normalizeCustomPanelLines(request.lines);

  useEffect(() => {
    inputRef.current?.focus();
  }, [request.id]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 95,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0,0,0,0.18)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(event) => {
          if (!(event.target as HTMLElement).closest("button")) inputRef.current?.focus();
        }}
        style={{
          position: "relative",
          width: "min(920px, 100%)",
          maxHeight: "min(760px, calc(100vh / var(--app-ui-scale, 1) - 40px))",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
          outline: "none",
        }}
      >
        <textarea
          ref={inputRef}
          aria-label={t("desktop.extensionInput")}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const data = toTerminalKeyData(event);
            if (!data) return;
            event.preventDefault();
            event.stopPropagation();
            onInput(request, data);
          }}
          onInput={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const text = event.currentTarget.value;
            event.currentTarget.value = "";
            if (text) onInput(request, text);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            const input = event.currentTarget;
            queueMicrotask(() => {
              const text = input.value;
              input.value = "";
              if (text) onInput(request, text);
            });
          }}
          onPaste={(event) => {
            event.preventDefault();
            const text = event.clipboardData.getData("text");
            if (text) onInput(request, asBracketedPaste(text));
          }}
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            padding: 0,
            border: 0,
            opacity: 0,
            pointerEvents: "none",
          }}
        />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 650 }}>{t("desktop.extensionPanel")}</div>
          <button
            onClick={() => onInput(request, "\x03")}
            style={{
              padding: "5px 9px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            {t("desktop.close")}
          </button>
        </div>
        <pre
          style={{
            margin: 0,
            padding: 14,
            maxHeight: "calc(min(760px, calc(100vh / var(--app-ui-scale, 1) - 40px)) - 48px)",
            overflow: "auto",
            background: "var(--bg-panel)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            lineHeight: 1.45,
            whiteSpace: "pre",
          }}
        >
          {(displayLines.length ? displayLines : [""]).map((line, index, allLines) => (
            <Fragment key={index}>
              {renderAnsiLine(line, `line-${index}`)}
              {index < allLines.length - 1 ? "\n" : null}
            </Fragment>
          ))}
        </pre>
      </div>
    </div>
  );
}
