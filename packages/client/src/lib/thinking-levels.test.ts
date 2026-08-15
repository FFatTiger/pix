import { describe, expect, it } from "vitest";
import {
  filterThinkingLevelOptions,
  modelKey,
  modelProfileKey,
  THINKING_LEVEL_OPTIONS,
} from "./thinking-levels";

// Ported verbatim from the legacy desktop source lib/thinking-levels.test.mjs.
describe("thinking levels", () => {
  it("filterThinkingLevelOptions: 始终包含 auto，且档位 = 模型支持表", () => {
    const levels = ["off", "minimal", "low", "medium", "high"]; // deepseek 类（无 xhigh/max）
    const result = filterThinkingLevelOptions(levels);
    expect(result.includes("auto")).toBeTruthy();
    expect(result).toEqual(["high", "medium", "low", "minimal", "auto", "off"]);
  });

  it("filterThinkingLevelOptions: 支持 xhigh/max 时档位完整", () => {
    const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    const result = filterThinkingLevelOptions(levels);
    expect(result).toEqual(THINKING_LEVEL_OPTIONS);
  });

  it("filterThinkingLevelOptions: availableLevels 为 null（无数据）时显示全部档位", () => {
    expect(filterThinkingLevelOptions(null)).toEqual(THINKING_LEVEL_OPTIONS);
    expect(filterThinkingLevelOptions(undefined)).toEqual(THINKING_LEVEL_OPTIONS);
  });

  it("filterThinkingLevelOptions: 5 档（无 xhigh/max）时档位完整显示", () => {
    // deepseek 类模型：levels 只有 5 档，必须全部出现（等级列表=模型支持表，不额外裁剪）
    const levels = ["off", "minimal", "low", "medium", "high"];
    expect(filterThinkingLevelOptions(levels).length).toBe(6); // 5 档 + auto
  });

  it("key 分隔符约定", () => {
    expect(modelKey("reqtoken", "gpt-5.6")).toBe("reqtoken/gpt-5.6");
    expect(modelProfileKey("reqtoken", "gpt-5.6")).toBe("reqtoken:gpt-5.6");
  });
});
