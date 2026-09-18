import type { HttpClient } from "./http-client";
import { urls } from "./urls";
import {
  GateLoginResultSchema,
  GateLogoutResultSchema,
  GatePasswordChangeResultSchema,
  GateStatusSchema,
} from "./schemas";

export interface GateLoginInput { password: string; next?: string }
export interface GatePasswordChangeInput { currentPassword?: string; newPassword: string }

export function createGateApi(http: HttpClient) {
  return {
    status: (signal?: AbortSignal) => http.get(urls.gate.status(), { schema: GateStatusSchema, ...(signal === undefined ? {} : { signal }) }),
    login: (input: GateLoginInput, signal?: AbortSignal) => http.post(urls.gate.login(), input, { schema: GateLoginResultSchema, skipAuthRedirect: true, ...(signal === undefined ? {} : { signal }) }),
    logout: (signal?: AbortSignal) => http.post(urls.gate.logout(), {}, { schema: GateLogoutResultSchema, ...(signal === undefined ? {} : { signal }) }),
    changePassword: (input: GatePasswordChangeInput, signal?: AbortSignal) => http.put(urls.gate.changePassword(), input, { schema: GatePasswordChangeResultSchema, skipAuthRedirect: true, ...(signal === undefined ? {} : { signal }) }),
  };
}
export type GateApi = ReturnType<typeof createGateApi>;
