import { describe, expect, it, vi } from "vitest";
import type { SessionContext, SessionEntry } from "@fffattiger/pix-protocol";
import {
  VISIBLE_BRANCH_DISCLAIMER,
  VISIBLE_BRANCH_EXPORT_ERROR,
  VISIBLE_BRANCH_FORMAT,
  VISIBLE_BRANCH_SCOPE,
  VISIBLE_BRANCH_VERSION,
  buildVisibleBranchDocument,
  buildVisibleBranchFilename,
  cloneJsonSafe,
  downloadVisibleBranch,
  filenameSegmentFromSessionId,
  serializeVisibleBranchDocument,
  VisibleBranchExportError,
} from "./visible-branch-export";

const EXPORTED_AT = "2026-04-01T12:00:00.000Z";

function ctx(entries: SessionEntry[], overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    sessionId: "sess-1",
    entries,
    pageInfo: { hasMore: false },
    ...overrides,
  };
}

describe("filenameSegmentFromSessionId / buildVisibleBranchFilename", () => {
  it("keeps safe alphanumerics, dots, underscores, hyphens", () => {
    expect(filenameSegmentFromSessionId("abc_DEF-12.3")).toBe("abc_DEF-12.3");
    expect(buildVisibleBranchFilename("abc_DEF-12.3")).toBe("pix-visible-branch-abc_DEF-12.3.json");
  });

  it("NFKC-normalizes then replaces non-safe runs with single dashes", () => {
    // fullwidth digits NFKC → ASCII
    expect(filenameSegmentFromSessionId("\uFF11\uFF12\uFF13")).toBe("123");
    expect(filenameSegmentFromSessionId("a b/c\\d")).toBe("a-b-c-d");
    expect(filenameSegmentFromSessionId("a---b")).toBe("a---b"); // hyphens are safe, not collapsed
    expect(filenameSegmentFromSessionId("a@@@b")).toBe("a-b");
  });

  it("strips leading/trailing ._- and slices to 48", () => {
    expect(filenameSegmentFromSessionId("...foo...")).toBe("foo");
    expect(filenameSegmentFromSessionId("_-bar-_")).toBe("bar");
    const long = `x${"a".repeat(60)}`;
    expect(filenameSegmentFromSessionId(long)).toHaveLength(48);
    expect(filenameSegmentFromSessionId(long)).toBe(`x${"a".repeat(47)}`);
  });

  it("falls back to session when empty after sanitize", () => {
    expect(filenameSegmentFromSessionId("@@@")).toBe("session");
    expect(filenameSegmentFromSessionId("...")).toBe("session");
    expect(filenameSegmentFromSessionId("")).toBe("session");
    expect(buildVisibleBranchFilename("@@@")).toBe("pix-visible-branch-session.json");
  });

  it("never puts title/cwd/projectRoot/sessionFile/leafId into the filename", () => {
    const name = buildVisibleBranchFilename("id-only");
    expect(name).toBe("pix-visible-branch-id-only.json");
    expect(name).not.toMatch(/title|cwd|project|leaf|sessionFile/i);
  });
});

describe("cloneJsonSafe", () => {
  it("clones plain JSON values", () => {
    expect(cloneJsonSafe({ a: 1, b: [true, "x", null] })).toEqual({ a: 1, b: [true, "x", null] });
  });

  it("rejects non-finite numbers, bigint, undefined, function, symbol", () => {
    for (const bad of [NaN, Infinity, -Infinity, 1n, undefined, () => 1, Symbol("s")]) {
      expect(() => cloneJsonSafe(bad)).toThrow(VisibleBranchExportError);
      expect(() => cloneJsonSafe(bad)).toThrow(VISIBLE_BRANCH_EXPORT_ERROR);
    }
  });

  it("rejects circular structures", () => {
    const o: Record<string, unknown> = {};
    o.self = o;
    expect(() => cloneJsonSafe(o)).toThrow(VisibleBranchExportError);
  });

  it("only walks own enumerable string data keys on plain / null-prototype objects", () => {
    const o: Record<string, unknown> = { own: 2 };
    Object.defineProperty(o, "hidden", { value: 9, enumerable: false });
    expect(cloneJsonSafe(o)).toEqual({ own: 2 });

    const nullProto = Object.create(null) as Record<string, unknown>;
    nullProto.x = 1;
    expect(cloneJsonSafe(nullProto)).toEqual({ x: 1 });
    expect(Object.getPrototypeOf(cloneJsonSafe(nullProto) as object)).toBe(null);
  });

  it("rejects Date/Map/class instances and other exotic prototypes without calling toJSON", () => {
    class Widget {
      toJSON() {
        return { leaked: true };
      }
    }
    for (const bad of [new Date(), new Map([["a", 1]]), new Set([1]), /re/, new Widget()]) {
      expect(() => cloneJsonSafe(bad)).toThrow(VisibleBranchExportError);
      expect(() => cloneJsonSafe(bad)).toThrow(VISIBLE_BRANCH_EXPORT_ERROR);
    }
    // Custom prototype (not Object.prototype / null) is exotic even with own data.
    const custom = Object.create({ inherited: 1 }) as Record<string, unknown>;
    custom.own = 2;
    expect(() => cloneJsonSafe(custom)).toThrow(VisibleBranchExportError);
  });

  it("rejects own enumerable accessors without executing getters", () => {
    let getterHits = 0;
    const o = {};
    Object.defineProperty(o, "bad", {
      enumerable: true,
      get() {
        getterHits += 1;
        throw new Error("secret-raw-stack-trace-XYZ");
      },
    });
    try {
      cloneJsonSafe(o);
      expect.unreachable("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(VisibleBranchExportError);
      expect((error as Error).message).toBe(VISIBLE_BRANCH_EXPORT_ERROR);
      expect(String(error)).not.toContain("secret-raw-stack-trace-XYZ");
    }
    expect(getterHits).toBe(0);
  });

  it("clones legitimate shared subtrees independently (active stack, not global visited)", () => {
    const shared = { n: 1 };
    const root = { a: shared, b: shared };
    const cloned = cloneJsonSafe(root) as { a: { n: number }; b: { n: number } };
    expect(cloned).toEqual({ a: { n: 1 }, b: { n: 1 } });
    expect(cloned.a).not.toBe(cloned.b);
    expect(cloned.a).not.toBe(shared);
    expect(cloned.b).not.toBe(shared);
    // True cycles still reject after a successful shared-ref clone path.
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => cloneJsonSafe(cycle)).toThrow(VisibleBranchExportError);
  });

  it("preserves own enumerable __proto__/constructor as data properties without polluting Object.prototype", () => {
    // JSON.parse can produce an own enumerable `__proto__` data property.
    const fromJson = JSON.parse('{"__proto__":{"polluted":true},"constructor":"kept","ok":1}') as Record<
      string,
      unknown
    >;
    expect(Object.prototype.hasOwnProperty.call(fromJson, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(fromJson)).toBe(Object.prototype);

    const before = Object.prototype.hasOwnProperty("polluted");
    const cloned = cloneJsonSafe(fromJson) as Record<string, unknown>;

    expect(Object.prototype.hasOwnProperty.call(cloned, "__proto__")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(cloned, "constructor")).toBe(true);
    expect(cloned.ok).toBe(1);
    expect(cloned.constructor).toBe("kept");
    expect(cloned.__proto__).toEqual({ polluted: true });
    // Null prototype bag — no inherited Object.prototype members.
    expect(Object.getPrototypeOf(cloned)).toBe(null);
    // Must not pollute the real Object.prototype via assignment side effects.
    expect(Object.prototype.hasOwnProperty("polluted")).toBe(before);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();

    // JSON.stringify must still emit the own `__proto__` key.
    const serialized = JSON.stringify(cloned);
    expect(serialized).toContain('"__proto__"');
    expect(serialized).toContain('"polluted":true');
    const roundTrip = JSON.parse(serialized) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(roundTrip, "__proto__")).toBe(true);
    expect(roundTrip.__proto__).toEqual({ polluted: true });
    expect(Object.prototype.hasOwnProperty("polluted")).toBe(before);
  });

  it("maps Proxy getOwnPropertyDescriptor / getPrototypeOf / keys traps to the fixed error without leaking raw", () => {
    const target: Record<string, unknown> = { a: 1 };
    const proxy = new Proxy(target, {
      getOwnPropertyDescriptor() {
        throw new Error("desc-trap-SECRET");
      },
    });
    try {
      cloneJsonSafe(proxy);
      expect.unreachable("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(VisibleBranchExportError);
      expect((error as Error).message).toBe(VISIBLE_BRANCH_EXPORT_ERROR);
      expect(String(error)).not.toContain("desc-trap-SECRET");
    }

    const protoProxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("proto-trap-SECRET");
        },
      },
    );
    try {
      cloneJsonSafe(protoProxy);
      expect.unreachable("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(VisibleBranchExportError);
      expect((error as Error).message).toBe(VISIBLE_BRANCH_EXPORT_ERROR);
      expect(String(error)).not.toContain("proto-trap-SECRET");
    }

    const keysProxy = new Proxy(
      { a: 1 },
      {
        ownKeys() {
          throw new Error("keys-trap-SECRET");
        },
      },
    );
    try {
      cloneJsonSafe(keysProxy);
      expect.unreachable("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(VisibleBranchExportError);
      expect((error as Error).message).toBe(VISIBLE_BRANCH_EXPORT_ERROR);
      expect(String(error)).not.toContain("keys-trap-SECRET");
    }
  });

  it("maps revoked Proxy / array access failures to the fixed export error without leaking raw", () => {
    const target: Record<string, unknown> = { a: 1 };
    const { proxy, revoke } = Proxy.revocable(target, {});
    revoke();
    try {
      cloneJsonSafe(proxy);
      expect.unreachable("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(VisibleBranchExportError);
      expect((error as Error).message).toBe(VISIBLE_BRANCH_EXPORT_ERROR);
      expect(String(error)).not.toMatch(/revoked|Proxy/i);
    }

    const arrTarget: unknown[] = [1];
    const revokedArr = Proxy.revocable(arrTarget, {});
    revokedArr.revoke();
    try {
      cloneJsonSafe(revokedArr.proxy);
      expect.unreachable("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(VisibleBranchExportError);
      expect((error as Error).message).toBe(VISIBLE_BRANCH_EXPORT_ERROR);
    }
  });
});

describe("buildVisibleBranchDocument whitelist + order", () => {
  it("emits frozen envelope and preserves entry order + entryId/parentEntryId", () => {
    const document = buildVisibleBranchDocument(
      ctx(
        [
          {
            entryId: "e1",
            message: { role: "user", content: "hi", timestamp: 10 },
          },
          {
            entryId: "e2",
            parentEntryId: "e1",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "yo" }],
              model: "m",
              provider: "p",
              timestamp: 20,
            },
          },
        ],
        { sessionId: "s-order", leafId: "leaf-9" },
      ),
      { exportedAt: EXPORTED_AT },
    );

    expect(document).toMatchObject({
      format: VISIBLE_BRANCH_FORMAT,
      version: VISIBLE_BRANCH_VERSION,
      scope: VISIBLE_BRANCH_SCOPE,
      disclaimer: VISIBLE_BRANCH_DISCLAIMER,
      exportedAt: EXPORTED_AT,
      sessionId: "s-order",
      leafId: "leaf-9",
    });
    expect(document.entries.map((e) => e.entryId)).toEqual(["e1", "e2"]);
    expect(document.entries[1]).toMatchObject({ parentEntryId: "e1", timestamp: 20 });
  });

  it("normalizes user string content to a text block and omits image data/url", () => {
    const document = buildVisibleBranchDocument(
      ctx([
        {
          entryId: "u1",
          message: {
            role: "user",
            content: [
              { type: "text", text: "look" },
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
              },
              {
                type: "image",
                source: { type: "url", url: "https://evil.example/secret.png", media_type: "image/jpeg" },
              },
            ],
            timestamp: 1,
          },
        },
        {
          entryId: "u2",
          message: { role: "user", content: "plain string" },
        },
      ]),
      { exportedAt: EXPORTED_AT },
    );

    expect(document.entries[0]).toEqual({
      entryId: "u1",
      role: "user",
      timestamp: 1,
      content: [
        { type: "text", text: "look" },
        { type: "image", omitted: true, sourceType: "base64", mediaType: "image/png" },
        { type: "image", omitted: true, sourceType: "url", mediaType: "image/jpeg" },
      ],
    });
    expect(JSON.stringify(document)).not.toContain("iVBORw0KGgo");
    expect(JSON.stringify(document)).not.toContain("evil.example");
    expect(document.entries[1]).toEqual({
      entryId: "u2",
      role: "user",
      content: [{ type: "text", text: "plain string" }],
    });
  });

  it("projects assistant with model/provider/stop/error; keeps text/thinking unmerged; maps toolCall; drops usage/writtenFiles", () => {
    const document = buildVisibleBranchDocument(
      ctx([
        {
          entryId: "a1",
          message: {
            role: "assistant",
            model: "gpt",
            provider: "openai",
            stopReason: "end",
            errorMessage: "oops",
            usage: {
              input: 1,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            writtenFiles: ["/secret/path.ts"],
            content: [
              { type: "text", text: "a" },
              { type: "text", text: "b" },
              { type: "thinking", thinking: "" },
              { type: "thinking", thinking: "t1" },
              { type: "thinking", thinking: "t2" },
              {
                type: "toolCall",
                toolCallId: "tc1",
                toolName: "read",
                input: { path: "/tmp/x" },
              },
              {
                type: "image",
                source: { type: "base64", media_type: "image/webp", data: "AAAA" },
              },
            ],
            timestamp: 99,
          },
        },
      ]),
      { exportedAt: EXPORTED_AT },
    );

    const entry = document.entries[0]!;
    expect(entry).toEqual({
      entryId: "a1",
      role: "assistant",
      model: "gpt",
      provider: "openai",
      stopReason: "end",
      errorMessage: "oops",
      timestamp: 99,
      content: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
        { type: "thinking", thinking: "" },
        { type: "thinking", thinking: "t1" },
        { type: "thinking", thinking: "t2" },
        { type: "toolCall", id: "tc1", name: "read", input: { path: "/tmp/x" } },
        { type: "image", omitted: true, sourceType: "base64", mediaType: "image/webp" },
      ],
    });
    expect(JSON.stringify(entry)).not.toContain("usage");
    expect(JSON.stringify(entry)).not.toContain("writtenFiles");
    expect(JSON.stringify(entry)).not.toContain("/secret/path.ts");
    expect(JSON.stringify(entry)).not.toContain("AAAA");
  });

  it("projects toolResult with id/name/isError; drops details; placeholders images", () => {
    const document = buildVisibleBranchDocument(
      ctx([
        {
          entryId: "tr1",
          message: {
            role: "toolResult",
            toolCallId: "tc1",
            toolName: "read",
            isError: false,
            details: { stack: "raw-stack", path: "/hidden" },
            content: [
              { type: "text", text: "ok" },
              {
                type: "image",
                source: { type: "url", url: "https://img.example/a.png" },
              },
            ],
            timestamp: 3,
          },
        },
      ]),
      { exportedAt: EXPORTED_AT },
    );
    expect(document.entries[0]).toEqual({
      entryId: "tr1",
      role: "toolResult",
      id: "tc1",
      name: "read",
      isError: false,
      timestamp: 3,
      content: [
        { type: "text", text: "ok" },
        { type: "image", omitted: true, sourceType: "url" },
      ],
    });
    expect(JSON.stringify(document)).not.toContain("raw-stack");
    expect(JSON.stringify(document)).not.toContain("/hidden");
    expect(JSON.stringify(document)).not.toContain("img.example");
  });

  it("keeps custom display:false and drops details", () => {
    const document = buildVisibleBranchDocument(
      ctx([
        {
          entryId: "c1",
          message: {
            role: "custom",
            customType: "note",
            display: false,
            details: { internal: true },
            content: "hidden-ish",
            timestamp: 4,
          },
        },
      ]),
      { exportedAt: EXPORTED_AT },
    );
    expect(document.entries[0]).toEqual({
      entryId: "c1",
      role: "custom",
      customType: "note",
      display: false,
      timestamp: 4,
      content: [{ type: "text", text: "hidden-ish" }],
    });
    expect(JSON.stringify(document)).not.toContain("internal");
  });

  it("projects bash with exit 0 / empty output; excludes fullOutputPath; no UI (no output) sentinel", () => {
    const document = buildVisibleBranchDocument(
      ctx([
        {
          entryId: "b1",
          message: {
            role: "bashExecution",
            command: "true",
            output: "",
            exitCode: 0,
            cancelled: false,
            truncated: false,
            excludeFromContext: true,
            fullOutputPath: "/tmp/secret-full-output.log",
            timestamp: 5,
          },
        },
      ]),
      { exportedAt: EXPORTED_AT },
    );
    expect(document.entries[0]).toEqual({
      entryId: "b1",
      role: "bashExecution",
      command: "true",
      output: "",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      excludeFromContext: true,
      timestamp: 5,
    });
    expect(document.entries[0]!.role).toBe("bashExecution");
    const json = JSON.stringify(document);
    expect(json).toContain('"role":"bashExecution"');
    // Canonical v1 role must not collapse to the UI-only "bash" label.
    expect(json).not.toContain('"role":"bash"');
    expect(json).not.toContain("fullOutputPath");
    expect(json).not.toContain("/tmp/secret-full-output.log");
    expect(json).not.toContain("(no output)");
  });

  it("fails the whole export when toolCall.input is not JSON-safe", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      buildVisibleBranchDocument(
        ctx([
          {
            entryId: "bad",
            message: {
              role: "assistant",
              model: "m",
              provider: "p",
              content: [
                {
                  type: "toolCall",
                  toolCallId: "tc",
                  toolName: "x",
                  input: circular,
                },
              ],
            },
          },
        ]),
      ),
    ).toThrow(VISIBLE_BRANCH_EXPORT_ERROR);

    expect(() =>
      buildVisibleBranchDocument(
        ctx([
          {
            entryId: "bad2",
            message: {
              role: "assistant",
              model: "m",
              provider: "p",
              content: [
                {
                  type: "toolCall",
                  toolCallId: "tc",
                  toolName: "x",
                  input: { n: Number.NaN },
                },
              ],
            },
          },
        ]),
      ),
    ).toThrow(VisibleBranchExportError);
  });
});

describe("serializeVisibleBranchDocument HTML-safe roundtrip", () => {
  it("pretty-prints with trailing newline and escapes & < > U+2028 U+2029", () => {
    const document = buildVisibleBranchDocument(
      ctx([
        {
          entryId: "e",
          message: {
            role: "user",
            content: `a&b<c>d\u2028e\u2029f`,
          },
        },
      ]),
      { exportedAt: EXPORTED_AT },
    );
    const text = serializeVisibleBranchDocument(document);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain("\\u0026");
    expect(text).toContain("\\u003c");
    expect(text).toContain("\\u003e");
    expect(text).toContain("\\u2028");
    expect(text).toContain("\\u2029");
    expect(text).not.toMatch(/a&b/);
    expect(text).not.toMatch(/<c>/);

    const parsed = JSON.parse(text) as typeof document;
    expect(parsed.entries[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: `a&b<c>d\u2028e\u2029f` }],
    });
    expect(parsed.format).toBe(VISIBLE_BRANCH_FORMAT);
  });
});

describe("downloadVisibleBranch Blob lifecycle", () => {
  it("builds then downloads with correct MIME, hidden anchor, delayed revoke, and cleanup that swallows errors", () => {
    const createObjectURL = vi.fn(() => "blob:test-url");
    const revokeObjectURL = vi.fn();
    const appendChild = vi.fn();
    const removeChild = vi.fn(() => {
      throw new Error("remove-failed");
    });
    const click = vi.fn();
    const setTimeout = vi.fn((fn: () => void) => {
      fn();
      return 0;
    });
    const createElement = vi.fn(() => {
      const el = {
        href: "",
        download: "",
        style: { display: "" },
        setAttribute: vi.fn(),
        click,
      };
      return el as unknown as HTMLAnchorElement;
    });
    const BlobCtor = vi.fn(function BlobMock(this: unknown, parts: BlobPart[], opts?: BlobPropertyBag) {
      return { parts, opts };
    }) as unknown as typeof Blob;

    const context = ctx(
      [{ entryId: "e1", message: { role: "user", content: "hi" } }],
      { sessionId: "dl-sess" },
    );

    const result = downloadVisibleBranch(context, {
      exportedAt: EXPORTED_AT,
      deps: {
        createObjectURL,
        revokeObjectURL,
        appendChild,
        removeChild,
        createElement,
        setTimeout,
        Blob: BlobCtor,
      },
    });

    expect(result.filename).toBe("pix-visible-branch-dl-sess.json");
    expect(BlobCtor).toHaveBeenCalledWith([result.bytes], {
      type: "application/json;charset=utf-8",
    });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(appendChild).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    const anchor = createElement.mock.results[0]!.value as HTMLAnchorElement;
    expect(anchor.download).toBe("pix-visible-branch-dl-sess.json");
    expect(anchor.style.display).toBe("none");
    expect(removeChild).toHaveBeenCalledTimes(1);
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 0);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test-url");
    // removeChild threw but download still succeeded (cleanup swallows).
    expect(result.bytes.length).toBeGreaterThan(0);
  });

  it("maps download construction failures to the fixed UI error", () => {
    const context = ctx([{ entryId: "e1", message: { role: "user", content: "hi" } }]);
    expect(() =>
      downloadVisibleBranch(context, {
        deps: {
          createObjectURL: () => {
            throw new Error("boom-raw");
          },
          revokeObjectURL: () => undefined,
          appendChild: () => undefined,
          removeChild: () => undefined,
          createElement: () => document.createElement("a"),
          setTimeout: (fn) => {
            fn();
            return 0;
          },
          Blob,
        },
      }),
    ).toThrow(VISIBLE_BRANCH_EXPORT_ERROR);
  });

  it("swallows setTimeout schedule failures so they never cover a successful export", () => {
    const createObjectURL = vi.fn(() => "blob:sched");
    const revokeObjectURL = vi.fn();
    const removeChild = vi.fn();
    const click = vi.fn();
    const setTimeout = vi.fn(() => {
      throw new Error("schedule-raw-SECRET");
    });
    const createElement = vi.fn(() => {
      const el = {
        href: "",
        download: "",
        style: { display: "" },
        setAttribute: vi.fn(),
        click,
      };
      return el as unknown as HTMLAnchorElement;
    });

    const context = ctx(
      [{ entryId: "e1", message: { role: "user", content: "hi" } }],
      { sessionId: "sched-sess" },
    );

    const result = downloadVisibleBranch(context, {
      exportedAt: EXPORTED_AT,
      deps: {
        createObjectURL,
        revokeObjectURL,
        appendChild: vi.fn(),
        removeChild,
        createElement,
        setTimeout,
        Blob,
      },
    });

    expect(result.filename).toBe("pix-visible-branch-sched-sess.json");
    expect(result.bytes.length).toBeGreaterThan(0);
    expect(removeChild).toHaveBeenCalledTimes(1);
    expect(setTimeout).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("still removes the anchor and attempts revoke schedule when click/append throw", () => {
    const createObjectURL = vi.fn(() => "blob:click-fail");
    const revokeObjectURL = vi.fn();
    const removeChild = vi.fn();
    const setTimeout = vi.fn((fn: () => void) => {
      fn();
      return 0;
    });
    const createElement = vi.fn(() => {
      const el = {
        href: "",
        download: "",
        style: { display: "" },
        setAttribute: vi.fn(),
        click: () => {
          throw new Error("click-raw-SECRET");
        },
      };
      return el as unknown as HTMLAnchorElement;
    });

    const context = ctx([{ entryId: "e1", message: { role: "user", content: "hi" } }]);

    expect(() =>
      downloadVisibleBranch(context, {
        deps: {
          createObjectURL,
          revokeObjectURL,
          appendChild: vi.fn(),
          removeChild,
          createElement,
          setTimeout,
          Blob,
        },
      }),
    ).toThrow(VISIBLE_BRANCH_EXPORT_ERROR);

    expect(removeChild).toHaveBeenCalledTimes(1);
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 0);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:click-fail");
  });

  it("does not schedule revoke when createObjectURL fails before a URL exists", () => {
    const revokeObjectURL = vi.fn();
    const removeChild = vi.fn();
    const setTimeout = vi.fn((fn: () => void) => {
      fn();
      return 0;
    });

    const context = ctx([{ entryId: "e1", message: { role: "user", content: "hi" } }]);

    expect(() =>
      downloadVisibleBranch(context, {
        deps: {
          createObjectURL: () => {
            throw new Error("url-raw-SECRET");
          },
          revokeObjectURL,
          appendChild: vi.fn(),
          removeChild,
          createElement: () => document.createElement("a"),
          setTimeout,
          Blob,
        },
      }),
    ).toThrow(VISIBLE_BRANCH_EXPORT_ERROR);

    expect(setTimeout).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(removeChild).not.toHaveBeenCalled();
  });
});
