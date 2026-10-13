/**
 * Assistant-workspace identity tests.
 *
 * The assistant directory derivation is shared by Host composition, the
 * session catalog hide filter and the Worker tool registration — these tests
 * pin the exact identity semantics (default join, normalized equality, the
 * browse-kind pattern) so the three consumers can never drift.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASSISTANT_WORKSPACE_PATH_PATTERN,
  isAssistantWorkspacePath,
  matchesAssistantWorkspacePattern,
  normalizeAssistantWorkspacePath,
  resolveAssistantWorkspaceDir,
} from "./assistant-workspace.js";

test("resolveAssistantWorkspaceDir joins the fixed segments under home", () => {
  assert.equal(resolveAssistantWorkspaceDir("/Users/proxy"), "/Users/proxy/.pi/pix/assistant");
  assert.equal(resolveAssistantWorkspaceDir("/home/x/"), "/home/x/.pi/pix/assistant");
  assert.equal(resolveAssistantWorkspaceDir("C:\\Users\\x\\"), "C:\\Users\\x/.pi/pix/assistant");
});

test("isAssistantWorkspacePath is normalized exact equality", () => {
  assert.equal(isAssistantWorkspacePath("/Users/proxy/.pi/pix/assistant", "/Users/proxy"), true);
  // Case-insensitive + trailing-slash tolerant comparison.
  assert.equal(isAssistantWorkspacePath("/Users/Proxy/.PI/Pix/Assistant/", "/users/proxy"), true);
  // Sibling/prefix paths never match.
  assert.equal(isAssistantWorkspacePath("/Users/proxy/.pi/pix/assistant-notes", "/Users/proxy"), false);
  assert.equal(isAssistantWorkspacePath("/Users/proxy/.pi/pix/assistant/sub", "/Users/proxy"), false);
  assert.equal(isAssistantWorkspacePath("/Users/proxy/Documents", "/Users/proxy"), false);
});

test("the browse-kind pattern matches the assistant family under any home", () => {
  assert.equal(matchesAssistantWorkspacePattern(normalizeAssistantWorkspacePath("/Users/proxy/.pi/pix/assistant")), true);
  assert.equal(matchesAssistantWorkspacePattern(normalizeAssistantWorkspacePath("/home/x/.pi/pix/assistant")), true);
  // A nested/leaf path inside the directory also matches (pattern is dir-scoped).
  assert.equal(matchesAssistantWorkspacePattern(normalizeAssistantWorkspacePath("/Users/proxy/.pi/pix/assistant/")), true);
  // Near-miss siblings do not.
  assert.equal(matchesAssistantWorkspacePattern(normalizeAssistantWorkspacePath("/Users/proxy/.pi/pix/assistantx")), false);
  assert.equal(matchesAssistantWorkspacePattern(normalizeAssistantWorkspacePath("/Users/proxy/.pi/pix/sessiond")), false);
  assert.equal(ASSISTANT_WORKSPACE_PATH_PATTERN.test("/users/proxy/documents"), false);
});

test("resolve + predicate round-trip for a real home", () => {
  const dir = resolveAssistantWorkspaceDir("/Users/proxy");
  assert.equal(isAssistantWorkspacePath(dir, "/Users/proxy"), true);
  assert.equal(matchesAssistantWorkspacePattern(normalizeAssistantWorkspacePath(dir)), true);
});
