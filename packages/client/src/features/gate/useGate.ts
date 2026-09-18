import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createMutationOptions } from "@/api/mutations";
import { createQueryOptions } from "@/api/query-keys";
import { useHttpClient } from "@/app/http-context";

export function useGateStatus(enabled = true) {
  const http = useHttpClient();
  return useQuery({ ...createQueryOptions(http).gate.status(), enabled });
}

export function useGateLogin() {
  const http = useHttpClient();
  const queryClient = useQueryClient();
  return useMutation(createMutationOptions(http, queryClient).gate.login());
}

export function useGateLogout() {
  const http = useHttpClient();
  const queryClient = useQueryClient();
  return useMutation(createMutationOptions(http, queryClient).gate.logout());
}

export function useGatePasswordChange() {
  const http = useHttpClient();
  const queryClient = useQueryClient();
  return useMutation(createMutationOptions(http, queryClient).gate.changePassword());
}
