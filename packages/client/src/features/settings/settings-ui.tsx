import { useEffect, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { CaretDown, Eye, EyeSlash, WarningCircle } from "@phosphor-icons/react";
import { useI18n } from "@/hooks/useI18n";

/**
 * Shared control primitives for the settings dialogs and panels.
 *
 * All metrics come from the design tokens in globals.css
 * (--control-height / --control-radius / --control-pad-x and the
 * --status-* semantic colors), so every settings surface renders
 * with the same height, radius, padding and font size, and follows
 * the active pi CLI theme.
 */

export const inputStyle: CSSProperties = {
  height: "var(--control-height)",
  padding: "0 var(--control-pad-x)",
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  borderRadius: "var(--control-radius)",
  color: "var(--text)",
  fontSize: 13,
  width: "100%",
  boxSizing: "border-box",
};

/**
 * Settings section: optional title + optional description + controls as a
 * flat full-width block separated from the next section by a hairline
 * divider. Single-section pages omit the title (the page header already
 * names the content) instead of repeating it.
 */
export function SettingsSection({
  title,
  description,
  action,
  children,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      style={{
        padding: "var(--settings-section-gap) var(--settings-pad-x)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      {title || description || action ? (
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 14 }}>
          <div style={{ minWidth: 0 }}>
            {title ? <h2 style={{ margin: 0, fontSize: 14, fontWeight: 650, color: "var(--text)" }}>{title}</h2> : null}
            {description ? (
              <p style={{ margin: title ? "5px 0 0" : 0, fontSize: 12, lineHeight: 1.5, color: "var(--text-muted)" }}>{description}</p>
            ) : null}
          </div>
          {action ? <div style={{ flexShrink: 0 }}>{action}</div> : null}
        </div>
      ) : null}
      <div>{children}</div>
    </section>
  );
}

/**
 * Settings row: label (with optional one-line description) on the left,
 * the control on the right. The single row rhythm used by every page.
 */
export function SettingsRow({
  label,
  description,
  htmlFor,
  children,
}: {
  label: string;
  description?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-label">
        <label htmlFor={htmlFor} className="settings-row-title">{label}</label>
        {description ? <span className="settings-row-desc">{description}</span> : null}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

/** Field wrapper: small muted label above the control. */
export function SettingsField({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label htmlFor={htmlFor} style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 500 }}>{label}</label>
      {children}
    </div>
  );
}

export function SettingsInput({
  value,
  onChange,
  placeholder,
  mono,
  type = "text",
  style,
  onKeyDown,
  onBlur,
  onPaste,
  id,
  inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  type?: string;
  style?: CSSProperties;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  onBlur?: (e: React.FocusEvent<HTMLInputElement>) => void;
  onPaste?: (e: React.ClipboardEvent<HTMLInputElement>) => void;
  id?: string;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  return (
    <input
      id={id}
      ref={inputRef}
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      onPaste={onPaste}
      placeholder={placeholder}
      style={{ ...inputStyle, fontFamily: mono ? "var(--font-mono)" : "inherit", ...style }}
    />
  );
}

export function SettingsNumInput({
  value,
  onChange,
  placeholder,
  min,
  step,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  min?: number;
  step?: number | "any";
}) {
  return <input type="number" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} min={min} step={step} style={inputStyle} />;
}

/** Secret input with a show/hide toggle inside the field. */
export function SettingsSecretInput({
  value,
  onChange,
  placeholder,
  mono,
  onKeyDown,
  autoComplete = "off",
  spellCheck = false,
  style,
  showLabel = "Show",
  hideLabel = "Hide",
  id,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  autoComplete?: string;
  spellCheck?: boolean;
  style?: CSSProperties;
  showLabel?: string;
  hideLabel?: string;
  id?: string;
  disabled?: boolean;
}) {
  const [visible, setVisible] = useState(false);

  // Reset visibility when the value is cleared (e.g. switching providers).
  useEffect(() => {
    if (!value) setVisible(false);
  }, [value]);

  return (
    <div style={{ position: "relative", width: "100%", ...style }}>
      <input
        id={id}
        type={visible ? "text" : "password"}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        style={{ ...inputStyle, paddingRight: 34, fontFamily: mono ? "var(--font-mono)" : "inherit", opacity: disabled ? 0.55 : 1 }}
        autoComplete={autoComplete}
        spellCheck={spellCheck}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? hideLabel : showLabel}
        title={visible ? hideLabel : showLabel}
        style={{
          position: "absolute",
          right: 5,
          top: "50%",
          transform: "translateY(-50%)",
          width: 24,
          height: 24,
          padding: 0,
          border: "none",
          background: "transparent",
          color: "var(--text-dim)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {visible ? <EyeSlash size={15} /> : <Eye size={15} />}
      </button>
    </div>
  );
}

export function SettingsSelect({
  value,
  onChange,
  options,
  emptyLabel,
  style,
  id,
  disabled,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Plain string options, or { value, label } pairs when the label differs from the value. */
  options: readonly (string | { value: string; label: string })[];
  /** Label for the empty "inherit / none" option. Only rendered when provided. */
  emptyLabel?: string;
  style?: CSSProperties;
  id?: string;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  return (
    <span className="settings-select-wrap" style={style}>
      <select
        id={id}
        className="settings-select"
        disabled={disabled}
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
        {options.map((o) => {
          const opt = typeof o === "string" ? { value: o, label: o } : o;
          return <option key={opt.value} value={opt.value}>{opt.label}</option>;
        })}
      </select>
      <CaretDown size={12} weight="bold" aria-hidden="true" className="settings-select-caret" />
    </span>
  );
}

/**
 * Segmented control for 2–4 mutually exclusive short options (the settings
 * replacement for "toggle + select" or ad-hoc button groups).
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  disabled,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly { value: T; label: string }[];
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={ariaLabel} data-disabled={disabled ? "true" : undefined}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            className={active ? "segmented-item is-active" : "segmented-item"}
            onClick={() => {
              if (!active) onChange(option.value);
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

type ButtonVariant = "default" | "primary" | "danger";
type ButtonSize = "md" | "sm";

const buttonBase: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 5,
  borderRadius: "var(--control-radius)",
  cursor: "pointer",
  fontSize: 12,
  boxSizing: "border-box",
  transition: "background 0.12s, border-color 0.12s, color 0.12s",
  whiteSpace: "nowrap",
};

function buttonVariantStyle(variant: ButtonVariant): CSSProperties {
  switch (variant) {
    case "primary":
      return { background: "var(--accent)", border: "none", color: "#fff", fontWeight: 600 };
    case "danger":
      return {
        background: "color-mix(in srgb, var(--status-danger) 8%, transparent)",
        border: "1px solid color-mix(in srgb, var(--status-danger) 30%, transparent)",
        color: "var(--status-danger)",
      };
    default:
      return { background: "none", border: "1px solid var(--border)", color: "var(--text-muted)" };
  }
}

function buttonSizeStyle(size: ButtonSize): CSSProperties {
  if (size === "sm") return { height: 24, padding: "0 8px", fontSize: 11 };
  return { height: "var(--control-height)", padding: "0 12px" };
}

export function SettingsButton({
  variant = "default",
  size = "md",
  type = "button",
  disabled,
  onClick,
  title,
  children,
  style,
  testId,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  type?: "button" | "submit";
  disabled?: boolean;
  onClick?: () => void;
  title?: string;
  children: ReactNode;
  style?: CSSProperties;
  testId?: string;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-testid={testId}
      style={{
        ...buttonBase,
        ...buttonVariantStyle(variant),
        ...buttonSizeStyle(size),
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
        ...style,
      }}
    >
      {children}
    </button>
  );
}

type BadgeTone = "default" | "project" | "warning" | "muted" | "success";

export function SettingsBadge({ tone = "default", title, children }: { tone?: BadgeTone; title?: string; children: ReactNode }) {
  const styles: Record<BadgeTone, CSSProperties> = {
    default: {
      background: "color-mix(in srgb, var(--text-dim) 12%, transparent)",
      color: "var(--text-dim)",
    },
    project: {
      background: "color-mix(in srgb, var(--accent-blue) 12%, transparent)",
      color: "var(--accent-blue)",
    },
    warning: {
      background: "color-mix(in srgb, var(--status-warning) 12%, transparent)",
      color: "var(--status-warning)",
    },
    muted: {
      background: "color-mix(in srgb, var(--text-dim) 8%, transparent)",
      color: "var(--text-dim)",
    },
    success: {
      background: "color-mix(in srgb, var(--status-success, var(--accent)) 14%, transparent)",
      color: "var(--status-success, var(--accent))",
    },
  };
  return (
    <span
      title={title}
      style={{
        fontSize: 10,
        padding: "1px 5px",
        borderRadius: 3,
        flexShrink: 0,
        ...styles[tone],
      }}
    >
      {children}
    </span>
  );
}

/**
 * Unified bottom save bar for draft-based settings pages. Hidden until there
 * is something to say: unsaved edits, an in-flight save, a failure worth
 * retrying, or the just-saved confirmation. Renders nothing otherwise.
 */
export function SettingsSaveBar({
  dirty,
  busy,
  saving = false,
  error,
  saved,
  saveDisabled,
  onSave,
  onDiscard,
  "data-testid": testId,
}: {
  dirty: boolean;
  /** Any in-flight exchange (save or authoritative refetch) disables controls. */
  busy: boolean;
  /** A save is in flight — swaps the Save label to its saving state. */
  saving?: boolean;
  /** Fixed, already-localized error copy (empty/null hides it). */
  error: string | null;
  /** True right after a successful save (shows the fixed confirmation). */
  saved: boolean;
  /** Overrides the Save button's disabled computation (e.g. client-side validation). */
  saveDisabled?: boolean;
  onSave: () => void;
  onDiscard: () => void;
  "data-testid"?: string;
}) {
  const { t } = useI18n();
  if (!dirty && !busy && !error && !saved) return null;
  return (
    <footer className="settings-savebar" data-testid={testId}>
      <span
        role={error ? "alert" : "status"}
        className={error ? "settings-savebar-status settings-savebar-status--error" : "settings-savebar-status"}
      >
        {error ?? (dirty || busy ? t("desktop.settingsUnsavedChanges") : t("desktop.modelsSaved"))}
      </span>
      <div className="settings-savebar-actions">
        <SettingsButton disabled={busy} onClick={onDiscard}>{t("desktop.settingsDiscard")}</SettingsButton>
        <SettingsButton variant="primary" disabled={saveDisabled ?? (!dirty || busy)} onClick={onSave}>
          {saving ? t("desktop.modelsSaving") : t("desktop.modelsSave")}
        </SettingsButton>
      </div>
    </footer>
  );
}

/**
 * Danger action with an inline second-step confirmation (never
 * window.confirm): the first click arms the row, the second confirms.
 */
export function SettingsDangerButton({
  label,
  onConfirm,
  disabled,
  size = "sm",
}: {
  label: string;
  onConfirm: () => void;
  disabled?: boolean;
  size?: ButtonSize;
}) {
  const { t } = useI18n();
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return (
      <SettingsButton variant="danger" size={size} disabled={disabled ?? false} onClick={() => setArmed(true)}>
        {label}
      </SettingsButton>
    );
  }
  return (
    <span className="settings-danger-confirm" role="group" aria-label={label}>
      <span className="settings-danger-confirm-text">{t("desktop.settingsConfirmDelete")}</span>
      <SettingsButton size={size} disabled={disabled ?? false} onClick={() => setArmed(false)}>
        {t("desktop.cancel")}
      </SettingsButton>
      <SettingsButton
        variant="danger"
        size={size}
        disabled={disabled ?? false}
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        {t("desktop.confirm")}
      </SettingsButton>
    </span>
  );
}

/**
 * Shared inline warning banner (icon + one line, warning-tinted background).
 */
export function SettingsWarningBanner({ children }: { children: ReactNode }) {
  return (
    <div className="settings-warning-banner" role="note">
      <WarningCircle size={14} weight="fill" aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}
