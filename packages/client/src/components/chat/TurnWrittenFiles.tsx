
import { useI18n } from "@/hooks/useI18n";
import { urls } from "@/api/urls";
import { getFileName } from "@/lib/file-paths";
import type { TurnFileRow } from "@/lib/turn-written-files";
import { getFileIcon } from "./FileIcons";

/**
 * Files a turn wrote or handed to the user (`show_files`).
 * Written files: chips that open in diff view. Shown files: a strip of
 * same-size tiles (image thumbnail, or file icon + name) that scrolls
 * sideways and opens a preview.
 */
export function TurnWrittenFiles({ files, onOpenFile, sessionId }: {
  files: TurnFileRow[];
  onOpenFile?: ((filePath: string, options?: { initialDisplayMode?: "diff"; source?: "turn-files" }) => void) | undefined;
  sessionId?: string | undefined;
}) {
  const { t } = useI18n();
  if (files.length === 0) return null;
  const written = files.filter((file) => file.source === "written");
  const shown = files.filter((file) => file.source === "shown");
  const open = (filePath: string) => onOpenFile?.(filePath, { source: "turn-files" });

  return (
    <>
    {written.length > 0 ? (
    <div
      aria-label={t("desktop.filesWritten")}
      style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: "calc(var(--spacing) * 3)" }}
    >
      {written.map((file) => {
        const name = getFileName(file.filePath);
        return (
          <button
            key={file.filePath}
            type="button"
            className="turn-written-file-chip"
            title={file.filePath}
            aria-label={t("desktop.openWrittenFile", { name })}
            onClick={() => onOpenFile?.(file.filePath, { source: "turn-files", initialDisplayMode: "diff" })}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "2px 8px",
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              color: "var(--text-muted)",
              background: "var(--bg-subtle)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              cursor: "pointer",
              transition: "background 0.12s, color 0.12s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "color-mix(in srgb, var(--text-dim) 6%, var(--bg-subtle))";
              e.currentTarget.style.color = "var(--text)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "var(--bg-subtle)";
              e.currentTarget.style.color = "var(--text-muted)";
            }}
          >
            {getFileIcon(name, 12)}
            <span>{name}</span>
            {file.source === "written" && file.additions !== undefined && file.additions > 0 && (
              <span style={{ color: "var(--accent-green)", fontWeight: 500 }}>+{file.additions}</span>
            )}
            {file.source === "written" && file.deletions !== undefined && file.deletions > 0 && (
              <span style={{ color: "var(--accent-red)", fontWeight: 500 }}>-{file.deletions}</span>
            )}
          </button>
        );
      })}
    </div>
    ) : null}
    {shown.length > 0 ? (
      <div className="turn-shown-files" aria-label={t("desktop.filesShown")}>
        {shown.map((file) => {
          const name = getFileName(file.filePath);
          const image = file.source === "shown" && file.kind === "image";
          return (
            <button
              key={file.filePath}
              type="button"
              className="turn-shown-file"
              title={file.filePath}
              aria-label={t("desktop.openWrittenFile", { name })}
              onClick={() => open(file.filePath)}
            >
              {image ? (
                <img src={urls.files.file(file.filePath, "read", { sessionId })} alt="" />
              ) : (
                <>
                  {getFileIcon(name, 24)}
                  <span className="turn-shown-file-name">{name}</span>
                </>
              )}
            </button>
          );
        })}
      </div>
    ) : null}
    </>
  );
}
