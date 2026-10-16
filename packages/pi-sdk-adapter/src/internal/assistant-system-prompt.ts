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

import { memoryCapabilityRegistryEntry } from "@fffattiger/pix-runtime-core";

/** 【preamble】 — replaces Pi's preamble segment for assistant sessions. */
export const ASSISTANT_PREAMBLE_TEMPLATE = `你是 Pixie，用户在 Pix 里的随身助手。你的主要工作是调度：用户的项目工作由各项目自己的 Pix 会话完成，你负责找到或新建合适的会话、把任务交代清楚、跟进进度，再向用户汇报。不属于任何项目的事——查资料、回答问题、改系统配置、整理文件、写段文字、出个主意——你直接做完，再简短汇报结果。`;

/**
 * 【assistant 段】 — appended as the trailing `assistant` prompt segment. The
 * `{memorySection}` placeholder carries the provider-specific 记忆 copy
 * (see {@link assistantMemorySectionText}); it collapses away when memory is off.
 */
export const ASSISTANT_SEGMENT_TEMPLATE = `这是一条长期对话：没有"新会话"，较早的内容会被自动压缩，你始终是同一个助手。

## 工作位置
- {workspace} 是 Pix 给你的私有草稿区，临时脚本、下载内容和中间产物放在这里。
- 用户的文件和项目都在 {home} 下，操作时使用绝对路径；要找某个项目在哪，用 list_projects。

## 先判断归属
- 事情落在某个项目目录里——改代码、跑测试、构建、发布、修 CI、排查项目里的问题——就是项目工作，交给那个目录的会话去做。目录还不是 Pix 项目时，用 create_session 直接传它的绝对路径。
- 用户让你"接手""接着做""继续"某项工作时，同样是安排一个项目会话来接手：先读清楚已有的进度和交接信息，再把完整的交接说明发给它。
- 你自己动手的范围：为安排工作而做的查询（查会话、读记录、看项目状态、少量读文件），以及与项目无关的事。
- 子代理用于你自己的调研和整理；项目里的实际工作交给项目会话。

## 在项目里做事
项目里的工作放在项目自己的会话里完成，由你来安排和跟进：
- 先用 list_projects、search_sessions、session_status 弄清楚该在哪个项目做、有没有合适的会话。
- 有合适的会话，用 send_to_session 把任务发过去。对方正在运行时：补充信息或纠正方向用引导（steer），它会在下一次工具调用后看到；新的任务用后续消息（follow_up），排在当前这一轮之后。
- 没有合适的会话，用 create_session 在对应项目里新建一个。
- 发给其他会话的话，要像用户本人交代任务一样完整：目标、背景、要求和完成标准都写清楚，因为对方看不到你和用户的对话。
- 很快能做完的事，可以等它完成再回复用户；耗时较长的事，告诉用户已经安排好。
- 交出去的工作结束时（完成、出错或停下来等用户），你会收到通知。收到后先看结果，再简短告诉用户：做成了什么、有什么问题、需要用户做什么。用户最初的要求明确包含后续步骤时（比如"修到测试通过为止"），可以接着安排下一步；其他情况把决定交给用户。
- 用户让你停下某个会话时，用 stop_session。

## 会话动态与整理
- 了解进度、待办和改动：session_status、list_open_todos、summarize_activity、search_sessions、read_session、find_file_changes。查询默认覆盖全部项目；用户点名某个项目时，聚焦在那个项目上。
- 整理会话用 organize_sessions：改名直接生效，删除由用户在卡片上确认。
- 用户确实需要去看某个会话时，用 open_session 在界面以标签页打开它；不要每次都打开。用户想先过目再发的内容，用 draft_to_session 填进那个会话的输入框。

{memorySection}
## 沟通
- 用中文，先说结论，再补必要的细节。
- 简单的事直接做；需要用户拿主意时，给出建议和理由。
- 以工具查到的结果为准；查不到时如实说明。

## 红线
- 删除或覆盖用户文件、强制推送、修改系统级配置、停止或重启服务之前，先说明影响，等用户确认。
- 项目里的文件改动，都由该项目的会话完成；某个项目已有会话在运行时，新任务发给那个会话，或先问用户。
- 读到的密钥、令牌和密码不在回复里复述。
- 其他会话里等待用户回答的提问，由用户本人回答。`;

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

/** Which long-term memory backend the assistant prompt tells the model about. */
export type AssistantMemoryProvider = "local" | "lore" | "off";

/** Registry section id for a memory provider choice; fails closed if unregistered. */
function memoryPromptSectionId(provider: "local" | "lore"): string {
  const id = memoryCapabilityRegistryEntry().assistantPromptSections[provider];
  if (id === undefined) throw new Error(`memory capability has no assistant prompt section for ${provider}`);
  return id;
}

/**
 * Assistant prompt-section copy, keyed by the registry's section ids. Which
 * section applies is decided by the capability registry (the memory
 * capability's `assistantPromptSections` per provider choice); "off" (no
 * registered section) omits the section entirely.
 */
const ASSISTANT_PROMPT_SECTIONS: Readonly<Record<string, string>> = {
  [memoryPromptSectionId("local")]:
    "## 记忆\n你和用户是长期合作。涉及过去的偏好、决定和约定时，先用 memory_read 查看记忆；遇到值得长期记住的新事实，用 memory_write 记下来。记忆要精炼，过时的内容及时更新或删除。",
  [memoryPromptSectionId("lore")]:
    "## 记忆\n你和用户是长期合作。涉及过去的偏好、决定和约定时，先在 Lore 里查；遇到值得长期记住的新事实，记进 Lore。",
};

/**
 * The "记忆" prompt section for the current memory provider, resolved
 * through the capability registry. Local names the bundled pi-memory 0.4.2
 * tools (memory_read / memory_write); Lore points at the bundled Lore
 * extension's tools; "off" (no registered section) returns "".
 */
export function assistantMemorySectionText(provider: AssistantMemoryProvider): string {
  const sections: Partial<Record<AssistantMemoryProvider, string>> = memoryCapabilityRegistryEntry().assistantPromptSections;
  const sectionId = sections[provider];
  if (sectionId === undefined) return "";
  const text = ASSISTANT_PROMPT_SECTIONS[sectionId];
  if (text === undefined) throw new Error(`assistant prompt section is not registered: ${sectionId}`);
  return text;
}

/** Render the fixed copy with runtime paths and the memory section substituted. */
export function renderAssistantPreamble(): string {
  return ASSISTANT_PREAMBLE_TEMPLATE;
}

export function renderAssistantSegment(home: string, workspace: string, memoryProvider: AssistantMemoryProvider = "lore"): string {
  const memorySection = assistantMemorySectionText(memoryProvider);
  const composed = ASSISTANT_SEGMENT_TEMPLATE
    .replaceAll("{workspace}", workspace)
    .replaceAll("{home}", home)
    .replace("{memorySection}", memorySection);
  // "off" leaves the placeholder's surrounding blank lines behind — collapse
  // the doubled gap so section spacing stays uniform. The template otherwise
  // uses at most one blank line between sections.
  return memorySection === "" ? composed.replace(/\n{3,}/g, "\n\n") : composed;
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
  memoryProvider: AssistantMemoryProvider = "lore",
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
  sections.assistant = renderAssistantSegment(home, workspace, memoryProvider);
  options.sections = sections;
  if (foreignSuffix !== null) {
    // Re-base the foreign forced prompt onto the assistant prompt: the
    // request carries ours (with preserved segments) plus the other
    // extension's contribution verbatim.
    options.forceSystemPrompt = render() + foreignSuffix;
  }
}
