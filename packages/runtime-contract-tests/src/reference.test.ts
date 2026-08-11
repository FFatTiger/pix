/**
 * Runs the full adapter contract suite against the reference fake for real.
 */
import { createRuntimeAdapterSuite } from "./suite.js";
import { createReferenceHarness } from "./reference.js";

createRuntimeAdapterSuite(createReferenceHarness());
