/**
 * pi-memory tool surface trim (pinned pi-memory 0.4.2).
 *
 * Pix bundles pi-memory WITHOUT the optional qmd semantic-search model. The
 * `memory_search` tool only reports "qmd is not installed" without it, so it
 * is removed from the exact bundled registration before Pi registers tools —
 * the model never sees a tool that cannot succeed. Everything else
 * (memory_read / memory_write / scratchpad / forget / restore / status) is
 * pure local file IO and stays. Removal condition: the pi-memory upgrade that
 * makes memory_search degrade to non-semantic search without qmd.
 */
import { bundledPluginRoots, isExactBundledPath, type ExtensionLike, type LoadExtensionsLike } from "./curated-plugins.js";

export const MEMORY_SEARCH_TOOL_NAME = "memory_search";

function isExactBundledMemoryExtension(extension: ExtensionLike): boolean {
  const root = bundledPluginRoots().find((item) => item.id === "pi_memory");
  if (root === undefined) return false;
  return isExactBundledPath(extension.resolvedPath ?? extension.path, root);
}

/** Remove `memory_search` from the exact bundled pi-memory registration. */
export function dropBundledMemorySearchTools<T extends ExtensionLike, R>(
  base: LoadExtensionsLike<T, R>,
): LoadExtensionsLike<T, R> {
  return {
    ...base,
    extensions: base.extensions.map((extension) => {
      if (!isExactBundledMemoryExtension(extension) || extension.tools === undefined) return extension;
      if (!extension.tools.has(MEMORY_SEARCH_TOOL_NAME)) return extension;
      const tools = new Map(extension.tools);
      tools.delete(MEMORY_SEARCH_TOOL_NAME);
      return { ...extension, tools };
    }),
  };
}
