import { useState } from "react";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { useI18n } from "@/hooks/useI18n";
import { DisclosureCollapse } from "./DisclosureCollapse";
import type { ProcessContentBlock } from "@/lib/process-content";

type ToolBlock = Extract<ProcessContentBlock, { type: "toolCall" }>;
type SharedBatch = NonNullable<ToolBlock["sharedBatch"]>;

/**
 * One codemode child call's own detail view: input + status + error, plus the
 * child's OWN captured output when the adapter archived one (`call.result`).
 * The parent script's shared output is NEVER rendered here — it belongs to the
 * whole group and is rendered once by {@link CodemodeScriptOutput}.
 */
export function NestedToolDetails({ block }: { block: ToolBlock }) {
  const { t } = useI18n();
  const call = block.nested?.call;
  if (!call) return null;
  const own = call.result;
  return (
    <div className={`nested-tool-details codex-tool-details${block.status === "error" ? " is-error" : ""}`}>
      <div className="codex-tool-detail-section">
        <div className="codex-tool-detail-label">{t("desktop.codexProcessInput")}</div>
        {call.arguments === undefined ? (
          <div className="codex-tool-empty">{t("desktop.nestedToolArgumentsMissing")}</div>
        ) : <pre>{JSON.stringify(call.arguments, null, 2)}</pre>}
      </div>
      {block.status === "error" && <div className="codex-tool-detail-section is-error"><pre>{call.error ?? t("desktop.nestedToolCallError")}</pre></div>}
      {own && (
        <div className={`codex-tool-detail-section${own.isError ? " is-error" : ""}`}>
          <div className="codex-tool-detail-label">{t("desktop.codexProcessOutput")}</div>
          {own.isError && <div>{t("desktop.nestedToolCallError")}</div>}
          {own.text && <pre>{own.text}</pre>}
          {own.truncated && <div className="codex-tool-empty">{t("desktop.nestedOutputTruncated")}</div>}
          {own.imageCount > 0 && <div className="codex-tool-empty">{t("desktop.codemodeNestedImages", { count: own.imageCount })}</div>}
        </div>
      )}
    </div>
  );
}

/**
 * The whole codemode script's shared output as one collapsed-by-default row:
 * rendered ONCE per codemode group (never inside a child call's details).
 */
export function CodemodeScriptOutputRow({ batch }: { batch: SharedBatch }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`codex-tool-row codemode-script-output-row${batch.result.isError ? " is-error" : ""}`}>
      <button
        type="button"
        className="codex-tool-row-trigger"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span className="codex-tool-row-label">{t("desktop.codemodeScriptOutput")}</span>
        {batch.result.isError && <span className="codex-tool-duration">{t("desktop.codemodeBatchFailed")}</span>}
        <span className="codemode-tool-badge">{t("desktop.codemodeLabel")}</span>
        <CaretRightIcon className={`codex-tool-caret${expanded ? " is-expanded" : ""}`} size={13} aria-hidden="true" />
      </button>
      <DisclosureCollapse open={expanded} className="codex-tool-row-collapse">
        <CodemodeScriptOutput batch={batch} />
      </DisclosureCollapse>
    </div>
  );
}

/**
 * The whole codemode script's shared output, rendered ONCE per codemode group
 * (never inside a child call's details): the script input, the parent tool
 * result's text/images/structured content, and the batch-failed/incomplete
 * markers.
 */
export function CodemodeScriptOutput({ batch }: { batch: SharedBatch }) {
  const { t } = useI18n();
  const [showFull, setShowFull] = useState(false);
  const output = batch.result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n") ?? "";
  const truncated = output.length > 8000 && !showFull;
  return (
    <div className={`nested-tool-details codex-tool-details codemode-script-output${batch.result.isError ? " is-error" : ""}`}>
      {!batch.complete && <div className="codex-tool-empty">{t("desktop.nestedToolCallsIncomplete")}</div>}
      {batch.result.isError && <div className="codex-tool-detail-section is-error"><div>{t("desktop.codemodeBatchFailed")}</div></div>}
      <div className="codex-tool-detail-section">
        <div className="codex-tool-detail-label">{t("desktop.codemodeBatchInput")}</div>
        <pre>{JSON.stringify(batch.input, null, 2)}</pre>
      </div>
      <div className={`codex-tool-detail-section${batch.result.isError ? " is-error" : ""}`}>
        <div className="codex-tool-detail-label">{t("desktop.codemodeScriptOutput")}</div>
        {output && <pre>{truncated ? output.slice(0, 8000) : output}</pre>}
        {batch.result.structuredContent !== undefined && <pre>{JSON.stringify(batch.result.structuredContent, null, 2)}</pre>}
        {batch.result.content.map((item, index) => item.type === "image" ? (
          <img key={index} alt="" loading="lazy" decoding="async" className="codex-process-image" src={item.source.type === "url" ? item.source.url : `data:${item.source.media_type};base64,${item.source.data}`} />
        ) : null)}
        {truncated && <button type="button" className="codex-tool-show-more" onClick={() => setShowFull(true)}>{t("desktop.loadFullOutput")}</button>}
      </div>
    </div>
  );
}
