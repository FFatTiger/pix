import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CaretDown, Check, GitBranch, Plus } from "@phosphor-icons/react";
import { createQueryOptions, queryKeys } from "@/api/query-keys";
import { createResourcesApi } from "@/api/resources";
import { HttpError } from "@/api/http-client";
import { useHttpClient } from "@/app/http-context";
import { useI18n } from "@/hooks/useI18n";
import { validateBranchName } from "../worktree-branch";

/**
 * Worktree selector — the source sidebar's worktree switcher (button +
 * AnimatedDropdown + worktree rows + new-worktree form) with pix safety
 * semantics injected through props:
 *
 *  - The list is read-only (`worktree` capability): rows highlight the current
 *    worktree; switching only happens when the outer shell passes
 *    `onSelectWorktree` (client URL cwd navigation — never a Git checkout).
 *  - The create form only renders with `canWorktreeWrite` (honestly
 *    negotiated `worktree.write`); branch input is validated with the same
 *    pure validator as the pix WorktreePanel (mirrors Host safeBranch).
 *  - Errors are fixed copy — host messages never reach the DOM.
 *  - Worktrees outside the allowed roots are not offered for switching.
 */

/** How often the worktree list is re-polled (source value, verbatim). */
const WORKTREE_POLL_MS = 5000;

/** How long the dropdown close animation runs (source value, verbatim). */
const DROPDOWN_ANIMATION_MS = 140;

interface WorktreeRow {
  path: string;
  branch: string | null;
  isMain: boolean;
  authorized: boolean;
}

/**
 * Path label that ellipsizes on the LEFT, keeping the (most relevant) trailing
 * segments visible: "…orkspace/my-project". Shows as much of the path as fits
 * instead of a fixed number of segments. The rtl container moves the ellipsis
 * to the left edge; the inner plaintext bidi isolation keeps the path itself
 * rendered strictly left-to-right (no punctuation reordering).
 */
function PathLabel({ text, style }: { text: string; style?: CSSProperties }) {
  return (
    <span
      style={{
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        display: "block",
        minWidth: 0,
        lineHeight: 1.35,
        direction: "rtl",
        textAlign: "left",
        ...style,
      }}
    >
      <span style={{ unicodeBidi: "plaintext" }}>{text}</span>
    </span>
  );
}

function AnimatedDropdown({ open, children, style }: { open: boolean; children: ReactNode; style: CSSProperties }) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);

  useEffect(() => {
    let frame: number | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    if (open) {
      setMounted(true);
      setVisible(false);
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => setVisible(true));
      });
    } else {
      setVisible(false);
      timeout = setTimeout(() => setMounted(false), DROPDOWN_ANIMATION_MS);
    }

    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      if (timeout) clearTimeout(timeout);
    };
  }, [open]);

  if (!mounted) return null;

  return (
    <div
      style={{
        ...style,
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0) scale(1)" : "translateY(-8px) scale(0.96)",
        transformOrigin: "top center",
        transition: `opacity ${DROPDOWN_ANIMATION_MS}ms ease, transform ${DROPDOWN_ANIMATION_MS}ms ease`,
        pointerEvents: open ? "auto" : "none",
      }}
    >
      {children}
    </div>
  );
}

function pathBaseName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Fixed create error copy. Never echoes the branch input or host text. */
function describeCreateError(error: unknown): string {
  if (error instanceof HttpError) {
    switch (error.code) {
      case "INVALID_BRANCH":
      case "CWD_REQUIRED":
      case "INVALID_PATH":
      case "INVALID_INPUT":
        return "Invalid branch or project path.";
      case "WORKTREE_EXISTS":
        return "A worktree or branch with this name already exists.";
      case "PATH_NOT_FOUND":
        return "Project path was not found.";
      case "PATH_FORBIDDEN":
      case "ROOT_REPLACED":
        return "Project path is outside the allowed roots.";
      case "WORKER_ACTIVE":
        return "The runtime is busy — try again later.";
      default:
        break;
    }
    if (error.kind === "network") return "Network error — unable to create the worktree.";
    if (error.kind === "timeout") return "Request timed out — unable to create the worktree.";
  }
  return "Unable to create the worktree.";
}

export interface WorktreeSelectorProps {
  /** Effective cwd (a worktree path or the repo root). */
  cwd: string | undefined;
  /** Honest `worktree` capability gate — no request when false. */
  canWorktree: boolean;
  /** Honest `worktree.write` gate — hides the create form when falsy. */
  canWorktreeWrite?: boolean | undefined;
  /** Switch worktree (client URL cwd navigation only, owned by the shell). */
  onSelectWorktree?: ((path: string) => void) | undefined;
  /** Compact mode height/width tweaks stay with the caller via `style`. */
  style?: CSSProperties | undefined;
}

export function WorktreeSelector({ cwd, canWorktree, canWorktreeWrite = false, onSelectWorktree, style }: WorktreeSelectorProps) {
  const { t } = useI18n();
  const http = useHttpClient();
  const queryClient = useQueryClient();
  const resources = createResourcesApi(http);
  const options = createQueryOptions(http);

  const [isWorktreeDropdownOpen, setWtDropdownOpen] = useState(false);
  const [wtNewOpen, setWtNewOpen] = useState(false);
  const [wtNewBranch, setWtNewBranch] = useState("");
  const [wtError, setWtError] = useState<string | null>(null);
  const wtDropdownRef = useRef<HTMLDivElement | null>(null);
  const wtNewInputRef = useRef<HTMLInputElement | null>(null);

  const list = useQuery({
    ...options.worktrees.list(cwd ?? ""),
    enabled: canWorktree && Boolean(cwd),
    refetchInterval: WORKTREE_POLL_MS,
  });

  const data = list.data;
  const worktrees: WorktreeRow[] = data?.worktrees ?? [];
  const showWorktreeSwitcher = Boolean(data?.isGit && data.isTopLevel);
  const currentWt =
    worktrees.find((w) => w.path === cwd)
    ?? worktrees.find((w) => w.isMain)
    ?? null;
  const compactWorktreeLabel = currentWt
    ? (currentWt.branch ?? pathBaseName(currentWt.path))
    : null;

  const createWorktree = useMutation({
    mutationFn: (branch: string) => {
      if (!data) throw new Error("Worktree list not loaded");
      return resources.worktrees.create({ cwd: data.projectRoot, branch });
    },
    onSuccess: (created) => {
      setWtNewOpen(false);
      setWtNewBranch("");
      setWtDropdownOpen(false);
      setWtError(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees.all });
      onSelectWorktree?.(created.path);
    },
    onError: (error) => {
      setWtError(describeCreateError(error));
    },
  });

  const handleCreateWorktree = useCallback(() => {
    const branch = wtNewBranch.trim();
    if (!branch || createWorktree.isPending) return;
    const invalid = validateBranchName(branch);
    if (invalid) {
      setWtError(invalid);
      return;
    }
    createWorktree.mutate(branch);
  }, [createWorktree, wtNewBranch]);

  // Close the dropdown on outside click (source rule, scoped to this control).
  useEffect(() => {
    if (!isWorktreeDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (wtDropdownRef.current?.contains(e.target as Node)) return;
      setWtDropdownOpen(false);
      setWtNewOpen(false);
      setWtNewBranch("");
      setWtError(null);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isWorktreeDropdownOpen]);

  if (!canWorktree || !cwd || !showWorktreeSwitcher) return null;

  return (
    <div ref={wtDropdownRef} style={{ position: "relative", minWidth: 0, ...style }}>
      <button
        onClick={() => setWtDropdownOpen((open) => !open)}
        aria-label={t("desktop.switchWorktree")}
        aria-expanded={isWorktreeDropdownOpen}
        title={currentWt ? t("desktop.switchWorktreeWithPath", { path: currentWt.path }) : t("desktop.switchWorktree")}
        style={{
          height: 36,
          maxWidth: 220,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "0 8px",
          background: isWorktreeDropdownOpen ? "var(--bg-selected)" : "none",
          border: "none",
          borderRadius: 0,
          color: isWorktreeDropdownOpen ? "var(--text)" : "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          fontWeight: 500,
          fontFamily: "var(--font-mono)",
          lineHeight: 1,
          letterSpacing: 0,
          opacity: 1,
          transition: "background 0.12s, color 0.12s",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--bg-hover)";
          e.currentTarget.style.color = "var(--text)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = isWorktreeDropdownOpen ? "var(--bg-selected)" : "none";
          e.currentTarget.style.color = isWorktreeDropdownOpen ? "var(--text)" : "var(--text-muted)";
        }}
      >
        <GitBranch size={16} weight="regular" style={{ flexShrink: 0 }} aria-hidden="true" />
        <PathLabel text={compactWorktreeLabel ?? ""} style={{ flex: 1, minWidth: 0, color: "inherit", direction: "ltr", fontFamily: "inherit" }} />
        <CaretDown size={12} weight="regular" style={{ flexShrink: 0, transition: "transform 0.12s", transform: isWorktreeDropdownOpen ? "rotate(180deg)" : "none" }} aria-hidden="true" />
      </button>
      <AnimatedDropdown open={isWorktreeDropdownOpen} style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, width: 320, zIndex: 1000, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "0 6px 20px rgba(0,0,0,0.16)", overflow: "hidden", display: "flex", flexDirection: "column", maxHeight: "min(calc(38vh / var(--app-ui-scale, 1)), 300px)" }}>
        <div style={{ maxHeight: "min(calc(32vh / var(--app-ui-scale, 1)), 240px)", overflowY: "auto", flex: 1, minHeight: 0, padding: "4px" }}>
          {worktrees.filter((wt) => wt.authorized).map((wt) => {
            const isCurrent = wt.path === cwd || (wt.isMain && !worktrees.some((w) => w.path === cwd));
            return (
              <button key={wt.path} onClick={() => { if (onSelectWorktree) onSelectWorktree(wt.path); setWtDropdownOpen(false); setWtError(null); }} title={wt.path} style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", padding: "3px 8px", background: isCurrent ? "var(--bg-selected)" : "transparent", border: "none", borderRadius: 5, color: isCurrent ? "var(--accent)" : "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 12, fontFamily: "var(--font-mono)", minWidth: 0 }} onMouseEnter={(e) => { if (!isCurrent) e.currentTarget.style.background = "var(--bg-hover)"; }} onMouseLeave={(e) => { if (!isCurrent) e.currentTarget.style.background = "transparent"; }}>
                {isCurrent ? <Check size={12} color="var(--accent)" weight="bold" style={{ flexShrink: 0 }} aria-hidden="true" /> : <span style={{ width: 12, flexShrink: 0 }} />}
                <PathLabel text={wt.branch ?? pathBaseName(wt.path)} style={{ flex: 1 }} />
                {wt.isMain && <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>{t("desktop.main")}</span>}
              </button>
            );
          })}
        </div>
        {canWorktreeWrite && (
          <div style={{ borderTop: "1px solid var(--border)", padding: "4px", flexShrink: 0 }}>
            {!wtNewOpen ? (
              <button onClick={(e) => { e.stopPropagation(); setWtNewOpen(true); setWtError(null); setTimeout(() => wtNewInputRef.current?.focus(), 0); }} title={t("desktop.createWorktree")} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 8px", background: "transparent", border: "none", borderRadius: 5, color: "var(--text-muted)", cursor: "pointer", textAlign: "left", fontSize: 12 }} onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }} onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}>
                <Plus size={14} weight="regular" style={{ flexShrink: 0 }} aria-hidden="true" />
                <span>{t("desktop.newWorktree")}</span>
              </button>
            ) : (
              <div style={{ padding: "6px 4px 4px" }}>
                <input
                  ref={wtNewInputRef}
                  value={wtNewBranch}
                  onChange={(e) => { setWtNewBranch(e.target.value); setWtError(null); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); handleCreateWorktree(); }
                    if (e.key === "Escape") { setWtNewOpen(false); setWtNewBranch(""); setWtError(null); }
                  }}
                  placeholder={t("desktop.branchName")}
                  style={{ width: "100%", fontSize: 11, fontFamily: "var(--font-mono)", padding: "5px 8px", border: "1px solid var(--accent)", borderRadius: 5, outline: "none", background: "var(--bg)", color: "var(--text)", boxSizing: "border-box" }}
                />
                <div style={{ display: "flex", gap: 5, marginTop: 5 }}>
                  <button onClick={handleCreateWorktree} disabled={createWorktree.isPending || !wtNewBranch.trim()} style={{ flex: 1, padding: "4px 0", background: "var(--accent)", border: "none", borderRadius: 5, color: "#fff", fontSize: 11, fontWeight: 600, cursor: createWorktree.isPending || !wtNewBranch.trim() ? "not-allowed" : "pointer", opacity: createWorktree.isPending || !wtNewBranch.trim() ? 0.65 : 1 }}>{createWorktree.isPending ? t("desktop.creating") : t("desktop.create")}</button>
                  <button onClick={() => { setWtNewOpen(false); setWtNewBranch(""); setWtError(null); }} style={{ flex: 1, padding: "4px 0", background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", fontSize: 11, cursor: "pointer" }}>{t("desktop.cancel")}</button>
                </div>
                {wtError && <div style={{ marginTop: 5, color: "#dc2626", fontSize: 11, lineHeight: 1.35, overflowWrap: "anywhere" }}>{wtError}</div>}
              </div>
            )}
          </div>
        )}
      </AnimatedDropdown>
    </div>
  );
}
