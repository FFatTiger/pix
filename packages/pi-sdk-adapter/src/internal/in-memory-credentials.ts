// Presence-only credential loader shared by the read-only catalogs.
//
// Reads auth.json ONCE into an in-memory store. Missing/malformed files yield
// an empty store. Raw secrets stay in memory and never leave these catalogs.
import { readFileSync } from "node:fs";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { Credential } from "@earendil-works/pi-ai";

function isCredential(value: unknown): value is Credential {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === "api_key" || type === "oauth";
}

export async function loadInMemoryCredentials(authPath: string): Promise<InMemoryCredentialStore> {
  const store = new InMemoryCredentialStore();
  try {
    const raw = readFileSync(authPath, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    for (const [providerId, credential] of Object.entries(data)) {
      if (isCredential(credential)) {
        await store.modify(providerId, async () => credential);
      }
    }
  } catch {
    // Missing or malformed auth.json: report no stored credentials.
  }
  return store;
}
