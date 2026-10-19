import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useI18n } from "@/hooks/useI18n";
import { setDraft } from "@/lib/draft-store";
import { createMutationOptions } from "@/api/mutations";
import { queryKeys } from "@/api/query-keys";
import { useHttpClient } from "@/app/http-context";
import type { SessionHeader } from "@fffattiger/pix-protocol";
import type { TurnAction } from "@/lib/turn-actions";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { NotePencilIcon } from "@phosphor-icons/react/NotePencil";
import { PaperPlaneTiltIcon } from "@phosphor-icons/react/PaperPlaneTilt";
import { PlusIcon } from "@phosphor-icons/react/Plus";

/**
 * organize_sessions keeps an in-card card because delete is destructive and
 * must be confirmed before it runs (DELETE /v1/sessions/:id). The navigation
 * tools (open_session / draft_to_session / send_to_session / create_session)
 * already executed server-side and are reported by TurnActionChips under the
 * answer, so their tool rows show the plain input/result like any other tool.
 */

export function isOrganizeSessionsTool(toolName: string): boolean {
  return toolName === "organize_sessions";
}

interface ResolvedTarget {
  sessionId: string;
  cwd: string;
  title: string;
}

function cachedSessions(queryClient: ReturnType<typeof useQueryClient>): SessionHeader[] {
  const sessions: SessionHeader[] = [];
  for (const [, page] of queryClient.getQueriesData<{ sessions?: SessionHeader[] }>({ queryKey: queryKeys.sessions.lists })) {
    if (page?.sessions) sessions.push(...page.sessions);
  }
  return sessions;
}

/** Resolve id-or-title selectors against the cached session pages (read-only). */
function useTargetResolver() {
  const queryClient = useQueryClient();
  return useMemo(() => {
    const sessions = cachedSessions(queryClient);
    return (selector: string): ResolvedTarget | null => {
      const trimmed = selector.trim();
      if (trimmed === "") return null;
      const byId = sessions.find((row) => row.sessionId === trimmed);
      if (byId !== undefined) return toTarget(byId);
      const lower = trimmed.toLowerCase();
      const byTitle = sessions.find((row) => (row.title ?? row.firstMessage ?? "").toLowerCase() === lower)
        ?? sessions.find((row) => (row.title ?? row.firstMessage ?? "").toLowerCase().includes(lower));
      return byTitle === undefined ? null : toTarget(byTitle);
    };
  }, [queryClient]);
}

/** Newest cached session whose cwd basename matches the project name. */
function useProjectSession(project: string): ResolvedTarget | null {
  const queryClient = useQueryClient();
  return useMemo(() => {
    const wanted = project.trim().toLowerCase();
    if (wanted === "") return null;
    let best: SessionHeader | null = null;
    for (const row of cachedSessions(queryClient)) {
      const base = row.cwd.replace(/\\/g, "/").split("/").filter(Boolean).pop()?.toLowerCase() ?? "";
      if (base !== wanted) continue;
      if (best === null || (row.updatedAt ?? 0) > (best.updatedAt ?? 0)) best = row;
    }
    return best === null ? null : toTarget(best);
  }, [project, queryClient]);
}

function toTarget(header: SessionHeader): ResolvedTarget {
  const title = (header.title ?? header.firstMessage ?? header.sessionId).replace(/\s+/g, " ").trim().slice(0, 80);
  return { sessionId: header.sessionId, cwd: header.cwd, title };
}

type CardStatus = "idle" | "confirm-delete" | "done" | { error: string };

/** The tool's own resolution (result details), which beats the cached-page guess. */
function resultTarget(details: unknown): ResolvedTarget | null {
  if (typeof details !== "object" || details === null) return null;
  const { sessionId, cwd, title } = details as Record<string, unknown>;
  if (typeof sessionId !== "string" || typeof cwd !== "string") return null;
  return { sessionId, cwd, title: typeof title === "string" && title.trim() !== "" ? title : sessionId };
}

export function OrganizeSessionsCard({ input }: { input: Record<string, unknown> }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const http = useHttpClient();
  const resolve = useTargetResolver();
  const [status, setStatus] = useState<CardStatus>("idle");
  const remove = useMutation(createMutationOptions(http, queryClient).sessions.remove());

  const action = typeof input.action === "string" ? input.action : "";
  const rows = Array.isArray(input.sessions)
    ? input.sessions.filter((row): row is { session: string } =>
      row !== null && typeof row === "object" && typeof (row as { session?: unknown }).session === "string")
    : [];
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const targets = rows
    .map((row) => resolve(row.session))
    .filter((target): target is ResolvedTarget => target !== null);
  // Rename already ran server-side; the card only reports the new title.
  if (action === "rename") {
    return (
      <div className="assistant-action-card" data-testid="assistant-action-card">
        <div className="assistant-action-card-title">{t("desktop.assistantActionRenamed", { title })}</div>
      </div>
    );
  }
  const isDelete = action === "delete";
  const busy = remove.isPending;
  const supported = isDelete;
  const finished = status === "done";
  const runAction = async () => {
    if (targets.length === 0) return;
    setStatus("idle");
    try {
      if (action === "delete") {
        for (const target of targets) await remove.mutateAsync(target.sessionId);
      } else {
        setStatus({ error: t("desktop.assistantActionUnsupported") });
        return;
      }
      setStatus("done");
    } catch {
      setStatus({ error: t("desktop.assistantActionFailed") });
    }
  };
  return (
    <div className="assistant-action-card" data-testid="assistant-action-card">
      <div className="assistant-action-card-title">
        {t("desktop.assistantActionOrganizeTitle", {
          action: t(`desktop.assistantAction_${action === "" ? "unknown" : action}`),
          count: targets.length,
        })}
      </div>
      <ul className="assistant-action-card-list">
        {(targets.length > 0 ? targets : rows.map((row) => ({ sessionId: "", cwd: "", title: row.session }))).slice(0, 20).map((target, index) => (
          <li key={`${target.sessionId}-${index}`}>{target.title}</li>
        ))}
      </ul>
      {targets.length === 0 ? <div className="assistant-action-card-note">{t("desktop.assistantActionNoTargets")}</div> : null}
      {status === "confirm-delete" ? (
        <div className="assistant-action-card-confirm">
          <span>{t("desktop.assistantActionDeleteConfirm", { count: targets.length })}</span>
          <AssistantActionButton label={t("desktop.assistantActionConfirmDelete")} tone="danger" disabled={busy} onClick={() => void runAction()} />
          <AssistantActionButton label={t("desktop.cancel")} disabled={busy} onClick={() => setStatus("idle")} />
        </div>
      ) : (
        <AssistantActionButton
          label={isDelete ? t("desktop.assistantActionExecuteDelete") : t("desktop.assistantActionExecute")}
          done={finished}
          tone={isDelete ? "danger" : "default"}
          disabled={targets.length === 0 || busy || !supported}
          onClick={() => {
            if (isDelete) {
              setStatus("confirm-delete");
              return;
            }
            void runAction();
          }}
        />
      )}
      {typeof status === "object" ? <div className="assistant-action-card-note" role="alert">{status.error}</div> : null}
    </div>
  );
}

const CHIP_ICON = {
  send_to_session: PaperPlaneTiltIcon,
  create_session: PlusIcon,
  open_session: ArrowSquareOutIcon,
  draft_to_session: NotePencilIcon,
} as const;

/** One line per session action under the answer; a click goes to the session. */
export function TurnActionChips({ actions }: { actions: TurnAction[] }) {
  return (
    <div className="turn-action-chips">
      {actions.map((action) => <TurnActionChip key={action.toolCallId} action={action} />)}
    </div>
  );
}

function TurnActionChip({ action }: { action: TurnAction }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const resolve = useTargetResolver();
  const { toolName, input } = action;
  const isCreate = toolName === "create_session";
  const selector = typeof input.session === "string" ? input.session : "";
  const project = typeof input.project === "string" ? input.project : "";
  const projectSession = useProjectSession(isCreate ? project : "");
  const target = resultTarget(action.resultDetails) ?? (isCreate ? projectSession : resolve(selector));
  const name = target?.title ?? (isCreate ? project : selector);
  const draft = toolName === "draft_to_session" && typeof input.text === "string" ? input.text : "";
  const Icon = CHIP_ICON[toolName];
  return (
    <button
      type="button"
      className="turn-action-chip"
      data-testid="turn-action-chip"
      title={name}
      disabled={target === null}
      onClick={() => {
        if (target === null) return;
        // Park it under the target's draft key so its composer hydrates there; never sent.
        if (draft !== "") setDraft(target.sessionId, { value: draft, images: [] });
        void navigate({ to: "/", search: { session: target.sessionId, cwd: target.cwd } });
      }}
    >
      <Icon size={12} />
      <span>{t(`desktop.assistantChip_${toolName}`)}</span>
      <span className="turn-action-chip-name">{name}</span>
      <CaretRightIcon size={10} />
    </button>
  );
}

function AssistantActionButton({
  label,
  onClick,
  disabled,
  done,
  tone = "default",
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  done?: boolean;
  tone?: "default" | "danger";
}) {
  return (
    <button
      type="button"
      className={`assistant-action-button${tone === "danger" ? " is-danger" : ""}`}
      data-testid="assistant-action-button"
      disabled={disabled || done}
      onClick={onClick}
    >
      {done ? "✓" : ""} {label}
    </button>
  );
}
