// Re-export of the compiled helper. Fixtures are spawned from source, so this
// file stays next to them; the implementation lives in test-endpoint.ts so the
// compiled tests (dist-test) resolve it without copying .mjs files.
export { fixtureEndpoint } from "../test-endpoint.ts";
