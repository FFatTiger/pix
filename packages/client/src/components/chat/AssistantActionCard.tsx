import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useI18n } from "@/hooks/useI18n";
import { useSidebarItemState } from "@/lib/sidebar-item-state";
import { setDraft } from "@/lib/draft-store";
import { createMutationOptions } from "@/api/mutations";
import { queryKeys } from "@/api/query-keys";
import { useHttpClient } from "@/app/http-context";
import type { SessionHeader } from "@fffattiger/pix-protocol";

/**
 * Suggested-action card for the assistant's action tools (open_session /
 * organize_sessions / draft_to_session).
 *
 * The tool NEVER performs the action: it resolved targets and returned a
 * confirmation, and this card renders the user-facing buttons from the
 * toolCall INPUT (the model's parameters — exactly what the tool validated).
 * Nothing executes until the user clicks; delete takes a second in-card
 * confirmation. Execution reuses the client's existing flows: normal session
 * navigation, the rename/remove mutations (PATCH/DELETE /v1/sessions/:id) and
 * the local sidebar pin/archive preferences; drafts are parked in the draft
 * store so the TARGET session's composer hydrates on mount — never sent.
 */

type ActionToolName = "open_session" | "organize_sessions" | "draft_to_session";

export function isAssistantActionTool(toolName: string): toolName is ActionToolName {
  return toolName === "open_session" || toolName === "organize_sessions" || toolName === "draft_to_session";
}

interface ResolvedTarget {
  sessionId: string;
  cwd: string;
  title: string;
}

/** Resolve id-or-title selectors against the cached session pages (read-only). */
function useTargetResolver() {
  const queryClient = useQueryClient();
  return useMemo(() => {
    const sessions: SessionHeader[] = [];
    for (const [, page] of queryClient.getQueriesData<{ sessions?: SessionHeader[] }>({ queryKey: queryKeys.sessions.lists })) {
      if (page?.sessions) sessions.push(...page.sessions);
    }
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

function toTarget(header: SessionHeader): ResolvedTarget {
  const title = (header.title ?? header.firstMessage ?? header.sessionId).replace(/\s+/g, " ").trim().slice(0, 80);
  return { sessionId: header.sessionId, cwd: header.cwd, title };
}

type CardStatus = "idle" | "confirm-delete" | "done" | { error: string };

export function AssistantActionCard({ toolName, input }: { toolName: ActionToolName; input: Record<string, unknown> }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const http = useHttpClient();
  const queryClient = useQueryClient();
  const resolve = useTargetResolver();
  const { pinSession, archiveSession } = useSidebarItemState();
  const [status, setStatus] = useState<CardStatus>("idle");
  const rename = useMutation(createMutationOptions(http, queryClient).sessions.rename());
  const remove = useMutation(createMutationOptions(http, queryClient).sessions.remove());

  if (toolName === "open_session") {
    const selector = typeof input.session === "string" ? input.session : "";
    const target = resolve(selector);
    return (
      <div className="assistant-action-card" data-testid="assistant-action-card">
        <div className="assistant-action-card-title">
          {target ? target.title : t("desktop.assistantActionTargetMissing", { session: selector })}
        </div>
        <AssistantActionButton
          label={t("desktop.assistantActionOpen")}
          done={status === "done"}
          disabled={target === null}
          onClick={() => {
            if (target === null) return;
            void navigate({ to: "/", search: { session: target.sessionId, cwd: target.cwd } });
            setStatus("done");
          }}
        />
      </div>
    );
  }

  if (toolName === "draft_to_session") {
    const selector = typeof input.session === "string" ? input.session : "";
    const text = typeof input.text === "string" ? input.text : "";
    const target = resolve(selector);
    return (
      <div className="assistant-action-card" data-testid="assistant-action-card">
        <div className="assistant-action-card-title">
          {target ? t("desktop.assistantActionDraftTitle", { session: target.title }) : t("desktop.assistantActionTargetMissing", { session: selector })}
        </div>
        {text !== "" ? <div className="assistant-action-card-note">{text.slice(0, 400)}{text.length > 400 ? "…" : ""}</div> : null}
        <AssistantActionButton
          label={t("desktop.assistantActionFillDraft")}
          done={status === "done"}
          disabled={target === null || text === ""}
          onClick={() => {
            if (target === null || text === "") return;
            // Park the draft under the TARGET session's draft key: its composer
            // hydrates on mount after navigation. Nothing is ever sent.
            setDraft(target.sessionId, { value: text, images: [] });
            void navigate({ to: "/", search: { session: target.sessionId, cwd: target.cwd } });
            setStatus("done");
          }}
        />
      </div>
    );
  }

  // organize_sessions
  const action = typeof input.action === "string" ? input.action : "";
  const rows = Array.isArray(input.sessions)
    ? input.sessions.filter((row): row is { session: string } =>
      row !== null && typeof row === "object" && typeof (row as { session?: unknown }).session === "string")
    : [];
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const targets = rows
    .map((row) => resolve(row.session))
    .filter((target): target is ResolvedTarget => target !== null);
  const isDelete = action === "delete";
  const busy = rename.isPending || remove.isPending;
  const finished = status === "done";
  const runAction = async () => {
    if (targets.length === 0) return;
    setStatus("idle");
    try {
      if (action === "rename" && title !== "") {
        await rename.mutateAsync({ id: targets[0]!.sessionId, name: title });
      } else if (action === "delete") {
        for (const target of targets) await remove.mutateAsync(target.sessionId);
      } else if (action === "pin" || action === "unpin") {
        for (const target of targets) pinSession(target.sessionId, action === "pin");
      } else if (action === "archive" || action === "unarchive") {
        for (const target of targets) archiveSession(target.sessionId, action === "archive");
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
          disabled={targets.length === 0 || busy || action === "" || (action === "rename" && title === "")}
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
      {status === "done" && targets.length > 0 && action === "pin" ? (
        <div className="assistant-action-card-note">{t("desktop.assistantActionLocalOnlyHint")}</div>
      ) : null}
    </div>
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
