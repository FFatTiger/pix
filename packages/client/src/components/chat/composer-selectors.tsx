import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { LightbulbIcon } from "@phosphor-icons/react/Lightbulb";
import { LightningIcon } from "@phosphor-icons/react/Lightning";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { StarFourIcon } from "@phosphor-icons/react/StarFour";
import { StarIcon } from "@phosphor-icons/react/Star";
import { ProviderIcon } from "@/components/chat/ProviderIcon";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { reportPreferenceWrite } from "@/lib/preferences/preference-sync";
import { filterThinkingLevelOptions, type ThinkingLevelOption } from "@/lib/thinking-levels";
import { cssPx } from "@/lib/ui-scale";

/**
 * Shared composer controls: the model picker and the thinking-level picker.
 * One implementation serves the main session composer (ChatInput) and the
 * side-chat composer — identical styling, favorites, and behavior, no forks.
 */

const MODEL_OPTION_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const MODEL_FAVORITES_KEY = "pi-favorite-models";

export interface ModelSelectorOption {
  provider: string;
  modelId: string;
  name: string;
  api?: string | undefined;
}

function compareModelOptions(a: ModelSelectorOption, b: ModelSelectorOption): number {
  return MODEL_OPTION_COLLATOR.compare(a.name || a.modelId, b.name || b.modelId)
    || MODEL_OPTION_COLLATOR.compare(a.provider, b.provider)
    || MODEL_OPTION_COLLATOR.compare(a.modelId, b.modelId);
}

export function ThinkingLevelIcon({ level, size = 14 }: { level: ThinkingLevelOption; size?: number }) {
  if (level === "off") {
    return <LightbulbIcon size={size} weight="regular" color="var(--text-dim)" />;
  }

  if (level === "auto") {
    return <StarFourIcon size={size} weight="regular" color="var(--accent)" />;
  }

  const useFill = ["medium", "high", "xhigh", "max"].includes(level);
  const bulbWeight = useFill ? "fill" : "regular";
  const accentColor = "var(--accent)";

  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <LightbulbIcon size={size} weight={bulbWeight} color={accentColor} />
      {level === "high" && (
        <PlusIcon
          size={Math.round(size * 0.57)}
          weight="bold"
          color={accentColor}
          style={{ position: "absolute", right: -4, top: -1 }}
        />
      )}
      {level === "xhigh" && (
        <LightningIcon
          size={Math.round(size * 0.57)}
          weight="fill"
          color={accentColor}
          style={{ position: "absolute", right: -4, top: -1 }}
        />
      )}
      {level === "max" && (
        <span style={{ position: "absolute", right: -6, top: -1, display: "inline-flex" }}>
          <LightningIcon size={Math.round(size * 0.5)} weight="fill" color={accentColor} style={{ marginRight: -3 }} />
          <LightningIcon size={Math.round(size * 0.5)} weight="fill" color={accentColor} />
        </span>
      )}
    </span>
  );
}

export interface ThinkingLevelSelectorProps {
  thinkingLevel: ThinkingLevelOption | undefined;
  onThinkingLevelChange: (level: ThinkingLevelOption) => void;
  availableThinkingLevels?: string[] | null;
  thinkingLevelMap?: Record<string, string | null> | null;
  disabled?: boolean;
  /** Fixed title override (the default describes changing the level). */
  title?: string;
  /** Offer the "auto" entry (main composer only — the wire contract has no auto level). */
  includeAuto?: boolean;
}

export function ThinkingLevelSelector({
  thinkingLevel,
  onThinkingLevelChange,
  availableThinkingLevels,
  thinkingLevelMap,
  disabled = false,
  title,
  includeAuto = true,
}: ThinkingLevelSelectorProps) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);

  const displayLabel = (() => {
    const lvl = thinkingLevel ?? "auto";
    if (lvl === "auto" || !thinkingLevelMap) return lvl;
    return thinkingLevelMap[lvl] ?? lvl;
  })();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  return (
    <div ref={rootRef} className="chat-input-toolbar-thinking" style={{ position: "relative" }}>
      <button
        type="button"
        disabled={disabled}
        onClick={(e) => {
          const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setRect({ top: cssPx(box.top), left: cssPx(box.left), width: cssPx(box.width) });
          setOpen((v) => !v);
        }}
        title={title ?? t("desktop.changeReasoningLevel", { level: displayLabel })}
        aria-label={t("desktop.reasoningLevel")}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
          padding: isMobile ? "0 5px" : "3px 7px",
          width: isMobile ? "auto" : undefined,
          height: 24,
          background: open ? "var(--bg-hover)" : "none",
          border: "none",
          borderRadius: 6,
          color: (thinkingLevel ?? "auto") === "off" ? "var(--text-dim)" : "var(--accent)",
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.55 : 1,
          fontSize: 12,
          transition: "background 0.12s, color 0.12s",
        }}
        onMouseEnter={(e) => {
          if (disabled) return;
          e.currentTarget.style.background = "var(--bg-hover)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = open ? "var(--bg-hover)" : "none";
        }}
      >
        <ThinkingLevelIcon level={thinkingLevel ?? "auto"} />
        <span style={{ whiteSpace: "nowrap" }}>{displayLabel}</span>
        <CaretDownIcon
          size={11}
          weight="bold"
          aria-hidden="true"
          style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.12s" }}
        />
      </button>
      {open && rect && (() => {
        const vh = cssPx(window.visualViewport?.height ?? window.innerHeight);
        const vw = cssPx(window.innerWidth);
        const panelMaxW = Math.min(240, vw - 16);
        // Anchor the menu's bottom-right to the selector's top-right.
        const l = Math.min(rect.left, vw - panelMaxW - 8);
        const b = vh - rect.top + 4;
        const maxH = Math.min(360, Math.max(120, Math.min(rect.top - 8, vh * 0.6)));
        return (
          <div className="chat-input-menu-panel" style={{
            position: "fixed", bottom: b, left: l,
            zIndex: 2001, background: "var(--bg-panel)", border: "1px solid var(--border)",
            borderRadius: 8, boxShadow: "0 4px 24px rgba(0,0,0,0.12)",
            overflow: "hidden", minWidth: 200, maxWidth: panelMaxW, maxHeight: maxH, overflowY: "auto",
          }}>
            <div style={{ padding: 4, display: "flex", flexDirection: "column", gap: 2 }}>
              {filterThinkingLevelOptions(availableThinkingLevels).filter((lvl) => includeAuto || lvl !== "auto").map((lvl) => {
                const isActive = (thinkingLevel ?? "auto") === lvl;
                const mappedVal = (lvl !== "auto" && thinkingLevelMap) ? thinkingLevelMap[lvl] : undefined;
                const levelLabel = (mappedVal != null && mappedVal !== lvl) ? mappedVal : lvl;
                const showOriginal = mappedVal != null && mappedVal !== lvl;
                return (
                  <button
                    key={lvl}
                    type="button"
                    disabled={disabled}
                    onClick={() => { setOpen(false); if (!isActive) onThinkingLevelChange(lvl); }}
                    style={{
                      display: "flex", alignItems: "center", gap: 8,
                      width: "100%", padding: "4px 10px",
                      borderRadius: 4,
                      background: isActive ? "var(--bg-selected)" : "none",
                      border: "none",
                      color: isActive ? "var(--accent)" : "var(--text)",
                      cursor: disabled ? "not-allowed" : "pointer", fontSize: 12, textAlign: "left",
                      fontFamily: "var(--font-mono)",
                      whiteSpace: "nowrap",
                      transition: "background 0.1s ease",
                    }}
                    onMouseEnter={(e) => { if (!isActive && !disabled) e.currentTarget.style.background = "var(--bg-hover)"; }}
                    onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "none"; }}
                  >
                    <ThinkingLevelIcon level={lvl} size={14} />
                    <span style={{ flex: 1 }}>
                      {levelLabel}
                      {showOriginal && <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: 5 }}>({lvl})</span>}
                    </span>
                    {isActive && <CheckIcon size={12} weight="bold" color="var(--accent)" style={{ flexShrink: 0 }} />}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

export interface ModelSelectorProps {
  model: { provider: string; modelId: string } | null;
  modelList: readonly { id: string; name: string; provider: string; api?: string }[];
  onModelChange: (provider: string, modelId: string) => void;
  /** Allow re-selecting the active model (auto model selection). */
  allowReselect?: boolean;
  disabled?: boolean;
  /** Fixed title override (the default describes changing the model). */
  title?: string;
  /** No-model placeholder label. */
  emptyLabel?: string;
}

export function ModelSelector({
  model,
  modelList,
  onModelChange,
  allowReselect = false,
  disabled = false,
  title,
  emptyLabel,
}: ModelSelectorProps) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const [search, setSearch] = useState("");
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(MODEL_FAVORITES_KEY);
      return new Set(stored ? (JSON.parse(stored) as string[]) : []);
    } catch {
      return new Set();
    }
  });
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());

  const modelOptions = useMemo<ModelSelectorOption[]>(
    () => modelList
      .map((m) => ({ provider: m.provider, modelId: m.id, name: m.name, api: m.api }))
      .sort(compareModelOptions),
    [modelList],
  );

  const modelsByProvider = useMemo(() => {
    const groups: { provider: string; options: ModelSelectorOption[] }[] = [];
    for (const opt of modelOptions) {
      const group = groups.find((g) => g.provider === opt.provider);
      if (group) group.options.push(opt);
      else groups.push({ provider: opt.provider, options: [opt] });
    }
    return groups;
  }, [modelOptions]);

  const currentModelOption = model
    ? modelOptions.find((o) => o.modelId === model.modelId && o.provider === model.provider)
    : undefined;
  // A detached session can have no persisted model. Keep that state honest
  // while still allowing the user to choose a model; never substitute the
  // catalog default/first item.
  const currentName = currentModelOption?.name ?? model?.modelId ?? emptyLabel ?? t("desktop.modelsSelectProviderOrModel");

  const toggleFavorite = (provider: string, modelId: string): void => {
    setFavorites((prev) => {
      const key = `${provider}:${modelId}`;
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      localStorage.setItem(MODEL_FAVORITES_KEY, JSON.stringify([...next]));
      reportPreferenceWrite(MODEL_FAVORITES_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  const toggleProviderExpand = (provider: string): void => {
    setExpandedProviders((prev) => {
      const next = new Set(prev);
      if (next.has(provider)) next.delete(provider); else next.add(provider);
      return next;
    });
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      const insideRoot = rootRef.current?.contains(event.target as Node) ?? false;
      const insidePanel = panelRef.current?.contains(event.target as Node) ?? false;
      if (!insideRoot && !insidePanel) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  // Opening the picker must not focus the search field: on iOS that both
  // summons the keyboard and zooms the page. Keep the current model visible
  // instead, while leaving search available after an explicit tap.
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const currentRow = panelRef.current?.querySelector<HTMLElement>('[data-current-model="true"]');
      currentRow?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, currentModelOption?.modelId, currentModelOption?.provider]);

  if (modelOptions.length === 0) return null;

  const select = (opt: ModelSelectorOption): void => {
    const isActive = opt.modelId === model?.modelId && opt.provider === model?.provider;
    setOpen(false);
    if (!isActive || allowReselect) onModelChange(opt.provider, opt.modelId);
  };

  const renderRow = (opt: ModelSelectorOption): ReactNode => {
    const isActive = opt.modelId === model?.modelId && opt.provider === model?.provider;
    const isFav = favorites.has(`${opt.provider}:${opt.modelId}`);
    return (
      <div
        key={`${opt.provider}:${opt.modelId}`}
        className="model-row"
        data-current-model={isActive ? "true" : undefined}
        style={{ display: "flex", alignItems: "center", margin: "0 4px" }}
      >
        <button
          type="button"
          disabled={disabled}
          onClick={() => select(opt)}
          style={{
            display: "flex", alignItems: "center", gap: 8,
            flex: 1, minWidth: 0,
            padding: "4px 8px",
            borderRadius: 4,
            background: isActive ? "var(--bg-selected)" : "none",
            border: "none",
            color: isActive ? "var(--accent)" : "var(--text)",
            cursor: disabled ? "not-allowed" : "pointer", fontSize: 12, textAlign: "left",
            fontFamily: "var(--font-mono)",
            whiteSpace: "nowrap", overflow: "hidden",
            transition: "background 0.1s ease",
          }}
          onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "none"; }}
        >
          <ProviderIcon id={opt.provider} api={opt.api ?? null} size={14} />
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{opt.name}</span>
          {isActive && <CheckIcon size={12} weight="bold" color="var(--accent)" style={{ flexShrink: 0 }} />}
          <span
            onClick={(e) => { e.stopPropagation(); toggleFavorite(opt.provider, opt.modelId); }}
            className="model-star"
            style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              flexShrink: 0,
              cursor: "pointer",
              color: isFav ? "var(--accent)" : "var(--text-dim)",
              opacity: isFav ? 1 : 0,
              transition: "opacity 0.12s, color 0.12s",
            }}
            onMouseEnter={(e) => { e.stopPropagation(); e.currentTarget.style.color = "var(--accent)"; }}
            onMouseLeave={(e) => { e.stopPropagation(); e.currentTarget.style.color = isFav ? "var(--accent)" : "var(--text-dim)"; }}
            title={isFav ? t("desktop.unfavorite") : t("desktop.favorite")}
            aria-label={isFav ? t("desktop.unfavorite") : t("desktop.favorite")}
          >
            <StarIcon size={12} weight={isFav ? "fill" : "regular"} />
          </span>
        </button>
      </div>
    );
  };

  return (
    <div ref={rootRef} className="chat-input-toolbar-model" style={{ position: "relative", flex: "0 1 auto", minWidth: 0, width: "auto", maxWidth: isMobile ? 200 : 220 }}>
      <button
        type="button"
        disabled={disabled}
        onClick={(e) => {
          const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setRect({ top: cssPx(box.top), left: cssPx(box.left), width: cssPx(box.width) });
          if (!open) {
            setSearch("");
            if (currentModelOption) {
              setExpandedProviders((current) => {
                if (current.has(currentModelOption.provider)) return current;
                const next = new Set(current);
                next.add(currentModelOption.provider);
                return next;
              });
            }
          }
          setOpen((v) => !v);
        }}
        title={title ?? t("desktop.changeModel")}
        aria-label={t("desktop.changeModel")}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          justifyContent: isMobile ? "flex-start" : undefined,
          padding: isMobile ? "4px 6px" : "3px 7px",
          height: 24,
          width: "auto",
          maxWidth: "100%",
          overflow: "hidden",
          background: open ? "var(--bg-hover)" : "none",
          border: "none",
          borderRadius: 6,
          color: "var(--text-muted)",
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.55 : 1,
          fontSize: 12,
          transition: "background 0.12s, color 0.12s",
        }}
        onMouseEnter={(e) => {
          if (disabled) return;
          e.currentTarget.style.background = "var(--bg-hover)";
          e.currentTarget.style.color = "var(--text)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = open ? "var(--bg-hover)" : "none";
          e.currentTarget.style.color = "var(--text-muted)";
        }}
      >
        <ProviderIcon id={model?.provider ?? "unknown"} api={currentModelOption?.api ?? null} size={14} />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: "0 1 auto" }}>{currentName}</span>
        <CaretDownIcon
          size={11}
          weight="bold"
          aria-hidden="true"
          style={{ flexShrink: 0, transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.12s" }}
        />
      </button>
      {open && rect && (() => {
        const viewportHeight = cssPx(window.visualViewport?.height ?? window.innerHeight);
        const viewportWidth = cssPx(window.innerWidth);
        const bottom = viewportHeight - rect.top + 6;
        const maxH = Math.min(400, Math.max(120, Math.min(rect.top - 8, viewportHeight * 0.6)));
        // On mobile, pin to a small left margin and cap width to the
        // viewport so long model names never push the panel off-screen.
        // On desktop, clamp left so the panel stays within the viewport.
        const panelMinWidth = rect.width;
        const panelMaxWidth = Math.min(400, viewportWidth - 16);
        const panelPos: React.CSSProperties = isMobile
          ? { left: 8, right: 8, maxWidth: "calc(100vw / var(--app-ui-scale, 1) - 16px)" }
          : {
              // Anchor the content-sized panel to the selector's
              // right edge, while preserving an 8px viewport inset.
              right: Math.max(8, viewportWidth - (rect.left + rect.width)),
              width: "max-content",
              minWidth: Math.min(panelMinWidth, panelMaxWidth),
              maxWidth: panelMaxWidth,
            };

        // Model search filter — matches name, model id, and provider.
        const searchQuery = search.trim().toLowerCase();
        const isSearching = searchQuery.length > 0;
        const matchesQuery = (opt: ModelSelectorOption) =>
          opt.name.toLowerCase().includes(searchQuery) ||
          opt.modelId.toLowerCase().includes(searchQuery) ||
          opt.provider.toLowerCase().includes(searchQuery);
        const favModels = isSearching
          ? [...favorites].flatMap((key) => {
              const [provider, modelId] = key.split(":", 2);
              const match = modelOptions.find((o) => o.provider === provider && o.modelId === modelId);
              return match && matchesQuery(match) ? [match] : [];
            })
          : [...favorites].flatMap((key) => {
              const [provider, modelId] = key.split(":", 2);
              const match = modelOptions.find((o) => o.provider === provider && o.modelId === modelId);
              return match ? [match] : [];
            });
        const hasFavs = favModels.length > 0;
        const filteredGroups = isSearching
          ? modelsByProvider
              .map((group) => ({ ...group, options: group.options.filter(matchesQuery) }))
              .filter((group) => group.options.length > 0)
          : modelsByProvider;
        const hasAnyResults = hasFavs || filteredGroups.length > 0;

        return (
          <div ref={panelRef} className="chat-input-model-dropdown chat-input-menu-panel" style={{
            position: "fixed",
            bottom,
            ...panelPos,
            zIndex: 2000, background: "var(--bg-panel)", border: "1px solid var(--border)",
            borderRadius: 8, boxShadow: "0 4px 24px rgba(0,0,0,0.12)",
            overflow: "hidden", maxHeight: maxH,
            display: "flex", flexDirection: "column",
          }}>
            {/* Search area — pinned above the list, separated by a divider */}
            <div style={{ borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
              <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
                <MagnifyingGlassIcon
                  size={13}
                  color="var(--text-dim)"
                  style={{ position: "absolute", left: 12, pointerEvents: "none" }}
                />
                <input
                  ref={searchRef}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      if (search) {
                        setSearch("");
                      } else {
                        setOpen(false);
                      }
                    } else if (e.key === "ArrowDown") {
                      const firstRow = panelRef.current?.querySelector<HTMLButtonElement>(".model-row button");
                      if (firstRow) {
                        e.preventDefault();
                        firstRow.focus();
                      }
                    }
                  }}
                  placeholder={t("desktop.searchModels")}
                  aria-label={t("desktop.searchModels")}
                  style={{
                    width: "100%",
                    padding: "5px 12px 5px 34px",
                    background: "transparent",
                    border: "none",
                    outline: "none",
                    color: "var(--text)",
                    // iOS auto-zooms focused form controls below
                    // 16px. Desktop keeps the compact picker scale.
                    fontSize: isMobile ? 16 : 12,
                    fontFamily: "var(--font-mono)",
                  }}
                />
              </div>
            </div>
            {/* Scrollable results */}
            <div style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
              {/* Favorites group — at top, always expanded */}
              {hasFavs && (
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <div style={{
                    padding: "6px 12px 4px",
                    fontSize: 10, fontWeight: 600, color: "var(--text-dim)",
                    textTransform: "uppercase", letterSpacing: "0.07em",
                  }}>
                    {t("desktop.favorites")}
                  </div>
                  {favModels.map(renderRow)}
                  <div style={{ borderTop: "1px solid var(--border)" }} />
                </div>
              )}
              {/* Provider groups — clickable headers, default collapsed */}
              {filteredGroups.map((group, gi) => {
                const isExpanded = isSearching || expandedProviders.has(group.provider);
                const caret = !isExpanded
                  ? <CaretRightIcon size={10} color="var(--text-dim)" />
                  : <CaretDownIcon size={10} color="var(--text-dim)" />;
                return (
                  <div key={group.provider} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <button
                      type="button"
                      className="chat-input-menu-group-header"
                      onClick={() => toggleProviderExpand(group.provider)}
                      style={{
                        display: "flex", alignItems: "center", gap: 4,
                        width: "100%", padding: "6px 12px 4px",
                        background: "none", border: "none",
                        cursor: "pointer",
                        fontSize: 10, fontWeight: 600, color: "var(--text-dim)",
                        textTransform: "uppercase", letterSpacing: "0.07em",
                        borderTop: gi > 0 ? "1px solid var(--border)" : "none",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }}
                    >
                      {caret}
                      {group.provider}
                    </button>
                    {isExpanded && group.options.map(renderRow)}
                  </div>
                );
              })}
              {/* No matches while searching */}
              {isSearching && !hasAnyResults && (
                <div style={{ padding: "14px 12px", textAlign: "center", fontSize: 12, color: "var(--text-dim)" }}>
                  {t("desktop.noModelsMatch")}
                </div>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
