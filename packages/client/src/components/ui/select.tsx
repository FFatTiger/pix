import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n } from "@/hooks/useI18n";
import { MenuItem, MenuGroupLabel, Popover, anchorRectOf, useMenuDismiss, type AnchorRect } from "./menu";

/**
 * Single-select dropdown on the shared menu primitives. Two trigger
 * variants, one component: "form" is the bordered full-width settings
 * control (the native <select> it replaces), "toolbar" is the borderless
 * compact composer control. The menu always speaks the tuned language:
 * content surface, 12px radius, 30px rows, optional search and groups.
 */

export interface SelectOption {
  value: string;
  label: string;
  /** Group label; options sharing it render under one group header. */
  group?: string;
  /** Extra search keywords (e.g. the model id when the label is a name). */
  keywords?: string;
  icon?: ReactNode;
}

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  /** Plain string options, or { value, label, group?, keywords? } objects. */
  options: readonly (string | SelectOption)[];
  /** Label for the empty "inherit / none" option. Only rendered when provided. */
  emptyLabel?: string;
  /** Show the search field (long lists). Default: on when there are 8+ options. */
  searchable?: boolean;
  disabled?: boolean;
  variant?: "form" | "toolbar";
  placeholder?: string;
  id?: string;
  style?: CSSProperties;
  "aria-label"?: string;
  /** Extra class kept on the trigger (phone CSS hooks at call sites). */
  className?: string;
}

interface NormalizedOption extends SelectOption {
  search: string;
}

function normalizeOptions(options: readonly (string | SelectOption)[]): NormalizedOption[] {
  return options.map((o) => {
    const opt: SelectOption = typeof o === "string" ? { value: o, label: o } : o;
    return { ...opt, search: `${opt.label} ${opt.value} ${opt.group ?? ""} ${opt.keywords ?? ""}`.toLowerCase() };
  });
}

export function Select({
  value,
  onChange,
  options,
  emptyLabel,
  searchable,
  disabled = false,
  variant = "form",
  placeholder,
  id,
  style,
  className,
  "aria-label": ariaLabel,
}: SelectProps) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<AnchorRect | null>(null);
  const [search, setSearch] = useState("");

  const normalized = useMemo(() => normalizeOptions(options), [options]);
  const withEmpty = useMemo(
    () => (emptyLabel !== undefined ? [{ value: "", label: emptyLabel, search: emptyLabel.toLowerCase() }, ...normalized] : normalized),
    [emptyLabel, normalized],
  );
  const showSearch = searchable ?? withEmpty.length >= 8;

  const query = search.trim().toLowerCase();
  const filtered = query ? withEmpty.filter((o) => o.search.includes(query)) : withEmpty;

  const groups = useMemo(() => {
    const out: { label: string; options: NormalizedOption[] }[] = [];
    for (const opt of filtered) {
      if (!opt.group) continue;
      const group = out.find((g) => g.label === opt.group);
      if (group) group.options.push(opt);
      else out.push({ label: opt.group, options: [opt] });
    }
    return out;
  }, [filtered]);
  const hasGroups = groups.length > 0;
  const loose = hasGroups ? filtered.filter((o) => !o.group) : filtered;

  const current = withEmpty.find((o) => o.value === value);

  useMenuDismiss(open, () => setOpen(false), (target) => rootRef.current?.contains(target) ?? false, { escape: true });

  const openMenu = (trigger: HTMLElement): void => {
    setRect(anchorRectOf(trigger));
    setSearch("");
    setOpen(true);
    // Desktop focuses the search field so typing filters immediately; on
    // iOS focusing would summon the keyboard and zoom the page, so the list
    // stays visible and search waits for an explicit tap (model-picker rule).
    if (showSearch && !isMobile) {
      window.requestAnimationFrame(() => searchRef.current?.focus());
    }
  };

  // Opening lands on the current value: the selected row scrolls into view
  // (it may sit deep in a long, grouped list) and keyboard navigation
  // starts from it — like the model picker and the native select it replaced.
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      panelRef.current?.querySelector(".ui-menu-item.is-selected")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const enabledRows = (): HTMLButtonElement[] => (
    [...(panelRef.current?.querySelectorAll<HTMLButtonElement>(".ui-menu-item:not(:disabled)") ?? [])]
  );

  /** Focus the selected row (fallback first/last) without scrolling it. */
  const focusFrom = (end: boolean): void => {
    const rows = enabledRows();
    if (rows.length === 0) return;
    const selected = panelRef.current?.querySelector<HTMLButtonElement>(".ui-menu-item.is-selected:not(:disabled)");
    (selected ?? (end ? rows[rows.length - 1] : rows[0]))?.focus();
  };

  /** Roving keyboard focus inside the open list (bubbles up from rows). */
  const onPanelKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Escape") return;
    const rows = enabledRows();
    if (rows.length === 0) return;
    const from = e.target instanceof HTMLButtonElement ? rows.indexOf(e.target) : -1;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (from === -1) focusFrom(false);
      else rows[Math.min(rows.length - 1, from + 1)]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (from === -1) focusFrom(true);
      else rows[Math.max(0, from - 1)]?.focus();
    } else if (from >= 0) {
      // Escape on a row closes and returns focus to the trigger (the search
      // field handles its own Escape: clear query first, then close).
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    }
  };

  const select = (next: string): void => {
    setOpen(false);
    if (next !== value) onChange(next);
  };

  const row = (opt: NormalizedOption, g?: string) => (
    <MenuItem
      key={`${g ?? ""}:${opt.value}`}
      selected={opt.value === value}
      icon={opt.icon}
      disabled={disabled}
      onClick={() => select(opt.value)}
      {...(opt.value !== opt.label ? { title: opt.value } : {})}
    >
      {opt.label}
    </MenuItem>
  );

  return (
    <div ref={rootRef} className={`ui-select${variant === "form" ? " ui-select-form-wrap" : ""}`} style={{ position: "relative", display: variant === "form" ? "inline-flex" : "inline-flex", minWidth: 0, ...style }}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className={`ui-trigger ${variant === "form" ? "ui-select-form" : ""}${className ? ` ${className}` : ""}`}
        style={{ position: "relative", ...(variant === "toolbar" ? { maxWidth: "100%" } : undefined), ...(variant === "form" ? { width: "100%" } : undefined) }}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={(e) => {
          if (open) setOpen(false);
          else openMenu(e.currentTarget);
        }}
        onKeyDown={(e) => {
          // Without the search field the trigger keeps focus while the list
          // is open; arrows enter the list at the selected row.
          if (open && !showSearch && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            focusFrom(e.key === "ArrowUp");
          }
        }}
      >
        {variant === "toolbar" && current?.icon}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: variant === "toolbar" ? "0 1 auto" : "1" }}>
          {current?.label ?? placeholder ?? ""}
        </span>
        <CaretDownIcon size={variant === "form" ? 12 : 10} weight="bold" aria-hidden="true" className={variant === "form" ? "ui-select-form-caret" : "ui-caret"} style={variant === "form" ? { position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)" } : undefined} />
      </button>
      {open && rect && (
        <Popover
          rect={rect}
          offset={variant === "form" ? 6 : 4}
          prefer={variant === "form" ? "bottom" : "top"}
          align="left"
          minWidth={Math.max(200, rect.width)}
          maxWidth={400}
          maxHeightCap={360}
          style={{ display: "flex", flexDirection: "column" }}
        >
          <div ref={panelRef} onKeyDown={onPanelKeyDown} style={{ overflowY: "auto", minHeight: 0, display: "flex", flexDirection: "column", gap: 2, padding: 4 }}>
            {showSearch && (
              <div className="ui-menu-search" style={{ margin: "-4px -4px 2px" }}>
                <div className="ui-menu-search-inner">
                  <MagnifyingGlassIcon size={13} className="ui-menu-search-icon" />
                  <input
                    ref={searchRef}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        if (search) setSearch("");
                        else setOpen(false);
                      } else if (e.key === "ArrowDown") {
                        e.preventDefault();
                        focusFrom(false);
                      }
                    }}
                    placeholder={t("desktop.searchModels")}
                    aria-label={ariaLabel}
                    style={isMobile ? { fontSize: 16 } : undefined}
                  />
                </div>
              </div>
            )}
            {loose.length > 0 && loose.map((opt) => row(opt))}
            {hasGroups && loose.length > 0 && groups[0] && <div style={{ borderTop: "1px solid var(--surface-hairline)", margin: "2px -4px" }} />}
            {groups.map((group) => (
              <div key={group.label} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <MenuGroupLabel>{group.label}</MenuGroupLabel>
                {group.options.map((opt) => row(opt, group.label))}
              </div>
            ))}
            {filtered.length === 0 && (
              <div style={{ padding: "14px 12px", textAlign: "center", fontSize: 12, color: "var(--text-dim)" }}>
                {t("desktop.noModelsMatch")}
              </div>
            )}
          </div>
        </Popover>
      )}
    </div>
  );
}
