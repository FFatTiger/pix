
import { useI18n } from "@/hooks/useI18n";
import { urls } from "@/api/urls";
import { getFileName } from "@/lib/file-paths";
import type { TurnFileRow } from "@/lib/turn-written-files";
import { getFileIcon } from "./FileIcons";

/**
 * Files a turn wrote or handed to the user (`show_files`), one chip row.
 * Written files open in diff view; shown files open as a preview. Image chips
 * carry a small thumbnail fetched through the existing files read URL.
 */
export function TurnWrittenFiles({ files, onOpenFile, sessionId }: {
  files: TurnFileRow[];
  onOpenFile?: ((filePath: string, options?: { initialDisplayMode?: "diff"; source?: "turn-files" }) => void) | undefined;
  sessionId?: string | undefined;
}) {
  const { t } = useI18n();
  if (files.length === 0) return null;

  return (
    <div
      aria-label={t("desktop.filesWritten")}
      style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: "calc(var(--spacing) * 3)" }}
    >
      {files.map((file) => {
        const name = getFileName(file.filePath);
        const shown = file.source === "shown";
        return (
          <button
            key={file.filePath}
            type="button"
            className="turn-written-file-chip"
            title={file.filePath}
            aria-label={t("desktop.openWrittenFile", { name })}
            onClick={() => onOpenFile?.(file.filePath, { source: "turn-files", ...(shown ? {} : { initialDisplayMode: "diff" as const }) })}
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
            {shown && file.kind === "image" ? (
              <img
                src={urls.files.file(file.filePath, "read", { sessionId })}
                alt=""
                style={{ height: 64, width: "auto", maxWidth: 96, objectFit: "cover", borderRadius: 6 }}
              />
            ) : getFileIcon(name, 12)}
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
  );
}
