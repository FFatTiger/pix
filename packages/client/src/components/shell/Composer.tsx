export interface ComposerProps {
  disabled?: boolean;
  readonly?: boolean;
}

/**
 * Readonly-aware composer shell.
 * Not a full ChatInput port — just the integration surface for later migration.
 */
export function Composer({ disabled = true, readonly = true }: ComposerProps) {
  const isLocked = disabled || readonly;

  return (
    <footer className={`composer${isLocked ? " composer--disabled" : ""}`}>
      <div className="composer-inner">
        <textarea
          className="composer-input"
          rows={2}
          placeholder={
            isLocked
              ? "Composer disabled — host has no agent capability"
              : "Message the agent…"
          }
          disabled={isLocked}
          readOnly={isLocked}
          aria-disabled={isLocked}
        />
        <div className="composer-toolbar">
          <span className="composer-status">
            {isLocked ? "readonly" : "ready"}
          </span>
          <button type="button" className="composer-send" disabled={isLocked}>
            Send
          </button>
        </div>
      </div>
    </footer>
  );
}
