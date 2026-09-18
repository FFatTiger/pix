import { queryOptions, type QueryKey } from "@tanstack/react-query";
import type { ProjectPage, SessionHeader, SessionPage } from "@fffattiger/pix-protocol";
import type { HttpClient } from "./http-client";
import { createSessionsApi } from "./sessions";

// Sidebar catalog batches stay deliberately short so "Load more" remains
// visible next to the current results instead of below a long rail.
export const SESSION_PAGE_SIZE = 5;
export const PROJECT_PAGE_SIZE = 10;
export const PROJECT_SESSION_PAGE_SIZE = 5;
export const PROJECT_PICKER_PAGE_SIZE = 50;

/** Patch an exact session title in any cached numbered page; totals/order stay authority-owned. */
export function primeSessionPageTitleData(current: unknown, id: string, title: string): unknown {
  if (current === null || typeof current !== "object" || !("sessions" in current)) return current;
  const page = current as { sessions?: unknown };
  if (!Array.isArray(page.sessions)) return current;
  return {
    ...current,
    sessions: page.sessions.map((session) => {
      if (session === null || typeof session !== "object") return session;
      return (session as { sessionId?: unknown }).sessionId === id ? { ...session, title } : session;
    }),
  };
}

export function createSessionPageQueryOptions(input: {
  readonly http: HttpClient;
  readonly queryKey: QueryKey;
  readonly page: number;
  readonly pageSize: number;
  readonly enabled: boolean;
  readonly cwd?: string;
  readonly projectRoot?: string;
}) {
  const api = createSessionsApi(input.http);
  return queryOptions<SessionPage>({
    queryKey: input.queryKey,
    queryFn: ({ signal }) => api.list({
      page: input.page,
      pageSize: input.pageSize,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.projectRoot === undefined ? {} : { projectRoot: input.projectRoot }),
      signal,
    }),
    enabled: input.enabled,
    staleTime: 30_000,
    retry: false,
  });
}

export function createProjectPageQueryOptions(input: {
  readonly http: HttpClient;
  readonly queryKey: QueryKey;
  readonly page: number;
  readonly pageSize: number;
  readonly enabled: boolean;
}) {
  const api = createSessionsApi(input.http);
  return queryOptions<ProjectPage>({
    queryKey: input.queryKey,
    queryFn: ({ signal }) => api.projects({ page: input.page, pageSize: input.pageSize, signal }),
    enabled: input.enabled,
    staleTime: 30_000,
    retry: false,
  });
}

/** Out-of-band provisional rows never mutate authoritative page arrays/totals. */
export interface ProvisionalSessionHeader extends SessionHeader {}
