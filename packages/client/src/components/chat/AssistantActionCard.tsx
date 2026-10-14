import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useI18n } from "@/hooks/useI18n";
import { setDraft } from "@/lib/draft-store";
import { createMutationOptions } from "@/api/mutations";
import { queryKeys } from "@/api/query-keys";
import { useHttpClient } from "@/app/http-context";
import type { SessionHeader } from "@fffattiger/pix-protocol";

/**
 * Action card for the assistant's action tools (open_session /
 * organize_sessions / draft_to_session / send_to_session / create_session).
 *
 * open / draft still wait for a click. organize delete still takes a second
 * in-card confirmation. organize rename and send/create already executed
 * server-side — the card only reports what happened and offers navigation.
 * Execution reuses the client's existing flows: normal session navigation and
 * the remove mutation (DELETE /v1/sessions/:id); drafts are parked in the
 * draft store so the TARGET session's composer hydrates on mount — never sent.
 */

type ActionToolName = "open_session" | "organize_sessions" | "draft_to_session" | "send_to_session" | "create_session";

export function isAssistantActionTool(toolName: string): toolName is ActionToolName {
  return toolName === "open_session"
    || toolName === "organize_sessions"
    || toolName === "draft_to_session"
    || toolName === "send_to_session"
    || toolName === "create_session";
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

function concise(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
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
  const [status, setStatus] = useState<CardStatus>("idle");
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

  if (toolName === "send_to_session") {
    const selector = typeof input.session === "string" ? input.session : "";
    const message = typeof input.message === "string" ? input.message : "";
    const delivery = input.delivery === "steer" || input.delivery === "follow_up" ? input.delivery : "new";
    const target = resolve(selector);
    return (
      <div className="assistant-action-card" data-testid="assistant-action-card">
        <div className="assistant-action-card-title">{t("desktop.assistantActionSentTitle")}</div>
        <div className="assistant-action-card-note">
          {t("desktop.assistantActionSentTarget", { session: target ? target.title : selector })}
        </div>
        <div className="assistant-action-card-note">{t(`desktop.assistantActionDelivery_${delivery}`)}</div>
        {message !== "" ? <div className="assistant-action-card-note">{concise(message, 120)}</div> : null}
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

  if (toolName === "create_session") {
    return <CreateSessionCard input={input} />;
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

function CreateSessionCard({ input }: { input: Record<string, unknown> }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [opened, setOpened] = useState(false);
  const project = typeof input.project === "string" ? input.project : "";
  const message = typeof input.message === "string" ? input.message : "";
  const target = useProjectSession(project);
  return (
    <div className="assistant-action-card" data-testid="assistant-action-card">
      <div className="assistant-action-card-title">{t("desktop.assistantActionCreatedTitle")}</div>
      <div className="assistant-action-card-note">{t("desktop.assistantActionCreatedProject", { project })}</div>
      {message !== "" ? <div className="assistant-action-card-note">{concise(message, 120)}</div> : null}
      {target === null ? (
        <div className="assistant-action-card-note">{t("desktop.assistantActionCreatedUnresolved")}</div>
      ) : (
        <AssistantActionButton
          label={t("desktop.assistantActionOpen")}
          done={opened}
          onClick={() => {
            void navigate({ to: "/", search: { session: target.sessionId, cwd: target.cwd } });
            setOpened(true);
          }}
        />
      )}
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
