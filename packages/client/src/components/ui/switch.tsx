/**
 * Shared switch (components/ui): the 40×22 pill, 16px thumb, accent when on.
 * Replaces the Toggle/SettingToggle pair — the switch control itself lives
 * here; row layout (label + description + control) stays with the settings
 * row primitives. All metrics are CSS classes in globals.css.
 */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  loading,
  id,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible name — used for aria-label and the hover title. */
  label: string;
  disabled?: boolean | undefined;
  loading?: boolean | undefined;
  id?: string;
}) {
  const busy = loading === true;
  const blocked = disabled || busy;
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={blocked}
      aria-label={label}
      title={label}
      className={busy ? "ui-switch is-busy" : "ui-switch"}
      style={{ cursor: busy ? "wait" : disabled ? "not-allowed" : "pointer" }}
      onClick={() => {
        if (!blocked) onChange(!checked);
      }}
    >
      <span className="ui-switch-thumb" />
    </button>
  );
}
