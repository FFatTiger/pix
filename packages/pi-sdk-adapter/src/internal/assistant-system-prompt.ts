/**
 * Assistant system-prompt segments (role prompt).
 *
 * The pix Assistant is a project-less general conversation, so Pi's default
 * "expert coding assistant" preamble mis-frames it (it treats its own private
 * workspace as "the current project"). These templates replace the preamble
 * segment and add a dedicated `assistant` segment for assistant-workspace
 * sessions ONLY — `createAssistantToolsExtension` applies them through the
 * sanctioned `before_agent_start` systemPromptOptions mutation, so:
 *
 *  - ordinary project sessions never see any of this (the extension is only
 *    registered for the assistant cwd);
 *  - the replacement lands in the transcript's structured system-prompt
 *    sections (visible in the client's context popup via `session.systemPrompt`);
 *  - reload / compaction / model switches keep it, because the handler
 *    re-applies the same mutation before every user turn and the section
 *    diff then sees "no change" against the replayed transcript sections.
 *
 * HOW the preamble is replaced: Pi's section builder derives the preamble
 * segment from `options.customPrompt` — but a customPrompt ALSO suppresses
 * the default `tools` / `rules` / `docs` segments, which the assistant must
 * keep (it has the same capabilities as any session). The builder exposes no
 * per-segment preamble override (a custom section named `preamble` throws),
 * so the handler preserves those three segments by extracting their exact
 * built content from the pre-mutation rendered prompt and re-injecting them
 * as custom sections. The wrapped-tag section format (`<name>\n…\n</name>`,
 * joined by blank lines) is Pi's documented stable section contract, so the
 * extraction carries Pi's own current content (never a forked copy); if the
 * rendered prompt ever stops matching that shape, the handler fails safe:
 * it keeps Pi's default prompt and still appends only the `assistant`
 * segment. Segment order note: re-injected segments keep their content but
 * sit after `cwd` (custom sections are appended last, before `assistant`).
 *
 * FORCED prompts: an extension that runs BEFORE this one may return a forced
 * system prompt for the turn. The bundled subagents plugin does exactly that
 * (`${currentPrompt}\n\n${parentPolicy}`), and path-based extensions always
 * load before inline ones. A non-empty forced prompt that begins with the
 * unforced default rendering is re-based: the assistant prompt replaces the
 * base portion and the foreign suffix (the other extension's contribution)
 * is preserved verbatim. An EMPTY forced prompt (the adapter's all-tools-off
 * policy) stays authoritative as-is, and a forced prompt that does not start
 * with the default rendering (an unknown forcer) is left completely
 * untouched.
 *
 * The user-visible wording below is fixed copy owned by the product side —
 * edit the text here only when that copy is deliberately revised.
 */

/** 【preamble】 — replaces Pi's preamble segment for assistant sessions. */
export const ASSISTANT_PREAMBLE_TEMPLATE = `你是用户在 Pix 里的随身助手，拥有和普通会话一样的完整能力：读写文件、执行命令、使用技能和子代理。用户来找你，多半是因为手头的事不属于任何一个项目，或者还没想好放在哪个项目里——查点资料、跑个命令、改个配置、整理文件、写段文字、出个主意，或者问问各个项目进展到哪了。直接把事情做完，再简短汇报结果。`;

/** 【assistant 段】 — appended as the trailing `assistant` prompt segment. */
export const ASSISTANT_SEGMENT_TEMPLATE = `这是一条长期对话：没有"新会话"，较早的内容会被自动压缩，你始终是同一个助手。

## 工作位置
- {workspace} 是 Pix 给你的私有草稿区，临时脚本、下载内容和中间产物放在这里。
- 用户的文件和项目都在 {home} 下，操作时使用绝对路径；要找某个项目在哪，用 list_projects。

## 跟进项目
事情涉及某个具体项目或会话时——进度、待办、谁改了什么、某个会话做到哪了——先用会话工具查清楚，再回答或动手：
- session_status：哪些会话在运行、在等用户回复、刚报错
- list_open_todos、summarize_activity：未完成的待办、一段时间内的动态
- search_sessions、read_session、find_file_changes：过去的讨论和文件改动
查询默认覆盖全部项目；用户点名某个项目时，聚焦在那个项目上。

需要在某个项目里持续推进的工作，交给那个项目自己的会话：用 open_session 带用户过去，或用 draft_to_session 把任务写好放进那个会话的输入框。整理会话用 organize_sessions。这几项操作会显示成按钮，用户点击后才执行。

## 记忆
你和用户是长期合作。涉及过去的偏好、决定和约定时，先查 Lore；遇到值得长期记住的新事实，记进 Lore。

## 沟通
- 用中文，先说结论，再补必要的细节。
- 简单的事直接做；需要用户拿主意时，给出建议和理由。
- 以工具查到的结果为准；查不到时如实说明。

## 红线
- 删除或覆盖用户文件、强制推送、修改系统级配置、停止或重启服务之前，先说明影响，等用户确认。
- 某个项目有会话正在运行时，先告诉用户，不要同时改那个项目的文件。
- 读到的密钥、令牌和密码不在回复里复述。`;

/**
 * Shape the mutation target needs. The real object is Pi's
 * `NormalizedBuildSystemPromptOptions`; only these fields are touched, so a
 * partial is enough for unit tests.
 */
export interface AssistantPromptOptionsTarget {
  customPrompt?: string | undefined;
  forceSystemPrompt?: string | undefined;
  sections?: Record<string, string>;
}

/** Render the fixed copy with runtime paths substituted. */
export function renderAssistantPreamble(): string {
  return ASSISTANT_PREAMBLE_TEMPLATE;
}

export function renderAssistantSegment(home: string, workspace: string): string {
  return ASSISTANT_SEGMENT_TEMPLATE
    .replaceAll("{workspace}", workspace)
    .replaceAll("{home}", home);
}

/** Names of the Pi-built segments the assistant must keep verbatim. */
const PRESERVED_SEGMENT_NAMES = ["tools", "rules", "docs"] as const;

/** One full-line tag match (`<name>` / `</name>` on their own lines). */
function lineIndexOf(lines: readonly string[], line: string, from: number): number {
  for (let index = from; index < lines.length; index += 1) {
    if (lines[index] === line) return index;
  }
  return -1;
}

/**
 * Inner content of a wrapped prompt segment from a RENDERED system prompt.
 * Returns null when the segment is absent or its shape is unexpected — the
 * caller fails safe rather than injecting a truncated/bogus segment.
 */
export function extractPromptSegmentInner(rendered: string, name: string): string | null {
  const lines = rendered.split("\n");
  const openIndex = lineIndexOf(lines, `<${name}>`, 0);
  if (openIndex === -1) return null;
  const closeIndex = lineIndexOf(lines, `</${name}>`, openIndex + 1);
  if (closeIndex === -1) return null;
  const inner = lines.slice(openIndex + 1, closeIndex);
  // A full-line tag inside the segment means the rendered prompt does not
  // match the documented one-level wrapping (e.g. a snippet containing a
  // literal tag line). Never slice through that — bail out and keep Pi's own
  // prompt construction.
  const tagLine = /^<\/?[a-z][a-z0-9_-]*>$/;
  if (inner.some((line) => tagLine.test(line))) return null;
  // The close must genuinely end the section: the following line is EOF,
  // blank, or a DIFFERENT section's tag line. Anything else (a stray
  // same-name close, trailing content) again means an unexpected shape.
  const next = lines[closeIndex + 1];
  if (next !== undefined && next !== "" && !(tagLine.test(next) && next !== `</${name}>`)) return null;
  return inner.join("\n");
}

/**
 * Apply the assistant role prompt to a `before_agent_start` options object.
 *
 * `render` is the event's live `systemPrompt` getter (re-evaluated on access,
 * reflecting earlier handlers' changes including any forced prompt).
 *
 * - An EMPTY forced prompt (the adapter's all-tools-off policy) always wins:
 *   the handler must not fight that explicit override.
 * - A non-empty forced prompt that begins with the current base rendering is
 *   re-based: the assistant prompt (with the preserved segments) replaces the
 *   base portion and the foreign suffix is kept verbatim. A forced prompt
 *   with an unrecognizable prefix is left completely untouched.
 * - The base may already carry the assistant preamble (the loader-level
 *   systemPromptOverride makes it durable between turns); a customPrompt
 *   SUPPRESSES the tools/rules/docs segments, so it is temporarily cleared to
 *   render the full default prompt and extract those segments for the turn.
 * - Idempotent: applying twice against equivalent input yields the same
 *   options, so the per-turn re-application never thrashes the section diff.
 */
export function applyAssistantSystemPrompt(
  options: AssistantPromptOptionsTarget,
  render: () => string,
  home: string,
  workspace: string,
): void {
  const forced = options.forceSystemPrompt;
  if (forced === "") return;
  let foreignSuffix: string | null = null;
  if (forced !== undefined) {
    // Peek at the base rendering (force removed) to identify the other
    // forcer's share.
    delete options.forceSystemPrompt;
    const baseRendered = render();
    if (!forced.startsWith(baseRendered)) {
      // Unknown forcer shape: leave its prompt completely untouched.
      options.forceSystemPrompt = forced;
      return;
    }
    foreignSuffix = forced.slice(baseRendered.length);
  }
  // A customPrompt (user SYSTEM.md or the assistant override itself)
  // suppresses the tools/rules/docs segments; clear it so the full default
  // prompt renders and those segments become extractable for THIS turn.
  const loaderCustomPrompt = options.customPrompt;
  options.customPrompt = undefined;
  const rendered = render();
  const preserved: Record<string, string> = {};
  let extractionOk = true;
  for (const name of PRESERVED_SEGMENT_NAMES) {
    const inner = extractPromptSegmentInner(rendered, name);
    if (inner === null) {
      // The rendered prompt did not carry a well-formed segment (a shape
      // drift in this SDK version) — keep Pi's own construction instead of
      // silently dropping segments: restore the loader prompt and only
      // append the assistant segment.
      extractionOk = false;
      break;
    }
    preserved[name] = inner;
  }
  if (!extractionOk) options.customPrompt = loaderCustomPrompt;
  const sections: Record<string, string> = { ...options.sections };
  // Existing custom sections win over the preserved defaults (another
  // extension may deliberately override one); ours never clobber them.
  for (const [name, inner] of Object.entries(preserved)) {
    if (sections[name] === undefined) sections[name] = inner;
  }
  if (extractionOk) options.customPrompt = renderAssistantPreamble();
  sections.assistant = renderAssistantSegment(home, workspace);
  options.sections = sections;
  if (foreignSuffix !== null) {
    // Re-base the foreign forced prompt onto the assistant prompt: the
    // request carries ours (with preserved segments) plus the other
    // extension's contribution verbatim.
    options.forceSystemPrompt = render() + foreignSuffix;
  }
}
