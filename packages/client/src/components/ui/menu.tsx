import { useEffect, type CSSProperties, type ReactNode } from "react";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { cssPx } from "@/lib/ui-scale";

/**
 * Shared menu primitives (components/ui): the 2026-10 tuned menu language.
 *
 * `Popover` is the fixed-position panel shell the toolbar menus use: it
 * anchors its bottom edge above the trigger rect (in CSS px, aware of
 * visual-viewport zoom), clamps into the viewport, and pins to an 8px inset
 * on mobile. `MenuItem` / `MenuGroupLabel` are the 30px rows. All visual
 * values live in the UI-kit section of globals.css — components only pick
 * classes and behavior.
 */

export interface AnchorRect {
  top: number;
  left: number;
  width: number;
}

/** Measure a trigger element into an AnchorRect (CSS px under page zoom). */
export function anchorRectOf(el: HTMLElement): AnchorRect {
  const box = el.getBoundingClientRect();
  return { top: cssPx(box.top), left: cssPx(box.left), width: cssPx(box.width) };
}

export interface PopoverProps {
  /** Trigger rect; the panel stays hidden while null. */
  rect: AnchorRect | null;
  /** Gap between the panel's bottom edge and the trigger's top edge. */
  offset?: number;
  /** Edge of the trigger the panel aligns to (default left). */
  align?: "left" | "right";
  minWidth?: number;
  maxWidth?: number;
  /** Height cap; the panel also never outgrows the space above the trigger. */
  maxHeightCap?: number;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

export function Popover({
  rect,
  offset = 4,
  align = "left",
  minWidth,
  maxWidth,
  maxHeightCap = 360,
  className,
  style,
  children,
}: PopoverProps) {
  if (!rect) return null;
  const vh = cssPx(window.visualViewport?.height ?? window.innerHeight);
  const vw = cssPx(window.innerWidth);
  const maxW = Math.min(maxWidth ?? 400, vw - 16);
  const maxH = Math.min(maxHeightCap, Math.max(120, Math.min(rect.top - 8, vh * 0.6)));
  const bottom = vh - rect.top + offset;
  const position: CSSProperties = align === "right"
    ? { right: Math.max(8, vw - (rect.left + rect.width)), width: "max-content", minWidth: Math.min(rect.width, maxW), maxWidth: maxW }
    : { left: Math.min(rect.left, vw - maxW - 8), minWidth: Math.min(minWidth ?? 200, maxW), maxWidth: maxW };
  return (
    <div
      className={`ui-menu${className ? ` ${className}` : ""}`}
      style={{
        position: "fixed",
        bottom,
        zIndex: 2001,
        maxHeight: maxH,
        overflowY: "auto",
        ...position,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/**
 * Outside-click / Escape dismissal for an open menu. `contains` decides
 * whether a pointer target belongs to the menu's own trigger+panel subtree
 * (each call site owns its wrapper ref, matching the pre-kit behavior).
 */
export function useMenuDismiss(
  open: boolean,
  onClose: () => void,
  contains: (target: Node) => boolean,
  options: { escape?: boolean } = {},
): void {
  const { escape = false } = options;
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (!contains(event.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    let onKey: ((event: KeyboardEvent) => void) | null = null;
    if (escape) {
      onKey = (event: KeyboardEvent): void => {
        if (event.key === "Escape") onClose();
      };
      document.addEventListener("keydown", onKey);
    }
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      if (onKey) document.removeEventListener("keydown", onKey);
    };
    // contains/onClose are call-site refs/stable callbacks; re-binding on
    // identity churn would only churn listeners, not behavior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, escape]);
}

export interface MenuItemProps {
  /** Leading icon slot (14–15px). */
  icon?: ReactNode;
  children: ReactNode;
  /** The active value of the menu: quiet tint + strong weight (+ check). */
  selected?: boolean;
  /** Keyboard-highlighted row of a caret-driven list (slash / @ / history). */
  highlighted?: boolean;
  /** Overrides the automatic check mark; false hides it when selected. */
  showCheck?: boolean;
  disabled?: boolean;
  /** Right-aligned dim hint (a path, a count). */
  hint?: ReactNode;
  /** Trailing slot rendered after the label (favorite star, check order). */
  trailing?: ReactNode;
  title?: string;
  onClick?: () => void;
  /** Row metrics: menu families differ (toolbar 4/10, list popovers tighter). */
  padding?: string;
  borderRadius?: number;
  fontSize?: number;
  /** Render the row in the mono font (@ file paths, model ids). */
  mono?: boolean;
  className?: string;
  style?: CSSProperties;
  onMouseDown?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  refCallback?: (node: HTMLButtonElement | null) => void;
}

export function MenuItem({
  icon,
  children,
  selected = false,
  highlighted = false,
  showCheck = selected,
  disabled = false,
  hint,
  trailing,
  title,
  onClick,
  padding,
  borderRadius,
  fontSize,
  mono = false,
  className,
  style,
  onMouseDown,
  onMouseEnter,
  onMouseLeave,
  refCallback,
}: MenuItemProps) {
  const classes = [
    "ui-menu-item",
    selected ? "is-selected" : "",
    highlighted ? "is-highlighted" : "",
    className ?? "",
  ].filter(Boolean).join(" ");
  return (
    <button
      ref={refCallback}
      type="button"
      className={classes}
      disabled={disabled}
      title={title}
      onClick={onClick}
      onMouseDown={onMouseDown}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        ...(padding ? { padding } : undefined),
        ...(borderRadius !== undefined ? { borderRadius } : undefined),
        ...(fontSize !== undefined ? { fontSize } : undefined),
        ...(mono ? { fontFamily: "var(--font-mono)" } : undefined),
        ...style,
      }}
    >
      {icon}
      <span className="ui-menu-item-label">{children}</span>
      {hint ? <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 11, fontVariantNumeric: "tabular-nums" }}>{hint}</span> : null}
      {trailing}
      {showCheck ? (
        <CheckIcon size={12} weight="bold" color="var(--accent)" style={{ flexShrink: 0 }} aria-hidden="true" />
      ) : null}
    </button>
  );
}

export function MenuGroupLabel({
  children,
  trailing,
  onClick,
  className,
  style,
}: {
  children: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
  className?: string;
  style?: CSSProperties;
}) {
  // Clickable when it toggles a collapsible group (provider headers);
  // otherwise a plain non-interactive label (favorites, source groups).
  if (!onClick) {
    return (
      <div className={`ui-menu-group-label${className ? ` ${className}` : ""}`} style={style}>
        {children}
        {trailing}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={`ui-menu-group-label${className ? ` ${className}` : ""}`}
      onClick={onClick}
      style={style}
    >
      {children}
      {trailing}
    </button>
  );
}
