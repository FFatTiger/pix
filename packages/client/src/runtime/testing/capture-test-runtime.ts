/**
 * TEST-ONLY helper: bind a non-owning TestRuntimeStore to the provider-owned
 * connection + registry. Never a production facade or lifecycle owner.
 */
import { useEffect, useRef, useState } from "react";
import { useRuntimeOwners } from "../runtime-provider.js";
import { TestRuntimeStore } from "./test-runtime-store.js";

export function CaptureTestRuntime({
  onStore,
}: {
  onStore: (store: TestRuntimeStore) => void;
}): null {
  const { connection, registry } = useRuntimeOwners();
  const [store] = useState(() => new TestRuntimeStore(connection, registry));
  const onStoreRef = useRef(onStore);
  onStoreRef.current = onStore;
  useEffect(() => {
    onStoreRef.current(store);
    return () => store.dispose();
  }, [store]);
  return null;
}
