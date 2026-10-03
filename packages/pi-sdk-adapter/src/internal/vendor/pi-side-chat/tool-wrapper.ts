import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { FileActivityTracker } from "./file-activity-tracker.js";

export function wrapToolsWithOverlapDetection(
  tools: AgentTool[],
  tracker: FileActivityTracker,
  cwd: string,
  confirmOverlap: (path: string) => Promise<boolean>,
): AgentTool[] {
  const writingTools = ["write", "edit", "bash"];
  return tools.map((tool) =>
    writingTools.includes(tool.name) ? wrapTool(tool, tracker, cwd, confirmOverlap) : tool
  );
}

function wrapTool(
  tool: AgentTool,
  tracker: FileActivityTracker,
  cwd: string,
  confirmOverlap: (path: string) => Promise<boolean>,
): AgentTool {
  return {
    ...tool,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const paths = extractWritePaths(tool.name, args);

      for (const path of paths) {
        if (tracker.hasWritten(path, cwd)) {
          const proceed = await confirmOverlap(path);
          if (!proceed) {
            return {
              content: [{ type: "text", text: `Skipped: ${path} (main agent has modified it)` }],
              details: undefined,
            };
          }
        }
      }

      return tool.execute(toolCallId, args, signal, onUpdate);
    },
  };
}

export function extractWritePaths(toolName: string, args: unknown): string[] {
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};

  switch (toolName) {
    case "write":
    case "edit":
      return typeof record.path === "string" ? [record.path] : [];
    case "bash":
      return typeof record.command === "string" ? parseBashWritePaths(record.command) : [];
    default:
      return [];
  }
}

function parseBashWritePaths(command: string): string[] {
  const tokens = tokenizeShell(command);
  const paths: string[] = [];
  let segment: ShellToken[] = [];

  for (const token of tokens) {
    if (token.type === "op" && isCommandSeparator(token.value)) {
      collectSegmentWritePaths(segment, paths);
      segment = [];
      continue;
    }
    segment.push(token);
  }

  collectSegmentWritePaths(segment, paths);
  return [...new Set(paths)];
}

type ShellToken =
  | { type: "word"; value: string }
  | { type: "op"; value: ">" | ">>" | "|" | "||" | "&" | "&&" | ";" };

function tokenizeShell(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];

  for (let i = 0; i < command.length;) {
    const char = command[i];

    if (char !== undefined && /\s/.test(char)) {
      i++;
      continue;
    }

    const twoCharOp = command.slice(i, i + 2);
    if (twoCharOp === ">>" || twoCharOp === "||" || twoCharOp === "&&") {
      tokens.push({ type: "op", value: twoCharOp });
      i += 2;
      continue;
    }

    if (char === ">" || char === "|" || char === "&" || char === ";") {
      tokens.push({ type: "op", value: char });
      i++;
      continue;
    }

    let value = "";
    while (i < command.length) {
      const current = command[i];
      if (current === undefined) break;

      if (/\s/.test(current) || current === ">" || current === "|" || current === "&" || current === ";") break;

      if (current === "\\") {
        if (i + 1 < command.length) {
          value += command[i + 1];
          i += 2;
        } else {
          i++;
        }
        continue;
      }

      if (current === "'") {
        i++;
        while (i < command.length && command[i] !== "'") {
          value += command[i];
          i++;
        }
        if (command[i] === "'") i++;
        continue;
      }

      if (current === '"') {
        i++;
        while (i < command.length && command[i] !== '"') {
          const quoted = command[i];
          if (quoted === "\\" && i + 1 < command.length && /["\\$`]/.test(command[i + 1] ?? "")) {
            value += command[i + 1];
            i += 2;
          } else {
            value += quoted;
            i++;
          }
        }
        if (command[i] === '"') i++;
        continue;
      }

      value += current;
      i++;
    }

    if (value) tokens.push({ type: "word", value });
  }

  return tokens;
}

function collectSegmentWritePaths(segment: ShellToken[], paths: string[]): void {
  for (let i = 0; i < segment.length; i++) {
    const token = segment[i];
    if (token?.type === "op" && (token.value === ">" || token.value === ">>")) {
      const next = segment[i + 1];
      if (next?.type === "word") {
        pushPath(paths, next.value);
        i++;
      }
    }
  }

  const commandIndex = segment.findIndex((token) => token.type === "word");
  if (commandIndex === -1) return;
  const command = segment[commandIndex];
  if (command?.type !== "word") return;

  const operands = collectCommandOperands(segment.slice(commandIndex + 1));
  if (command.value === "tee" || command.value === "touch" || command.value === "rm") {
    for (const operand of operands) pushPath(paths, operand);
  }
  if ((command.value === "cp" || command.value === "mv") && operands.length >= 2) {
    const destination = operands[operands.length - 1];
    if (destination !== undefined) pushPath(paths, destination);
  }
}

function collectCommandOperands(tokens: ShellToken[]): string[] {
  const operands: string[] = [];
  let parsingOptions = true;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) continue;

    if (token.type === "op") {
      if ((token.value === ">" || token.value === ">>") && tokens[i + 1]?.type === "word") i++;
      continue;
    }

    if (parsingOptions) {
      if (token.value === "--") {
        parsingOptions = false;
        continue;
      }
      if (token.value.startsWith("-")) continue;
      parsingOptions = false;
    }

    operands.push(token.value);
  }

  return operands;
}

function isCommandSeparator(value: Extract<ShellToken, { type: "op" }>["value"]): boolean {
  return value === "|" || value === "||" || value === "&" || value === "&&" || value === ";";
}

function pushPath(paths: string[], path: string): void {
  if (path && !path.startsWith("-") && !isIgnoredWritePath(path)) paths.push(path);
}

function isIgnoredWritePath(path: string): boolean {
  return path === "/dev/null" || path === "/dev/stdout" || path === "/dev/stderr" || path.startsWith("/dev/fd/");
}
