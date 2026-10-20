import { useCallback, useSyncExternalStore } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { useI18n } from "@/hooks/useI18n";
import { queryKeys } from "@/api/query-keys";
import { sessionRowTitle } from "@/lib/session-row";
import type { SessionHeader } from "@fffattiger/pix-protocol";

/**
 * Completion notice the assistant session receives when delegated work
 * finishes. The persisted text is machine-formatted; this card only presents
 * it. Unparseable text is shown raw — never dropped.
 */

export interface NoticeBlock {
  title: string;
  project: string;
  sessionId: string | null;
  result: string;
  details: string[];
}

const RESULT_TONE: Record<string, string> = {
  "完成": "is-positive",
  "出错": "is-error",
  "已停止": "is-warn",
  "停下等用户": "is-accent",
};

/**
 * Split a notification body (marker line already removed) into blocks.
 * Returns null when nothing parses, so the caller can show the raw text.
 */
export function parseAssistantNotice(body: string): NoticeBlock[] | null {
  const chunks = body.split(/\n{2,}/).map((chunk) => chunk.trim()).filter(Boolean);
  const blocks: NoticeBlock[] = [];
  for (const chunk of chunks) {
    const lines = chunk.split("\n");
    const head = lines[0] ?? "";
    const idMatch = head.startsWith("会话:") ? head.match(/｜id:\s*(\S+)\s*$/) : null;
    if (idMatch === null) return null;
    const titleMatch = head.match(/^会话:\s*(.*?)\s*｜项目:/);
    const projectMatch = head.match(/｜项目:\s*(.*?)\s*｜id:/);
    const resultLine = lines.find((line) => line.startsWith("结果:"));
    blocks.push({
      title: titleMatch?.[1]?.trim() || idMatch[1]!,
      project: projectMatch?.[1]?.trim() ?? "",
      sessionId: idMatch[1]!,
      result: resultLine?.slice("结果:".length).trim() ?? "",
      details: lines.slice(1).filter((line) => !line.startsWith("结果:") && line.trim() !== ""),
    });
  }
  return blocks.length === 0 ? null : blocks;
}

export function AssistantNoticeCard({ body }: { body: string }) {
  const { t } = useI18n();
  const blocks = parseAssistantNotice(body);
  return (
    <div className="assistant-action-card assistant-notice-card" data-testid="assistant-notice-card">
      <div className="assistant-action-card-title">{t("desktop.assistantNoticeTitle")}</div>
      {blocks === null ? (
        <div className="assistant-action-card-note">{body.trim()}</div>
      ) : blocks.map((block, index) => (
        <NoticeBlockView key={`${block.sessionId}-${index}`} block={block} />
      ))}
    </div>
  );
}

/** The cached session row for an id, across every cached session page. */
function cachedSession(queryClient: ReturnType<typeof useQueryClient>, sessionId: string): SessionHeader | undefined {
  for (const [, page] of queryClient.getQueriesData<{ sessions?: SessionHeader[] }>({ queryKey: queryKeys.sessions.lists })) {
    const row = page?.sessions?.find((session) => session.sessionId === sessionId);
    if (row !== undefined) return row;
  }
  return undefined;
}

/**
 * The cached row, kept live. A notice renders right after the delegated work
 * settles, which can be before the session list has loaded or before the
 * session got a name; reading through the query cache subscription means the
 * card picks the name up without a second fetch.
 */
function useCachedSession(sessionId: string | null): SessionHeader | undefined {
  const queryClient = useQueryClient();
  const read = useCallback(
    () => (sessionId === null ? undefined : cachedSession(queryClient, sessionId)),
    [queryClient, sessionId],
  );
  const subscribe = useCallback(
    (onChange: () => void) => queryClient.getQueryCache().subscribe(() => onChange()),
    [queryClient],
  );
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * The name to show. A notification written before the session had a name
 * carries an empty title or its own id; both mean "untitled", so the cached
 * row names it with the same rule the sidebar uses (title → first message),
 * and only a session the cache does not know falls back to the id.
 */
function noticeTitle(block: NoticeBlock, row: SessionHeader | undefined): string {
  const parsed = block.title.trim();
  if (parsed !== "" && parsed !== block.sessionId) return parsed;
  if (row !== undefined) return sessionRowTitle(row);
  return block.sessionId ?? parsed;
}

function NoticeBlockView({ block }: { block: NoticeBlock }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const tone = RESULT_TONE[block.result] ?? "";
  const row = useCachedSession(block.sessionId);
  const title = noticeTitle(block, row);
  const open = () => {
    if (block.sessionId === null) return;
    void navigate({ to: "/", search: { session: block.sessionId, cwd: row?.cwd ?? "" } });
  };
  return (
    <div className="assistant-notice-block" data-testid="assistant-notice-block">
      <div className="assistant-notice-head">
        {block.sessionId !== null ? (
          <button
            type="button"
            className="assistant-notice-open"
            data-testid="assistant-notice-open"
            onClick={open}
            title={t("desktop.assistantActionOpen")}
          >
            <span className="assistant-notice-title">{title}</span>
            <CaretRightIcon size={10} />
          </button>
        ) : (
          <span className="assistant-notice-title">{title}</span>
        )}
        {block.result !== "" ? (
          <span className={`assistant-notice-badge${tone ? ` ${tone}` : ""}`} data-testid="assistant-notice-badge">{block.result}</span>
        ) : null}
      </div>
      {block.project !== "" ? <div className="assistant-action-card-note">{block.project}</div> : null}
      {block.details.map((line) => (
        <div key={line} className="assistant-action-card-note">{line}</div>
      ))}
    </div>
  );
}
