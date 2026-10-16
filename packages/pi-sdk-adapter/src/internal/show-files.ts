/**
 * `show_files` — hand files to the user.
 *
 * Registered for EVERY session (ordinary projects and the assistant). The
 * tool resolves each path against the session cwd, checks it is an existing
 * regular file, and returns only the path list. It never reads file bytes:
 * the client renders chips (and image thumbnails) from the paths, and the
 * right pane previews the one file named by `open`.
 */
import { lstatSync } from "node:fs";
import { basename, extname, isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

export const SHOW_FILES_TOOL_NAME = "show_files";

/** Extensions the client already treats as images (mirrors client `IMAGE_EXT_TO_MIME`). */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".avif"]);

export const SHOW_FILES_MAX = 10;

export interface ShownFile {
  path: string;
  name: string;
  kind: "image" | "file";
}

export interface ShowFilesDetails {
  files: ShownFile[];
  open?: string;
}

export function showFileKind(filePath: string): ShownFile["kind"] {
  return IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase()) ? "image" : "file";
}

function toolError(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined, isError: true as const };
}

/**
 * Resolve and validate one path. Relative paths resolve against `cwd`;
 * missing paths and directories fail closed with the path named in the error.
 */
export function resolveShowFile(raw: string, cwd: string): { file: ShownFile } | { error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { error: "文件路径为空。" };
  const absolute = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(absolute);
  } catch {
    return { error: `文件不存在：${absolute}` };
  }
  if (info.isSymbolicLink()) return { error: `不是普通文件：${absolute}` };
  if (info.isDirectory()) return { error: `是目录，不是文件：${absolute}` };
  if (!info.isFile()) return { error: `不是普通文件：${absolute}` };
  return { file: { path: absolute, name: basename(absolute), kind: showFileKind(absolute) } };
}

export function createShowFilesExtension(): InlineExtension {
  return (pi: ExtensionAPI): void => {
    pi.registerTool({
      name: SHOW_FILES_TOOL_NAME,
      label: "给你看文件",
      description: [
        "把图片、文档、网页或其他文件展示给用户。生成或找到需要用户看的文件时调用。",
        "一次可给 1 到 10 个文件；files 是绝对路径或相对当前目录的路径。",
        "open 可选，最多一个，且必须是 files 里的一个：它会立刻在用户的侧边栏打开。",
        "不要用 read 读图片来给用户看——read 的图片不会展示给用户。本工具不读取文件内容。",
      ].join(""),
      promptSnippet: "把文件展示给用户，可选立刻在侧边栏打开其中一个。",
      promptGuidelines: [
        "需要用户看图片、文档、网页或文件时用 show_files，不要用 read 读图片来展示。",
        "一次列出全部相关文件；只有确实需要立刻打开时才设置 open，且最多一个。",
      ],
      parameters: Type.Object({
        files: Type.Array(Type.String({ minLength: 1 }), {
          minItems: 1,
          maxItems: SHOW_FILES_MAX,
          description: "要展示的文件路径，1 到 10 个",
        }),
        open: Type.Optional(Type.String({ description: "立刻在侧边栏打开的那个文件，必须是 files 之一" })),
      }),
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const files: ShownFile[] = [];
        const seen = new Set<string>();
        for (const raw of params.files) {
          const resolved = resolveShowFile(raw, ctx.cwd);
          if ("error" in resolved) return toolError(resolved.error);
          if (seen.has(resolved.file.path)) continue;
          seen.add(resolved.file.path);
          files.push(resolved.file);
        }
        if (files.length === 0) return toolError("没有可展示的文件。");
        let open: string | undefined;
        // Models often send open: "" for "none"; treat blank as unset.
        if (params.open !== undefined && params.open.trim() !== "") {
          const resolvedOpen = resolveShowFile(params.open, ctx.cwd);
          if ("error" in resolvedOpen) return toolError(resolvedOpen.error);
          if (!seen.has(resolvedOpen.file.path)) {
            return toolError(`open 必须是 files 里的一个文件：${resolvedOpen.file.path}`);
          }
          open = resolvedOpen.file.path;
        }
        const details: ShowFilesDetails = open === undefined ? { files } : { files, open };
        const opened = open === undefined ? "" : `，已在侧边栏打开 ${basename(open)}`;
        return {
          content: [{ type: "text" as const, text: `已展示 ${files.length} 个文件给用户${opened}。` }],
          details,
        };
      },
    });
  };
}
