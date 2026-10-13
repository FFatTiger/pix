import type { CSSProperties, ReactNode } from "react";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";

/**
 * Shared buttons (components/ui). `Button` is the settings form button
 * (default / primary / danger × sm / md — the SettingsButton metrics).
 * `ToolbarButton` and `IconButton` are the 28px composer-toolbar targets:
 * text (+icon, +caret) and square icon respectively. Hover, press scale and
 * the keyboard focus ring are CSS-only in the UI-kit section of globals.css.
 */

export function Button({
  variant = "default",
  size = "md",
  type = "button",
  disabled,
  onClick,
  title,
  children,
  style,
  testId,
  id,
}: {
  variant?: "default" | "primary" | "danger";
  size?: "sm" | "md";
  type?: "button" | "submit";
  disabled?: boolean;
  onClick?: () => void;
  title?: string;
  children: ReactNode;
  style?: CSSProperties;
  testId?: string;
  id?: string;
}) {
  const classes = [
    "ui-btn",
    variant !== "default" ? `ui-btn--${variant}` : "",
    `ui-btn--${size}`,
  ].filter(Boolean).join(" ");
  return (
    <button
      id={id}
      type={type}
      className={classes}
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-testid={testId}
      style={style}
    >
      {children}
    </button>
  );
}

export function ToolbarButton({
  icon,
  children,
  caret = false,
  open = false,
  disabled = false,
  tone,
  title,
  ariaLabel,
  ariaHasPopup,
  onClick,
  className,
  style,
}: {
  /** Leading icon (15px slot). */
  icon?: ReactNode;
  children?: ReactNode;
  /** Trailing dropdown caret. */
  caret?: boolean;
  /** Open state: keeps the quiet tint while its menu is open. */
  open?: boolean;
  disabled?: boolean;
  /** "accent": base and hover color stay the accent (unset state). */
  tone?: "default" | "accent";
  title?: string;
  ariaLabel?: string;
  ariaHasPopup?: "menu" | "listbox" | "true";
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  className?: string;
  style?: CSSProperties;
}) {
  const classes = [
    "ui-trigger",
    tone === "accent" ? "ui-trigger--accent" : "",
    className ?? "",
  ].filter(Boolean).join(" ");
  return (
    <button
      type="button"
      className={classes}
      style={style}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      aria-haspopup={ariaHasPopup}
      aria-expanded={open || undefined}
      onClick={onClick}
    >
      {icon}
      {children}
      {caret ? <CaretDownIcon size={10} weight="bold" aria-hidden="true" className="ui-caret" /> : null}
    </button>
  );
}

export function IconButton({
  children,
  open = false,
  disabled = false,
  title,
  ariaLabel,
  ariaHasPopup,
  ariaPressed,
  onClick,
  className,
  style,
  color,
}: {
  children: ReactNode;
  open?: boolean;
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
  ariaHasPopup?: "menu" | "listbox" | "true";
  ariaPressed?: boolean;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  className?: string;
  style?: CSSProperties;
  /** Base icon color (hover always returns to --text). */
  color?: string;
}) {
  return (
    <button
      type="button"
      className={`ui-trigger ui-icon-btn${className ? ` ${className}` : ""}`}
      style={{ ...(color ? { color } : undefined), ...style }}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      aria-haspopup={ariaHasPopup}
      aria-expanded={ariaHasPopup ? (open || undefined) : undefined}
      aria-pressed={ariaPressed}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
