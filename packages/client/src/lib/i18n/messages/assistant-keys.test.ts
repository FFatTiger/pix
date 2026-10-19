import { describe, expect, it } from "vitest";
import { enLocale } from "./en";
import { zhCNLocale } from "./zh-CN";

const KEYS = [
  "desktop.codexAssistantSendToSession",
  "desktop.codexAssistantSendToSessionDetail",
  "desktop.codexAssistantCreateSession",
  "desktop.codexAssistantCreateSessionDetail",
  "desktop.codexAssistantStopSession",
  "desktop.codexAssistantStopSessionDetail",
  "desktop.codexAssistantMemoryForgot",
  "desktop.codexAssistantMemoryForgotDetail",
  "desktop.codexAssistantMemoryRestored",
  "desktop.codexAssistantScratchpad",
  "desktop.codexAssistantScratchpadDetail",
  "desktop.codexAssistantSearchedSessionsDetailEmpty",
  "desktop.codexAssistantSessionStatusDetailEmpty",
  "desktop.codexAssistantOpenTodosDetailEmpty",
  "desktop.codexAssistantActivityDetail",
  "desktop.codexAssistantActivityProjectDetail",
  "desktop.codexAssistantActivityRangeToday",
  "desktop.codexAssistantActivityRangeWeek",
  "desktop.codexAssistantActivityRangeDays",
  "desktop.codexAssistantProjectsDetailEmpty",
  "desktop.assistantActionRenamed",
  "desktop.assistantChip_send_to_session",
  "desktop.assistantChip_create_session",
  "desktop.assistantChip_open_session",
  "desktop.assistantChip_draft_to_session",
  "desktop.assistantSentLabel",
  "desktop.assistantNoticeTitle",
] as const;

describe("assistant session-operation i18n keys", () => {
  it("exist in both en and zh-CN", () => {
    for (const key of KEYS) {
      expect(enLocale.messages[key], key).toBeTruthy();
      expect(zhCNLocale.messages[key], key).toBeTruthy();
    }
    expect(zhCNLocale.messages["desktop.assistantActionRenamed"]).toContain("已改名");
    expect(enLocale.messages["desktop.assistantActionRenamed"]).toContain("Renamed");
    expect(zhCNLocale.messages["desktop.codexAssistantOrganize"]).toContain("整理");
  });
});
