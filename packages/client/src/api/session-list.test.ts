import { describe, expect, it, vi } from "vitest";
import { createHttpClient } from "./http-client";
import {
  createProjectPageQueryOptions,
  createSessionPageQueryOptions,
  primeSessionPageTitleData,
  PROJECT_PAGE_SIZE,
  PROJECT_SESSION_PAGE_SIZE,
  SESSION_PAGE_SIZE,
} from "./session-list";
import { queryKeys } from "./query-keys";

const json = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { "content-type": "application/json" },
});

const sessionPage = {
  sessions: [{ sessionId: "s1", cwd: "/x", projectRoot: "/x" }],
  page: 2,
  pageSize: 50,
  total: 51,
  totalPages: 2,
  catalogRevision: 7,
};
const projectPage = {
  projects: [{ projectRoot: "/x", representativeCwd: "/x", sessionCount: 51, latestActivity: 10 }],
  page: 1,
  pageSize: 10,
  total: 1,
  totalPages: 1,
  catalogRevision: 7,
};

describe("true numbered catalog pages", () => {
  it("requests exactly one independent session page", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(sessionPage));
    const options = createSessionPageQueryOptions({
      http: createHttpClient({ fetchImpl: fetchImpl as unknown as typeof fetch }),
      queryKey: queryKeys.sessions.page(2, 50),
      page: 2,
      pageSize: 50,
      enabled: true,
    });
    await options.queryFn!({ signal: new AbortController().signal } as never);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("/v1/sessions?page=2&pageSize=50");
  });

  it("project-scoped sessions have their own page identity", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ ...sessionPage, pageSize: 20 }));
    const options = createSessionPageQueryOptions({
      http: createHttpClient({ fetchImpl: fetchImpl as unknown as typeof fetch }),
      queryKey: queryKeys.sessions.page(2, 20, undefined, "/repo x"),
      page: 2,
      pageSize: 20,
      projectRoot: "/repo x",
      enabled: true,
    });
    await options.queryFn!({ signal: new AbortController().signal } as never);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("/v1/sessions?page=2&pageSize=20&projectRoot=%2Frepo+x");
  });

  it("Projects are a separate resource and request", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(projectPage));
    const options = createProjectPageQueryOptions({
      http: createHttpClient({ fetchImpl: fetchImpl as unknown as typeof fetch }),
      queryKey: queryKeys.projects.page(1, 10),
      page: 1,
      pageSize: 10,
      enabled: true,
    });
    await options.queryFn!({ signal: new AbortController().signal } as never);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("/v1/projects?page=1&pageSize=10");
  });

  it("patches a title without changing page totals or inserting rows", () => {
    const patched = primeSessionPageTitleData(sessionPage, "s1", "Renamed") as typeof sessionPage & { sessions: Array<{ title?: string }> };
    expect(patched.sessions).toHaveLength(1);
    expect(patched.sessions[0]?.title).toBe("Renamed");
    expect(patched.total).toBe(51);
  });

  it("freezes UI page sizes", () => {
    expect(PROJECT_PAGE_SIZE).toBe(10);
    expect(SESSION_PAGE_SIZE).toBe(5);
    expect(PROJECT_SESSION_PAGE_SIZE).toBe(5);
  });
});
