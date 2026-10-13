import { it } from "node:test";
import assert from "node:assert/strict";
import { mapMessage } from "../src/mappers/index.js";

it("maps Pi system-prompt snapshot entries to a hidden custom message", () => {
  const mapped = mapMessage({ role: "system", content: "", sections: { preamble: "secret prompt" } }) as { role: string; customType?: string; display?: boolean; content: unknown[] };
  assert.equal(mapped.role, "custom");
  assert.equal(mapped.customType, "system-prompt");
  assert.equal(mapped.display, false);
  assert.deepEqual(mapped.content, []);
});
