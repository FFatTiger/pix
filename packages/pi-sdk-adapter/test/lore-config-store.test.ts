import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectLoreConnection,
  saveLoreConnection,
  testLoreConnection,
} from "../src/internal/lore-config-store.js";

let loreHome: string;
let baseEnv: NodeJS.ProcessEnv;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(async () => {
  loreHome = await mkdtemp(join(tmpdir(), "pix-lore-config-"));
  baseEnv = { LORE_HOME: loreHome };
});

afterEach(async () => {
  await rm(loreHome, { recursive: true, force: true });
});

describe("detectLoreConnection", () => {
  it("no file and no env → not configured, source none", () => {
    const detected = detectLoreConnection(baseEnv);
    assert.equal(detected.configured, false);
    assert.equal(detected.baseUrl, null);
    assert.equal(detected.source, "none");
    assert.equal(detected.tokenConfigured, false);
  });

  it("config file wins over env (per-field precedence like the extension)", async () => {
    await writeFile(
      join(loreHome, "config.json"),
      `${JSON.stringify({ base_url: "https://core.example", api_token: "lm_file" }, null, 2)}\n`,
    );
    const detected = detectLoreConnection({ ...baseEnv, LORE_BASE_URL: "https://env.example", LORE_API_TOKEN: "lm_env" });
    assert.equal(detected.configured, true);
    assert.equal(detected.baseUrl, "https://core.example");
    assert.equal(detected.source, "config");
  });

  it("a token without a base URL is not configured; a base URL without a token is not configured", async () => {
    await writeFile(join(loreHome, "config.json"), `${JSON.stringify({ api_token: "lm_t" })}\n`);
    assert.equal(detectLoreConnection(baseEnv).configured, false);
    await writeFile(join(loreHome, "config.json"), `${JSON.stringify({ base_url: "https://core.example" })}\n`);
    assert.equal(detectLoreConnection(baseEnv).configured, false);
  });
});

describe("saveLoreConnection", () => {
  it("writes base_url + api_token with 0600 and preserves unknown sibling keys", async () => {
    await writeFile(
      join(loreHome, "config.json"),
      `${JSON.stringify({ base_url: "https://old.example", api_token: "lm_old", installed_version: "v1.3.21", docker_managed: false }, null, 2)}\n`,
    );
    const detected = await saveLoreConnection(
      { baseUrl: "https://api.loremem.com/", apiToken: "lm_new" },
      { env: baseEnv },
    );
    assert.equal(detected.configured, true);
    assert.equal(detected.baseUrl, "https://api.loremem.com");
    const raw = JSON.parse(await readFile(join(loreHome, "config.json"), "utf8")) as Record<string, unknown>;
    assert.equal(raw.base_url, "https://api.loremem.com");
    assert.equal(raw.api_token, "lm_new");
    assert.equal(raw.installed_version, "v1.3.21");
    assert.equal(raw.docker_managed, false);
    // NTFS reports no POSIX mode bits; the 0600 proof is POSIX-only.
    if (process.platform !== "win32") {
      const info = await stat(join(loreHome, "config.json"));
      assert.equal(info.mode & 0o077, 0, "config.json must be owner-only");
    }
  });

  it("omitting the token keeps it when the base URL is unchanged", async () => {
    await writeFile(
      join(loreHome, "config.json"),
      `${JSON.stringify({ base_url: "https://core.example/", api_token: "lm_old" }, null, 2)}\n`,
    );
    await saveLoreConnection({ baseUrl: "https://core.example" }, { env: baseEnv });
    const raw = JSON.parse(await readFile(join(loreHome, "config.json"), "utf8")) as Record<string, unknown>;
    assert.equal(raw.api_token, "lm_old");
  });

  it("changing the server without a token clears the old token (CLI semantics)", async () => {
    await writeFile(
      join(loreHome, "config.json"),
      `${JSON.stringify({ base_url: "https://old.example", api_token: "lm_old" }, null, 2)}\n`,
    );
    await saveLoreConnection({ baseUrl: "https://api.loremem.com" }, { env: baseEnv });
    const raw = JSON.parse(await readFile(join(loreHome, "config.json"), "utf8")) as Record<string, unknown>;
    assert.equal(raw.base_url, "https://api.loremem.com");
    assert.equal("api_token" in raw, false);
  });

  it("accepts plain http only for loopback / LAN / Tailscale / .local hosts", async () => {
    for (const baseUrl of [
      "http://127.0.0.1:18901",
      "http://localhost:18901",
      "http://[::1]:18901",
      "http://10.1.2.3:18901",
      "http://192.168.50.20:18901",
      "http://172.16.0.5:18901",
      "http://172.31.255.254:18901",
      "http://192.168.1.10:18901",
      "http://169.254.10.1:18901",
      "http://100.64.0.1:18901",
      "http://100.127.255.254:18901",
      "http://[fd7a:115c:a1e0::1]:18901",
      "http://[fe80::1]:18901",
      "http://nas.local:18901",
      "http://lore.tail1234.ts.net:18901",
    ]) {
      const saved = await saveLoreConnection({ baseUrl, apiToken: "lm_t" }, { env: baseEnv });
      assert.equal(saved.baseUrl, baseUrl, baseUrl);
    }
    for (const baseUrl of [
      "http://core.example",
      "http://8.8.8.8:18901",
      "http://172.32.0.1:18901",
      "http://100.128.0.1:18901",
      "http://192.169.0.1:18901",
      "http://[2001:db8::1]:18901",
      "http://[fd::1]:18901",
      "http://[::ffff:10.0.0.1]:18901",
      "http://nas.local.example.com:18901",
      "http://nas:18901",
    ]) {
      await assert.rejects(saveLoreConnection({ baseUrl, apiToken: "lm_t" }, { env: baseEnv }), /http/i, baseUrl);
    }
  });

  it("accepts an existing 0755 Lore directory (Lore's own mode) and keeps config.json 0600", async () => {
    await chmod(loreHome, 0o755);
    const detected = await saveLoreConnection(
      { baseUrl: "https://core.example", apiToken: "lm_t" },
      { env: baseEnv },
    );
    assert.equal(detected.configured, true);
    if (process.platform !== "win32") {
      const dirInfo = await stat(loreHome);
      assert.equal(dirInfo.mode & 0o777, 0o755, "an existing Lore directory is never chmodded by Pix");
      const fileInfo = await stat(join(loreHome, "config.json"));
      assert.equal(fileInfo.mode & 0o077, 0, "config.json stays owner-only");
    }
    // A follow-up save on the same 0755 directory still works.
    const again = await saveLoreConnection({ baseUrl: "https://other.example", apiToken: "lm_t2" }, { env: baseEnv });
    assert.equal(again.baseUrl, "https://other.example");
  });

  it("creates a missing Lore directory with 0700", async () => {
    const freshHome = join(loreHome, "nested", "lore");
    const detected = await saveLoreConnection(
      { baseUrl: "https://core.example", apiToken: "lm_t" },
      { env: { ...baseEnv, LORE_HOME: freshHome } },
    );
    assert.equal(detected.configured, true);
    if (process.platform !== "win32") {
      const dirInfo = await stat(freshHome);
      assert.equal(dirInfo.mode & 0o777, 0o700);
    }
  });

  it("rejects non-http(s) schemes and empty input", async () => {
    await assert.rejects(saveLoreConnection({ baseUrl: "ftp://core.example" }, { env: baseEnv }), /http\(s\)/i);
    await assert.rejects(saveLoreConnection({ baseUrl: "" }, { env: baseEnv }), /invalid/i);
    await assert.rejects(saveLoreConnection({} as never, { env: baseEnv }), /invalid/i);
  });
});

describe("testLoreConnection", () => {
  it("probes <base>/api/health with the Bearer token and client_type=pi", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      seen = { url: String(url), init: init ?? {} };
      return jsonResponse({ status: "ok" });
    }) as typeof fetch;
    const result = await testLoreConnection(
      { baseUrl: "https://api.loremem.com", apiToken: "lm_t" },
      { env: baseEnv, fetchImpl },
    );
    assert.deepEqual(result, { ok: true, baseUrl: "https://api.loremem.com" });
    assert.ok(seen!.url.startsWith("https://api.loremem.com/api/health"));
    assert.ok(seen!.url.includes("client_type=pi"));
    assert.equal((seen!.init.headers as Record<string, string>).authorization, "Bearer lm_t");
  });

  it("falls back to the saved connection from the config file", async () => {
    await writeFile(
      join(loreHome, "config.json"),
      `${JSON.stringify({ base_url: "https://core.example", api_token: "lm_saved" }, null, 2)}\n`,
    );
    const fetchImpl = (async () => jsonResponse({})) as typeof fetch;
    const result = await testLoreConnection({}, { env: baseEnv, fetchImpl });
    assert.deepEqual(result, { ok: true, baseUrl: "https://core.example" });
  });

  it("reuses the saved token only for the currently effective base (exact match after normalization)", async () => {
    await writeFile(
      join(loreHome, "config.json"),
      `${JSON.stringify({ base_url: "https://core.example/", api_token: "lm_saved" }, null, 2)}\n`,
    );
    let seen: { init: RequestInit } | undefined;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      seen = { init: init ?? {} };
      return jsonResponse({});
    }) as typeof fetch;
    // Same base modulo the trailing slash → the saved token is used.
    const same = await testLoreConnection({ baseUrl: "https://core.example" }, { env: baseEnv, fetchImpl });
    assert.deepEqual(same, { ok: true, baseUrl: "https://core.example" });
    assert.equal((seen!.init.headers as Record<string, string>).authorization, "Bearer lm_saved");
  });

  it("never sends the saved token to a different base (missing_token, no probe)", async () => {
    await writeFile(
      join(loreHome, "config.json"),
      `${JSON.stringify({ base_url: "https://core.example", api_token: "lm_saved" }, null, 2)}\n`,
    );
    const result = await testLoreConnection(
      { baseUrl: "https://attacker.example" },
      {
        env: baseEnv,
        fetchImpl: (async () => {
          throw new Error("must not fetch");
        }) as typeof fetch,
      },
    );
    assert.deepEqual(result, { ok: false, reason: "missing_token" });
    // An explicit token still probes any base.
    let seenUrl: string | undefined;
    const explicit = await testLoreConnection(
      { baseUrl: "https://attacker.example", apiToken: "lm_other" },
      {
        env: baseEnv,
        fetchImpl: (async (url: string | URL) => {
          seenUrl = String(url);
          return jsonResponse({});
        }) as typeof fetch,
      },
    );
    assert.deepEqual(explicit, { ok: true, baseUrl: "https://attacker.example" });
    assert.ok(seenUrl!.startsWith("https://attacker.example/api/health"));
  });

  it("never sends LORE_API_TOKEN to a different base either", async () => {
    const result = await testLoreConnection(
      { baseUrl: "https://attacker.example" },
      {
        env: { ...baseEnv, LORE_BASE_URL: "https://core.example", LORE_API_TOKEN: "lm_env" },
        fetchImpl: (async () => {
          throw new Error("must not fetch");
        }) as typeof fetch,
      },
    );
    assert.deepEqual(result, { ok: false, reason: "missing_token" });
  });

  it("does not follow redirects: a 3xx is an unreachable failure, never a followed probe", async () => {
    let seenInit: RequestInit | undefined;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      seenInit = init ?? {};
      return new Response(null, { status: 302, headers: { location: "https://evil.example/api/health" } });
    }) as typeof fetch;
    const result = await testLoreConnection(
      { baseUrl: "https://core.example", apiToken: "lm_t" },
      { env: baseEnv, fetchImpl },
    );
    assert.deepEqual(result, { ok: false, reason: "unreachable" });
    assert.equal(seenInit!.redirect, "manual");
  });

  it("401/403 → unauthorized; network failure/5xx → unreachable", async () => {
    const unauthorized = await testLoreConnection(
      { baseUrl: "https://core.example", apiToken: "lm_bad" },
      { env: baseEnv, fetchImpl: (async () => jsonResponse({ detail: "nope" }, 401)) as typeof fetch },
    );
    assert.deepEqual(unauthorized, { ok: false, reason: "unauthorized" });
    const unreachable = await testLoreConnection(
      { baseUrl: "https://core.example", apiToken: "lm_t" },
      { env: baseEnv, fetchImpl: (async () => {
        throw new Error("connect ECONNREFUSED");
      }) as typeof fetch },
    );
    assert.deepEqual(unreachable, { ok: false, reason: "unreachable" });
    const serverError = await testLoreConnection(
      { baseUrl: "https://core.example", apiToken: "lm_t" },
      { env: baseEnv, fetchImpl: (async () => jsonResponse({}, 500)) as typeof fetch },
    );
    assert.deepEqual(serverError, { ok: false, reason: "unreachable" });
  });

  it("invalid url / insecure http / missing token are local failures, not probes", async () => {
    assert.deepEqual(
      await testLoreConnection({ baseUrl: "not a url" }, { env: baseEnv, fetchImpl: (async () => {
        throw new Error("must not fetch");
      }) as typeof fetch }),
      { ok: false, reason: "invalid_url" },
    );
    assert.deepEqual(
      await testLoreConnection({ baseUrl: "http://core.example", apiToken: "lm_t" }, { env: baseEnv, fetchImpl: (async () => {
        throw new Error("must not fetch");
      }) as typeof fetch }),
      { ok: false, reason: "insecure_http" },
    );
    // A LAN http base passes the scheme gate and is actually probed.
    let probed = "";
    assert.deepEqual(
      await testLoreConnection({ baseUrl: "http://192.168.50.20:18901", apiToken: "lm_t" }, { env: baseEnv, fetchImpl: (async (url: string) => {
        probed = url;
        return jsonResponse({ status: "ok" });
      }) as unknown as typeof fetch }),
      { ok: true, baseUrl: "http://192.168.50.20:18901" },
    );
    assert.equal(probed, "http://192.168.50.20:18901/api/health?client_type=pi");
    assert.deepEqual(
      await testLoreConnection({ baseUrl: "https://core.example" }, { env: baseEnv, fetchImpl: (async () => {
        throw new Error("must not fetch");
      }) as typeof fetch }),
      { ok: false, reason: "missing_token" },
    );
  });
});
