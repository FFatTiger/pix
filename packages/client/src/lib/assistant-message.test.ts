import { describe, expect, it } from "vitest";
import { assistantUserMessageKind, stripAssistantMarker, ASSISTANT_NOTIFY_MESSAGE_PREFIX, ASSISTANT_SENT_MESSAGE_PREFIX } from "./assistant-message";

describe("assistant user-message markers", () => {
  it("recognizes only an exact first line", () => {
    expect(assistantUserMessageKind(`${ASSISTANT_SENT_MESSAGE_PREFIX}\n\n正文`)).toBe("sent");
    expect(assistantUserMessageKind(`${ASSISTANT_NOTIFY_MESSAGE_PREFIX}\n\n正文`)).toBe("notice");
    expect(assistantUserMessageKind(`前缀 ${ASSISTANT_SENT_MESSAGE_PREFIX}\n正文`)).toBeNull();
    expect(assistantUserMessageKind("普通消息")).toBeNull();
  });

  it("strips the marker line and the one blank line after it", () => {
    expect(stripAssistantMarker(`${ASSISTANT_SENT_MESSAGE_PREFIX}\n\n正文`)).toBe("正文");
    expect(stripAssistantMarker(`${ASSISTANT_NOTIFY_MESSAGE_PREFIX}\n正文`)).toBe("正文");
  });
});
