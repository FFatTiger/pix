import { useI18n } from "@/hooks/useI18n";
import { urls } from "@/api/urls";
import { getFileDirectory, getFileName, getRelativeFilePath } from "@/lib/file-paths";
import type { TurnFileRow } from "@/lib/turn-written-files";
import { getFileIcon } from "./FileIcons";

/**
 * Parent directory shown on a shown-file row, relative to the session cwd.
 * The cwd itself is "./"; a path outside it keeps a ~-shortened absolute parent.
 */
export function shownFileParentLabel(filePath: string, cwd?: string): string {
  const parent = getFileDirectory(filePath);
  if (!parent || parent === "/") return "";
  if (!cwd) return shortenHome(parent);
  const root = cwd.replace(/\/$/, "");
  if (parent === root) return "./";
  const relative = getRelativeFilePath(parent, root);
  if (relative !== parent) return relative;
  return shortenHome(parent);
}

function shortenHome(directory: string): string {
  const home = homeDirectory();
  if (home && (directory === home || directory.startsWith(`${home}/`))) {
    return `~${directory.slice(home.length)}`;
  }
  return directory;
}

/** Best-effort user home for display only. Never used to resolve a real path. */
function homeDirectory(): string | undefined {
  const fromEnv = typeof process !== "undefined" ? process.env.HOME ?? process.env.USERPROFILE : undefined;
  if (fromEnv) return fromEnv.replace(/\\/g, "/").replace(/\/$/, "");
  return undefined;
}

/**
 * Files a turn wrote or handed to the user (`show_files`).
 * Shown images are an album grid; other shown files are a compact list with
 * the parent directory. A shown file that the same turn also wrote keeps this
 * card and carries its write stats as a secondary marker; written-only files
 * stay the existing chips and open as a diff.
 */
export function TurnWrittenFiles({ files, onOpenFile, sessionId, cwd }: {
  files: TurnFileRow[];
  onOpenFile?: ((filePath: string, options?: { initialDisplayMode?: "diff"; source?: "turn-files" }) => void) | undefined;
  sessionId?: string | undefined;
  cwd?: string | undefined;
}) {
  const { t } = useI18n();
  if (files.length === 0) return null;
  const written = files.filter((file) => file.source === "written");
  const shown = files.filter((file) => file.source === "shown");
  const images = shown.filter((file) => file.kind === "image");
  const others = shown.filter((file) => file.kind !== "image");
  const open = (filePath: string) => onOpenFile?.(filePath, { source: "turn-files" });

  return (
    <>
    {shown.length > 0 ? (
      <div className="turn-shown-files" aria-label={t("desktop.filesShown")}>
        {images.length > 0 ? (
          <div className="turn-shown-grid">
            {images.map((file) => {
              const name = getFileName(file.filePath);
              return (
                <button
                  key={file.filePath}
                  type="button"
                  className="turn-shown-shot"
                  title={file.filePath}
                  aria-label={t("desktop.openWrittenFile", { name })}
                  onClick={() => open(file.filePath)}
                >
                  <img src={urls.files.file(file.filePath, "read", { sessionId })} alt="" />
                </button>
              );
            })}
          </div>
        ) : null}
        {others.length > 0 ? (
          <div className="turn-shown-list">
            {others.map((file) => {
              const name = getFileName(file.filePath);
              const parent = shownFileParentLabel(file.filePath, cwd);
              return (
                <button
                  key={file.filePath}
                  type="button"
                  className="turn-shown-row"
                  title={file.filePath}
                  aria-label={t("desktop.openWrittenFile", { name })}
                  onClick={() => open(file.filePath)}
                >
                  {getFileIcon(name, 16)}
                  <span className="turn-shown-name">{name}</span>
                  {file.source === "shown" && file.additions !== undefined && (
                    <span className="turn-shown-stats">
                      <span style={{ color: "var(--accent-green)" }}>+{file.additions}</span>
                      {file.deletions !== undefined && <span style={{ color: "var(--accent-red)" }}>-{file.deletions}</span>}
                    </span>
                  )}
                  {parent ? <span className="turn-shown-dir">{parent}</span> : null}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    ) : null}
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
    </>
  );
}
