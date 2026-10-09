import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { ProcessContentBlock } from "@/lib/process-content";

type ToolBlock = Extract<ProcessContentBlock, { type: "toolCall" }>;

export function NestedToolDetails({ block }: { block: ToolBlock }) {
  const { t } = useI18n();
  const [showFull, setShowFull] = useState(false);
  const call = block.nested?.call;
  if (!call) return null;
  const batch = block.sharedBatch;
  const output = batch?.result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n") ?? "";
  const truncated = output.length > 8000 && !showFull;
  return (
    <div className={`nested-tool-details codex-tool-details${block.status === "error" ? " is-error" : ""}`}>
      <div className="codex-tool-detail-section">
        <div className="codex-tool-detail-label">{t("desktop.codexProcessInput")}</div>
        {call.arguments === undefined ? (
          <div className="codex-tool-empty">{t("desktop.nestedToolArgumentsMissing")}</div>
        ) : <pre>{JSON.stringify(call.arguments, null, 2)}</pre>}
      </div>
      {block.status === "error" && <div className="codex-tool-detail-section is-error"><pre>{call.error ?? t("desktop.nestedToolCallError")}</pre></div>}
      {batch && <>
        {!batch.complete && <div className="codex-tool-empty">{t("desktop.nestedToolCallsIncomplete")}</div>}
        <div className="codex-tool-detail-section">
          <div className="codex-tool-detail-label">{t("desktop.codemodeBatchInput")}</div>
          <pre>{JSON.stringify(batch.input, null, 2)}</pre>
        </div>
        <div className={`codex-tool-detail-section${batch.result.isError ? " is-error" : ""}`}>
          <div className="codex-tool-detail-label">{t("desktop.codemodeBatchOutput")}</div>
          {batch.result.isError && <div>{t("desktop.codemodeBatchFailed")}</div>}
          {output && <pre>{truncated ? output.slice(0, 8000) : output}</pre>}
          {batch.result.structuredContent !== undefined && <pre>{JSON.stringify(batch.result.structuredContent, null, 2)}</pre>}
          {batch.result.content.map((item, index) => item.type === "image" ? (
            <img key={index} alt="" loading="lazy" decoding="async" className="codex-process-image" src={item.source.type === "url" ? item.source.url : `data:${item.source.media_type};base64,${item.source.data}`} />
          ) : null)}
          {truncated && <button type="button" className="codex-tool-show-more" onClick={() => setShowFull(true)}>{t("desktop.loadFullOutput")}</button>}
        </div>
      </>}
    </div>
  );
}
