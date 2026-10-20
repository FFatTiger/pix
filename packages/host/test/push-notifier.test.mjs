import assert from "node:assert/strict";
import test from "node:test";
import {
  PushNotifier,
  decideNotifications,
  classifyEndedTurn,
  hashPushEndpoint,
  notificationUrl,
  pickPushCopy,
  scanLastAssistant,
  sendTestNotification,
  sessionDisplayName,
  toRunningSets,
  createVisibilityTracker,
} from "../dist/index.js";

const wait = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
const KEYS = { publicKey: "B".repeat(87), privateKey: "A".repeat(43) };

/** The notifier serializes candidates through an internal promise chain; tests await this to observe settled state deterministically. */
async function queueIdle() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 5));
}

// ---------------------------------------------------------------------------
// pure decision
// ---------------------------------------------------------------------------

const sets = (running, waiting = []) => ({
  running: new Set(running),
  waiting: new Set(waiting),
});

test("decision: baseline only — the first state after (re)connect never notifies", () => {
  assert.deepEqual(decideNotifications(undefined, sets(["a"])), []);
});

test("decision: entering waiting notifies; leaving waiting does not", () => {
  const prev = sets(["a"], []);
  const next = sets(["a"], ["a"]);
  assert.deepEqual(decideNotifications(prev, next), [{ sessionId: "a", kind: "waiting" }]);
  assert.deepEqual(decideNotifications(next, prev), []);
});

test("decision: leaving running (not waiting) notifies ended; still-running does not", () => {
  const prev = sets(["a", "b"]);
  assert.deepEqual(decideNotifications(prev, sets(["a"])), [{ sessionId: "b", kind: "ended" }]);
  assert.deepEqual(decideNotifications(prev, sets(["a", "b"])), []);
});

test("decision: a session leaving BOTH running and waiting in one push is one ended candidate; waiting-known sessions never produce ended", () => {
  // waiting is always a subset of running on the wire; the meaningful
  // boundary is a waiting session that disappears entirely (answered+
  // finished between two pushes) — exactly ONE ended notification.
  const prev = sets(["a"], ["a"]);
  assert.deepEqual(decideNotifications(prev, sets([])), [{ sessionId: "a", kind: "ended" }]);
  // still running, no longer waiting: nothing (turn continues)
  assert.deepEqual(decideNotifications(prev, sets(["a"])), []);
});

test("classifyEndedTurn: error / aborted / done", () => {
  assert.equal(classifyEndedTurn("error"), "error");
  assert.equal(classifyEndedTurn("aborted"), "aborted");
  assert.equal(classifyEndedTurn("end_turn"), "done");
  assert.equal(classifyEndedTurn(undefined), "done");
});

test("sessionDisplayName: title wins; marker line stripped from firstMessage; bounded to 60", () => {
  assert.equal(sessionDisplayName({ title: "t" }, "x"), "t");
  const marker = "[Pixie 代用户发送]";
  assert.equal(sessionDisplayName({ firstMessage: `${marker}帮我修 bug` }, "x"), "帮我修 bug");
  const long = "字".repeat(100);
  const named = sessionDisplayName({ firstMessage: long }, "x");
  assert.equal(named.length, 60);
  assert.ok(named.endsWith("…"));
  assert.equal(sessionDisplayName(undefined, "会话"), "会话");
});

test("notificationUrl: assistant deep link vs session+cwd with encoded cwd", () => {
  assert.equal(notificationUrl("s1", "/work/dir", true), "/?assistant=1");
  assert.equal(notificationUrl("s1", "/work/dir", false), "/?session=s1&cwd=%2Fwork%2Fdir");
  assert.equal(notificationUrl("s1", undefined, false), "/?session=s1");
});

test("scanLastAssistant: classification stopReason from the final assistant entry; preview from the last text-bearing entry", () => {
  const entry = (message) => ({ entryId: "e", message });
  const entries = [
    entry({ role: "user", content: "hi" }),
    entry({ role: "assistant", content: [{ type: "text", text: "第一段回复" }], model: "m", provider: "p", stopReason: "end_turn" }),
    entry({ role: "assistant", content: [{ type: "toolCall", toolCallId: "t", toolName: "bash", input: {} }], model: "m", provider: "p", stopReason: undefined }),
    entry({ role: "assistant", content: [{ type: "text", text: "  最终  答案  " }], model: "m", provider: "p", stopReason: "error", errorMessage: "boom" }),
  ];
  const scan = scanLastAssistant(entries);
  assert.equal(scan.stopReason, "error");
  assert.equal(scan.preview, "最终 答案");
  assert.equal(scanLastAssistant([{ entryId: "e", message: { role: "user", content: "x" } }]), undefined);
});

// ---------------------------------------------------------------------------
// notifier over injected fakes (clock, watch, sessions, store, sender)
// ---------------------------------------------------------------------------

class FakeWatch {
  constructor(baseline) {
    this.baseline = baseline;
    this.onPush = null;
    this.subscriptions = [];
    this.failOpen = false;
    this.closeCount = 0;
  }
  async watchRunning(onPush) {
    if (this.failOpen) throw new Error("sessiond down");
    let closedResolve;
    const closed = new Promise((resolve) => {
      closedResolve = resolve;
    });
    const watch = {
      response: this.baseline,
      close: () => {
        this.closeCount += 1;
        closedResolve();
      },
      closed,
    };
    this.onPush = onPush;
    this.subscriptions.push(watch);
    return watch;
  }
  deliver(state) {
    return this.onPush({ type: "running_state", state });
  }
}

class FakeSessions {
  constructor() {
    this.headers = new Map();
    this.contexts = new Map();
    this.readCalls = [];
    this.failRead = false;
  }
  async read(sessionId) {
    this.readCalls.push(sessionId);
    if (this.failRead) throw new Error("catalog down");
    const header = this.headers.get(sessionId);
    if (header === undefined) throw Object.assign(new Error("not found"), { code: "not_found" });
    return header;
  }
  async context(sessionId) {
    const context = this.contexts.get(sessionId);
    if (context === undefined) throw Object.assign(new Error("not found"), { code: "not_found" });
    return context;
  }
}

class FakeStore {
  constructor() {
    this.document = { kind: "pix.host.web-push", version: 1, vapid: KEYS, subscriptions: [] };
    this.removed = [];
  }
  async read() {
    return this.document;
  }
  async getOrCreateVapidKeys(generate) {
    if (this.document.vapid === undefined) this.document.vapid = generate();
    return this.document.vapid;
  }
  async upsertSubscription() {}
  async removeSubscription(endpoint) {
    this.removed.push(endpoint);
  }
}

class FakeSender {
  constructor() {
    this.sent = [];
    this.failFor = new Map();
  }
  generateVapidKeys() {
    return KEYS;
  }
  async send(subscription, keys, payload) {
    const outcome = this.failFor.get(subscription.endpoint);
    if (outcome !== undefined) {
      if (outcome === "gone") return "gone";
      throw new Error("network down");
    }
    this.sent.push({ endpoint: subscription.endpoint, keys, payload });
    return "delivered";
  }
}

function state({ revision, running = [], waiting = [], assistant }) {
  return {
    revision,
    sessionIds: [...running],
    busySessionIds: [],
    ...(waiting.length === 0 ? {} : { waitingSessionIds: [...waiting] }),
    ...(assistant === undefined ? {} : { assistant }),
  };
}

function makeHarness(options = {}) {
  const clock = { now: 1_000_000 };
  const timers = [];
  const watch = new FakeWatch(state({ revision: 0 }));
  const sessions = new FakeSessions();
  const store = new FakeStore();
  const sender = new FakeSender();
  const visibility = createVisibilityTracker();
  const notifier = new PushNotifier({
    watch,
    sessions,
    store,
    sender,
    visibility,
    locale: options.locale ?? (() => "zh-CN"),
    now: () => clock.now,
    setTimeoutFn: (fn, ms) => {
      const handle = { fn, ms };
      timers.push(handle);
      return handle;
    },
    clearTimeoutFn: (handle) => {
      const index = timers.indexOf(handle);
      if (index >= 0) timers.splice(index, 1);
    },
    ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
  });
  return { notifier, watch, sessions, store, sender, visibility, clock, timers, queueIdle: () => queueIdle() };
}

const SUB_A = { endpoint: "https://push.example/a", p256dh: "K".repeat(87), auth: "a".repeat(16), createdAt: "2020-01-01T00:00:00.000Z" };
const SUB_B = { endpoint: "https://web.push.apple.com/v2/devices/b", p256dh: "K".repeat(87), auth: "b".repeat(16), createdAt: "2020-01-01T00:00:00.000Z" };

// Same digest the Host matches against (lowercase SHA-256 hex of the endpoint).
const endpointHash = hashPushEndpoint;

test("hashPushEndpoint matches the canonical client digest vector (per-device suppression parity)", () => {
  assert.equal(hashPushEndpoint("https://fcm.googleapis.com/fcm/send/abc"), "4e9bdab8bbe7189c00aebb0922fc49fe40e00594c400f3e1b5dcf97a35c79f85");
  assert.equal(hashPushEndpoint("https://web.push.apple.com/v2/devices/xyz"), "8eb424fc52dc2c9e8392f25256694ed9c24a5569c9aca50ac98e918ff58c60aa");
});

test("notifier: waiting transition sends 等你回答 with the session name", async () => {
  const h = makeHarness();
  h.store.document.subscriptions.push(SUB_A);
  h.notifier.start();
  await wait();
  h.sessions.headers.set("s1", { sessionId: "s1", cwd: "/w", projectRoot: "/w", title: "修复构建" });
  await h.watch.deliver(state({ revision: 1, running: ["s1"], waiting: ["s1"] }));
  await h.queueIdle();
  assert.equal(h.sender.sent.length, 1);
  assert.equal(h.sender.sent[0].payload.title, "等你回答");
  assert.equal(h.sender.sent[0].payload.body, "修复构建");
  assert.equal(h.sender.sent[0].payload.url, "/?session=s1&cwd=%2Fw");
  assert.equal(h.sender.sent[0].payload.tag, "s1");
  h.notifier.stop();
});

test("notifier: normal completion sends 已完成 + 80-char preview; error stopReason sends 出错了; aborted sends nothing", async () => {
  const h = makeHarness();
  h.store.document.subscriptions.push(SUB_A);
  h.notifier.start();
  await wait();
  h.sessions.headers.set("s1", { sessionId: "s1", cwd: "/w", projectRoot: "/w", firstMessage: "[Pixie 代用户发送]帮我修 bug" });
  h.sessions.contexts.set("s1", {
    sessionId: "s1",
    entries: [
      { entryId: "1", message: { role: "user", content: "x" } },
      { entryId: "2", message: { role: "assistant", content: [{ type: "text", text: "修好了" }], model: "m", provider: "p", stopReason: "end_turn" } },
    ],
    pageInfo: { hasMore: false },
  });
  await h.watch.deliver(state({ revision: 1, running: ["s1"] }));
  await h.queueIdle();
  await h.watch.deliver(state({ revision: 2, running: [] }));
  await h.queueIdle();
  assert.equal(h.sender.sent.length, 1);
  assert.equal(h.sender.sent[0].payload.title, "已完成");
  assert.equal(h.sender.sent[0].payload.body, "帮我修 bug：修好了");

  // error
  clockAdvance(h, 60_000);
  await h.watch.deliver(state({ revision: 3, running: ["s1"] }));
  await h.queueIdle();
  h.sessions.contexts.set("s1", {
    sessionId: "s1",
    entries: [
      { entryId: "3", message: { role: "assistant", content: [{ type: "text", text: "boom" }], model: "m", provider: "p", stopReason: "error", errorMessage: "boom" } },
    ],
    pageInfo: { hasMore: false },
  });
  await h.watch.deliver(state({ revision: 4, running: [] }));
  await h.queueIdle();
  assert.equal(h.sender.sent.length, 2);
  assert.equal(h.sender.sent[1].payload.title, "出错了");
  assert.equal(h.sender.sent[1].payload.body, "帮我修 bug");

  // aborted: nothing
  clockAdvance(h, 60_000);
  await h.watch.deliver(state({ revision: 5, running: ["s1"] }));
  await h.queueIdle();
  h.sessions.contexts.set("s1", {
    sessionId: "s1",
    entries: [
      { entryId: "4", message: { role: "assistant", content: [{ type: "text", text: "停了" }], model: "m", provider: "p", stopReason: "aborted" } },
    ],
    pageInfo: { hasMore: false },
  });
  await h.watch.deliver(state({ revision: 6, running: [] }));
  await h.queueIdle();
  assert.equal(h.sender.sent.length, 2);
  h.notifier.stop();
});

function clockAdvance(h, ms) {
  h.clock.now += ms;
}

test("notifier: baseline after start and after watch reconnect never notifies", async () => {
  const h = makeHarness();
  h.store.document.subscriptions.push(SUB_A);
  h.notifier.start();
  await wait();
  // baseline says s1 already running — finishing it must not notify from THIS
  // state until it runs again first.
  await h.watch.deliver(state({ revision: 1, running: ["s1"] }));
  await h.queueIdle();
  assert.equal(h.sender.sent.length, 0);
  h.notifier.stop();
});

test("notifier: debounce suppresses the same session+kind within the window; different kinds pass", async () => {
  const h = makeHarness({ debounceMs: 10_000 });
  h.store.document.subscriptions.push(SUB_A);
  h.notifier.start();
  await wait();
  h.sessions.headers.set("s1", { sessionId: "s1", cwd: "/w", projectRoot: "/w", title: "T" });
  // wait → ended within 2s: both fire (different kinds)
  await h.watch.deliver(state({ revision: 1, running: ["s1"], waiting: ["s1"] }));
  await h.queueIdle();
  await h.watch.deliver(state({ revision: 2, running: [], waiting: [] }));
  await h.queueIdle();
  assert.equal(h.sender.sent.length, 2);
  // same transition again 1s later: suppressed by debounce
  clockAdvance(h, 1_000);
  await h.watch.deliver(state({ revision: 3, running: ["s1"], waiting: ["s1"] }));
  await h.queueIdle();
  await h.watch.deliver(state({ revision: 4, running: [] }));
  await h.queueIdle();
  assert.equal(h.sender.sent.length, 2);
  // after the window both fire again
  clockAdvance(h, 60_000);
  await h.watch.deliver(state({ revision: 5, running: ["s1"], waiting: ["s1"] }));
  await h.queueIdle();
  await h.watch.deliver(state({ revision: 6, running: [] }));
  await h.queueIdle();
  assert.equal(h.sender.sent.length, 4);
  h.notifier.stop();
});

test("notifier: an attended device is skipped, the other device still receives", async () => {
  const h = makeHarness();
  h.store.document.subscriptions.push(SUB_A, SUB_B);
  // The desktop browser holding SUB_A is being looked at (visible + focused).
  const registration = h.visibility.register();
  registration.report({ visible: true, attended: true, pushEndpointHash: endpointHash(SUB_A.endpoint) });
  h.notifier.start();
  await wait();
  h.sessions.headers.set("s1", { sessionId: "s1", cwd: "/w", projectRoot: "/w", title: "T" });
  await h.watch.deliver(state({ revision: 1, running: ["s1"], waiting: ["s1"] }));
  await h.queueIdle();
  assert.equal(h.sender.sent.length, 1);
  assert.equal(h.sender.sent[0].endpoint, SUB_B.endpoint);
  // The attended device stops being looked at (blur / hidden) → it receives again.
  registration.report({ visible: true, attended: false, pushEndpointHash: endpointHash(SUB_A.endpoint) });
  clockAdvance(h, 60_000);
  await h.watch.deliver(state({ revision: 2, running: ["s1"] }));
  await h.queueIdle();
  await h.watch.deliver(state({ revision: 3, running: [], waiting: [] }));
  await h.queueIdle();
  assert.equal(h.sender.sent.length, 3); // A and B both received the ended turn
  h.notifier.stop();
});

test("notifier: every device attended → nothing is sent; disconnect (unregister) restores sending", async () => {
  const h = makeHarness();
  h.store.document.subscriptions.push(SUB_A, SUB_B);
  const regA = h.visibility.register();
  const regB = h.visibility.register();
  regA.report({ visible: true, attended: true, pushEndpointHash: endpointHash(SUB_A.endpoint) });
  regB.report({ visible: true, attended: true, pushEndpointHash: endpointHash(SUB_B.endpoint) });
  h.notifier.start();
  await wait();
  h.sessions.headers.set("s1", { sessionId: "s1", cwd: "/w", projectRoot: "/w", title: "T" });
  await h.watch.deliver(state({ revision: 1, running: ["s1"], waiting: ["s1"] }));
  await h.queueIdle();
  assert.equal(h.sender.sent.length, 0);
  // A connection dies → its endpoint is no longer suppressed
  regA.unregister();
  await h.watch.deliver(state({ revision: 2, running: [], waiting: [] }));
  await h.queueIdle();
  assert.equal(h.sender.sent.length, 1);
  assert.equal(h.sender.sent[0].endpoint, SUB_A.endpoint);
  h.notifier.stop();
});

test("notifier: legacy boolean reports and attended clients without a push mapping suppress nothing", async () => {
  const h = makeHarness();
  h.store.document.subscriptions.push(SUB_A, SUB_B);
  // Old client shape (visible only, no attended/hash) …
  const legacy = h.visibility.register();
  legacy.report({ visible: true });
  // … and an attended page with no push subscription (e.g. desktop browser
  // without notifications, headless verification browser): no endpoint hash,
  // so it cannot map to any subscription.
  const unattendedDevice = h.visibility.register();
  unattendedDevice.report({ visible: true, attended: true });
  h.notifier.start();
  await wait();
  h.sessions.headers.set("s1", { sessionId: "s1", cwd: "/w", projectRoot: "/w", title: "T" });
  await h.watch.deliver(state({ revision: 1, running: ["s1"], waiting: ["s1"] }));
  await h.queueIdle();
  assert.equal(h.sender.sent.length, 2); // every device still receives
  h.notifier.stop();
});

test("notifier: a report that is not visible never suppresses (fail-safe against contradictory frames)", async () => {
  const h = makeHarness();
  h.store.document.subscriptions.push(SUB_A);
  const registration = h.visibility.register();
  registration.report({ visible: false, attended: true, pushEndpointHash: endpointHash(SUB_A.endpoint) });
  h.notifier.start();
  await wait();
  h.sessions.headers.set("s1", { sessionId: "s1", cwd: "/w", projectRoot: "/w", title: "T" });
  await h.watch.deliver(state({ revision: 1, running: ["s1"], waiting: ["s1"] }));
  await h.queueIdle();
  assert.equal(h.sender.sent.length, 1); // contradiction → not attended
  h.notifier.stop();
});

test("notifier: failed session reads degrade to generic copy (no fabricated name/preview)", async () => {
  const h = makeHarness();
  h.store.document.subscriptions.push(SUB_A);
  h.notifier.start();
  await wait();
  h.sessions.failRead = true;
  await h.watch.deliver(state({ revision: 1, running: ["s1"], waiting: ["s1"] }));
  await h.queueIdle();
  assert.equal(h.sender.sent.length, 1);
  assert.equal(h.sender.sent[0].payload.title, "等你回答");
  assert.equal(h.sender.sent[0].payload.body, "会话");
  assert.equal(h.sender.sent[0].payload.url, "/?session=s1");
  h.notifier.stop();
});

test("notifier: no subscriptions (or no keys) means no sends and no session reads", async () => {
  const h = makeHarness();
  h.notifier.start();
  await wait();
  await h.watch.deliver(state({ revision: 1, running: ["s1"], waiting: ["s1"] }));
  await h.queueIdle();
  assert.equal(h.sender.sent.length, 0);
  assert.equal(h.sessions.readCalls.length, 0);
  h.notifier.stop();
});

test("notifier: assistant session is named Pixie and deep-links to /?assistant=1", async () => {
  const h = makeHarness();
  h.store.document.subscriptions.push(SUB_A);
  h.notifier.start();
  await wait();
  h.sessions.headers.set("pixie-1", { sessionId: "pixie-1", cwd: "/w", projectRoot: "/w", firstMessage: "hi" });
  await h.watch.deliver(state({ revision: 1, running: ["pixie-1"], waiting: ["pixie-1"], assistant: { sessionId: "pixie-1", status: "online" } }));
  await h.queueIdle();
  assert.equal(h.sender.sent.length, 1);
  assert.equal(h.sender.sent[0].payload.body, "Pixie");
  assert.equal(h.sender.sent[0].payload.url, "/?assistant=1");
  h.notifier.stop();
});

test("notifier: 404/410 prunes the subscription; other send failures are logged once, no retry", async () => {
  const h = makeHarness();
  const subGone = { ...SUB_A, endpoint: "https://push.example/gone" };
  const subFail = { ...SUB_A, endpoint: "https://push.example/fail" };
  h.store.document.subscriptions.push(SUB_A, subGone, subFail);
  h.sender.failFor.set(subGone.endpoint, "gone");
  h.sender.failFor.set(subFail.endpoint, "throw");
  h.notifier.start();
  await wait();
  h.sessions.headers.set("s1", { sessionId: "s1", cwd: "/w", projectRoot: "/w", title: "T" });
  await h.watch.deliver(state({ revision: 1, running: ["s1"], waiting: ["s1"] }));
  await h.queueIdle();
  assert.equal(h.sender.sent.length, 1); // only the healthy endpoint
  assert.deepEqual(h.store.removed, [subGone.endpoint]);
  assert.equal(h.store.document.subscriptions.includes(subGone), true); // fake store does not mutate
  h.notifier.stop();
});

test("notifier: watch loss schedules a bounded reconnect; sessions that finished while disconnected never notify", async () => {
  const h = makeHarness();
  h.store.document.subscriptions.push(SUB_A);
  h.notifier.start();
  await wait();
  h.sessions.headers.set("s1", { sessionId: "s1", cwd: "/w", projectRoot: "/w", title: "T" });
  // pre-disconnect: s1 running (known state)
  await h.watch.deliver(state({ revision: 1, running: ["s1"] }));
  await h.queueIdle();
  const first = h.watch.subscriptions[0];
  first.close(); // sessiond lost; s1 finishes while disconnected
  await wait();
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, 5_000);
  h.timers[0].fn(); // retry fires; the fresh watch response (empty) is the new silent baseline
  await wait();
  assert.equal(h.watch.subscriptions.length, 2);
  // the post-reconnect push (s1 gone) transitions empty→empty: NO notification
  await h.watch.deliver(state({ revision: 10 }));
  await h.queueIdle();
  assert.equal(h.sender.sent.length, 0);
  // a NEW run that finishes after the reconnect notifies normally
  await h.watch.deliver(state({ revision: 11, running: ["s1"] }));
  await h.queueIdle();
  await h.watch.deliver(state({ revision: 12 }));
  await h.queueIdle();
  assert.equal(h.sender.sent.length, 1);
  h.notifier.stop();
});

test("notifier: sessions_changed pushes are ignored (state pushes only)", async () => {
  const h = makeHarness();
  h.notifier.start();
  await wait();
  await h.watch.onPush({ type: "sessions_changed" });
  await h.queueIdle();
  assert.equal(h.sender.sent.length, 0);
  h.notifier.stop();
});

test("sendTestNotification: sent / gone (prunes) / missing outcomes", async () => {
  const store = new FakeStore();
  const sender = new FakeSender();
  store.document.subscriptions.push(SUB_A);
  const deps = { store, sender, locale: () => "en" };
  assert.equal(await sendTestNotification(deps, SUB_A.endpoint), "sent");
  assert.equal(sender.sent[0].payload.title, "Test notification");
  sender.failFor.set(SUB_A.endpoint, "gone");
  assert.equal(await sendTestNotification(deps, SUB_A.endpoint), "gone");
  assert.deepEqual(store.removed, [SUB_A.endpoint]);
  assert.equal(await sendTestNotification(deps, "https://push.example/none"), "missing");
});

test("pickPushCopy: zh-CN and en tables", () => {
  assert.equal(pickPushCopy("zh-CN").waitingTitle, "等你回答");
  assert.equal(pickPushCopy("zh").doneTitle, "已完成");
  assert.equal(pickPushCopy("en").errorTitle, "Something went wrong");
  assert.equal(pickPushCopy("whatever").locale, "en");
});
