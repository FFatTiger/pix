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
import { ToolbarButton } from "@/components/ui/buttons";
import { MenuGroupLabel, MenuItem, Popover, anchorRectOf, useMenuDismiss, type AnchorRect } from "@/components/ui/menu";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { reportPreferenceWrite } from "@/lib/preferences/preference-sync";
import { filterThinkingLevelOptions, type ThinkingLevelOption } from "@/lib/thinking-levels";

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
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<AnchorRect | null>(null);

  const displayLabel = (() => {
    const lvl = thinkingLevel ?? "auto";
    if (lvl === "auto" || !thinkingLevelMap) return lvl;
    return thinkingLevelMap[lvl] ?? lvl;
  })();

  useMenuDismiss(open, () => setOpen(false), (target) => rootRef.current?.contains(target) ?? false);

  return (
    <div ref={rootRef} className="chat-input-toolbar-thinking" style={{ position: "relative" }}>
      <ToolbarButton
        className={`chat-input-control${(thinkingLevel ?? "auto") === "off" ? " ui-trigger--dim" : ""}`}
        disabled={disabled}
        open={open}
        ariaHasPopup="menu"
        ariaLabel={t("desktop.reasoningLevel")}
        title={title ?? t("desktop.changeReasoningLevel", { level: displayLabel })}
        onClick={(e) => {
          setRect(anchorRectOf(e.currentTarget));
          setOpen((v) => !v);
        }}
      >
        <ThinkingLevelIcon level={thinkingLevel ?? "auto"} />
        <span style={{ whiteSpace: "nowrap" }}>{displayLabel}</span>
        <CaretDownIcon size={11} weight="bold" className="ui-caret" aria-hidden="true" />
      </ToolbarButton>
      {open && (
        <Popover rect={rect} offset={4} minWidth={200} maxWidth={240} maxHeightCap={360} className="chat-input-menu-panel">
          <div style={{ padding: 4, display: "flex", flexDirection: "column", gap: 2 }}>
            {filterThinkingLevelOptions(availableThinkingLevels).filter((lvl) => includeAuto || lvl !== "auto").map((lvl) => {
              const isActive = (thinkingLevel ?? "auto") === lvl;
              const mappedVal = (lvl !== "auto" && thinkingLevelMap) ? thinkingLevelMap[lvl] : undefined;
              const levelLabel = (mappedVal != null && mappedVal !== lvl) ? mappedVal : lvl;
              const showOriginal = mappedVal != null && mappedVal !== lvl;
              return (
                <MenuItem
                  key={lvl}
                  selected={isActive}
                  disabled={disabled}
                  icon={<ThinkingLevelIcon level={lvl} size={14} />}
                  onClick={() => { setOpen(false); if (!isActive) onThinkingLevelChange(lvl); }}
                >
                  {levelLabel}
                  {showOriginal && <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: 5 }}>({lvl})</span>}
                </MenuItem>
              );
            })}
          </div>
        </Popover>
      )}
    </div>
  );
}

export interface ModelSelectorProps {
  model: { provider: string; modelId: string } | null;
  modelList: readonly { id: string; name: string; provider: string; api?: string }[];
  onModelChange: (provider: string, modelId: string) => void;
  /**
   * Called every time the picker opens, before the panel renders. Embedders use
   * it to refresh the catalog in place; the currently cached list stays visible
   * until the new data arrives.
   */
  onMenuOpen?: () => void;
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
  onMenuOpen,
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
  const [rect, setRect] = useState<AnchorRect | null>(null);
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

  useMenuDismiss(
    open,
    () => setOpen(false),
    (target) => (rootRef.current?.contains(target) ?? false) || (panelRef.current?.contains(target) ?? false),
  );

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
        <MenuItem
          selected={isActive}
          disabled={disabled}
          showCheck={false}
          padding="4px 8px"
          icon={<ProviderIcon id={opt.provider} api={opt.api ?? null} size={14} />}
          onClick={() => select(opt)}
          trailing={(
            <>
              {isActive && <CheckIcon size={12} weight="bold" color="var(--accent)" style={{ flexShrink: 0 }} />}
              <span
                onClick={(e) => { e.stopPropagation(); toggleFavorite(opt.provider, opt.modelId); }}
                className={`model-star${isFav ? " is-fav" : ""}`}
                title={isFav ? t("desktop.unfavorite") : t("desktop.favorite")}
                aria-label={isFav ? t("desktop.unfavorite") : t("desktop.favorite")}
              >
                <StarIcon size={12} weight={isFav ? "fill" : "regular"} />
              </span>
            </>
          )}
        >
          {opt.name}
        </MenuItem>
      </div>
    );
  };

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
    <div ref={rootRef} className="chat-input-toolbar-model" style={{ position: "relative", flex: "0 1 auto", minWidth: 0, width: "auto", maxWidth: isMobile ? 200 : 220 }}>
      <ToolbarButton
        className="chat-input-control"
        disabled={disabled}
        open={open}
        ariaHasPopup="menu"
        ariaLabel={t("desktop.changeModel")}
        title={title ?? t("desktop.changeModel")}
        onClick={(e) => {
          setRect(anchorRectOf(e.currentTarget));
          if (!open) {
            onMenuOpen?.();
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
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: "0 1 auto" }}>{currentName}</span>
        <CaretDownIcon size={11} weight="bold" className="ui-caret" aria-hidden="true" />
      </ToolbarButton>
      {open && (
        <div ref={panelRef} style={{ display: "contents" }}>
          <Popover
            rect={rect}
            offset={6}
            align="right"
            maxWidth={400}
            maxHeightCap={400}
            mobileFullWidth
            className="chat-input-menu-panel chat-input-model-dropdown"
            style={{ overflowY: "hidden", display: "flex", flexDirection: "column" }}
          >
            <div className="ui-menu-search" style={{ flexShrink: 0 }}>
              <div className="ui-menu-search-inner">
                <MagnifyingGlassIcon size={13} className="ui-menu-search-icon" />
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
                  style={{ fontSize: isMobile ? 16 : undefined }}
                />
              </div>
            </div>
            <div style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
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
              {filteredGroups.map((group) => {
                const isExpanded = isSearching || expandedProviders.has(group.provider);
                const caret = !isExpanded
                  ? <CaretRightIcon size={10} color="var(--text-dim)" />
                  : <CaretDownIcon size={10} color="var(--text-dim)" />;
                return (
                  <div key={group.provider} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <MenuGroupLabel onClick={() => toggleProviderExpand(group.provider)}>
                      {caret}
                      {group.provider}
                    </MenuGroupLabel>
                    {isExpanded && group.options.map(renderRow)}
                  </div>
                );
              })}
              {isSearching && !hasAnyResults && (
                <div style={{ padding: "14px 12px", textAlign: "center", fontSize: 12, color: "var(--text-dim)" }}>
                  {t("desktop.noModelsMatch")}
                </div>
              )}
            </div>
          </Popover>
        </div>
      )}
    </div>
  );
}
