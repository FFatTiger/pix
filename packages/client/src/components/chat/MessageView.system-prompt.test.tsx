import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageView } from "./MessageView";
import { I18nProvider } from "@/hooks/useI18n";

describe("MessageView system-prompt snapshot", () => {
  it("renders nothing for a Pi system-prompt snapshot entry", () => {
    const { container } = render(
      <I18nProvider>
        <MessageView message={{ role: "custom", customType: "system-prompt", content: [], display: false } as never} />
      </I18nProvider>,
    );
    expect(container.textContent).toBe("");
  });
});
