import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { connectPushAttentionReporter } from "./push-attention-reporter";

// The reporter core owns the endpoint-hash lifecycle: adopted on connect,
// refreshed whenever a push subscribe/unsubscribe mutation settles, cleared on
// cleanup. Tests drive real TanStack mutations with the production
// ["pix","push",…] mutationKeys.

/** Fires one mutation with the given key as soon as it mounts. */
function MutationProbe({ mutationKey }: { mutationKey: readonly unknown[] }) {
  const mutation = useMutation({ mutationKey, mutationFn: async () => "ok" });
  useEffect(() => {
    void mutation.mutateAsync().catch(() => undefined);
    // Fire exactly once per mount, like a settings-page toggle.
  }, []);
  return null;
}

function mountMutations(qc: QueryClient, keys: readonly (readonly unknown[])[]): void {
  render(
    <QueryClientProvider client={qc}>
      {keys.map((key) => <MutationProbe key={JSON.stringify(key)} mutationKey={key} />)}
    </QueryClientProvider>,
  );
}

describe("connectPushAttentionReporter", () => {
  afterEach(cleanup);

  it("adopts the hash on connect, refreshes after push subscribe/unsubscribe settle, ignores other mutations", async () => {
    const qc = new QueryClient();
    const setHash = vi.fn();
    let reads = 0;
    const cleanupReporter = connectPushAttentionReporter({
      readHash: async () => {
        reads += 1;
        return `hash-${reads}`;
      },
      setHash,
      queryClient: qc,
    });
    await act(async () => { await Promise.resolve(); });
    expect(setHash).toHaveBeenCalledTimes(1);
    expect(setHash).toHaveBeenCalledWith("hash-1");

    // A push mutation settling refreshes the hash; unrelated mutations never do.
    await act(async () => {
      mountMutations(qc, [["pix", "push", "subscribe"], ["pix", "sessions", "create"]]);
      await Promise.resolve();
    });
    await waitFor(() => expect(setHash).toHaveBeenCalledWith("hash-2"));
    expect(reads).toBe(2); // exactly one refresh (the push mutation)

    // Unsubscribe refreshes too (per-device suppression stops mapping).
    await act(async () => {
      mountMutations(qc, [["pix", "push", "unsubscribe"]]);
      await Promise.resolve();
    });
    await waitFor(() => expect(setHash).toHaveBeenCalledWith("hash-3"));
    expect(reads).toBe(3);

    cleanupReporter();
    expect(setHash).toHaveBeenLastCalledWith(undefined);
  });

  it("fail-open: an unreadable endpoint reports undefined (no mapping), never a fabricated hash", async () => {
    const qc = new QueryClient();
    const setHash = vi.fn();
    const cleanupReporter = connectPushAttentionReporter({
      readHash: async () => undefined,
      setHash,
      queryClient: qc,
    });
    await act(async () => { await Promise.resolve(); });
    expect(setHash).toHaveBeenCalledWith(undefined);
    cleanupReporter();
  });
});
