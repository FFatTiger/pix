import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useI18n } from "@/hooks/useI18n";
import { queryKeys } from "@/api/query-keys";
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

function NoticeBlockView({ block }: { block: NoticeBlock }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [opened, setOpened] = useState(false);
  const tone = RESULT_TONE[block.result] ?? "";
  const open = () => {
    if (block.sessionId === null) return;
    let cwd = "";
    for (const [, page] of queryClient.getQueriesData<{ sessions?: SessionHeader[] }>({ queryKey: queryKeys.sessions.lists })) {
      const row = page?.sessions?.find((session) => session.sessionId === block.sessionId);
      if (row !== undefined) {
        cwd = row.cwd;
        break;
      }
    }
    void navigate({ to: "/", search: { session: block.sessionId, cwd } });
    setOpened(true);
  };
  return (
    <div className="assistant-notice-block" data-testid="assistant-notice-block">
      <div className="assistant-notice-head">
        <span className="assistant-notice-title">{block.title}</span>
        {block.result !== "" ? (
          <span className={`assistant-notice-badge${tone ? ` ${tone}` : ""}`} data-testid="assistant-notice-badge">{block.result}</span>
        ) : null}
      </div>
      {block.project !== "" ? <div className="assistant-action-card-note">{block.project}</div> : null}
      {block.details.map((line) => (
        <div key={line} className="assistant-action-card-note">{line}</div>
      ))}
      {block.sessionId !== null ? (
        <button
          type="button"
          className="assistant-action-button"
          data-testid="assistant-action-button"
          disabled={opened}
          onClick={open}
        >
          {opened ? "✓ " : ""}{t("desktop.assistantActionOpen")}
        </button>
      ) : null}
    </div>
  );
}
