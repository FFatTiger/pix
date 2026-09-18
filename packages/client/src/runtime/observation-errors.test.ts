import { describe, expect, it } from "vitest";
import {
  describeRuntimeObservationError,
  runtimeObservationMessageKind,
  RUNTIME_OBSERVATION_MESSAGE_KEYS,
} from "./observation-errors";

describe("runtime observation errors", () => {
  it("maps unsupported_capability to the unavailable i18n key and never interpolates backend text", () => {
    const cause = { code: "unsupported_capability", message: "raw host dump /secret", retryable: false };
    expect(runtimeObservationMessageKind(cause)).toBe("unavailable");
    expect(describeRuntimeObservationError(cause)).toBe(
      "This server cannot show a live view of running sessions. History stays available; sending still works.",
    );
    expect(describeRuntimeObservationError(cause, (key) => `i18n:${key}`)).toBe(
      `i18n:${RUNTIME_OBSERVATION_MESSAGE_KEYS.unavailable}`,
    );
    expect(describeRuntimeObservationError(cause)).not.toContain("raw host dump");
  });

  it("maps every other failure to the failed i18n key", () => {
    expect(runtimeObservationMessageKind({ code: "unavailable", message: "boom" })).toBe("failed");
    expect(describeRuntimeObservationError({ code: "timeout", message: "late" })).toBe(
      "Couldn't open the live view for this session. It keeps running in the background.",
    );
  });
});
