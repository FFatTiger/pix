import assert from "node:assert/strict";
import test from "node:test";
import { ByteLineDecoder } from "../src/internal/byte-line-decoder.js";

test("byte line decoder extracts multiple frames and retains trailing partial", () => {
  const decoder = new ByteLineDecoder({ maxLineBytes: 1024 });
  const r1 = decoder.push(Buffer.from("a\nb\nc"));
  assert.deepEqual(r1.lines, ["a", "b"]);
  assert.equal(r1.error, undefined);
  assert.equal(r1.pendingBytes, 1);
  const r2 = decoder.push(Buffer.from("\n"));
  assert.deepEqual(r2.lines, ["c"]);
  assert.equal(r2.pendingBytes, 0);
  assert.equal(r2.error, undefined);
});

test("byte line decoder reassembles a UTF-8 sequence split across chunks", () => {
  const decoder = new ByteLineDecoder({ maxLineBytes: 1024 });
  // "好" is 3 UTF-8 bytes. Feed it one byte at a time, then the newline.
  const bytes = Buffer.from("好\n", "utf8");
  const lines: string[] = [];
  for (const b of bytes) {
    const r = decoder.push(Buffer.from([b]));
    assert.equal(r.error, undefined);
    lines.push(...r.lines);
  }
  assert.deepEqual(lines, ["好"]);
});

test("byte line decoder enforces the per-line byte bound (split across chunks)", () => {
  const decoder = new ByteLineDecoder({ maxLineBytes: 8 });
  const r1 = decoder.push(Buffer.from("aaaa")); // 4 bytes, under 8 → retained
  assert.equal(r1.error, undefined);
  assert.equal(r1.pendingBytes, 4);
  const r2 = decoder.push(Buffer.from("bbbbb")); // 4+5=9 > 8 and no newline → exceeds
  assert.notEqual(r2.error, undefined);
  assert.deepEqual(r2.lines, []);
  assert.equal(r2.pendingBytes, 0);
});

test("byte line decoder enforces the per-line byte bound across a newline race", () => {
  const decoder = new ByteLineDecoder({ maxLineBytes: 8 });
  // 5 bytes retained; a chunk adds 5 more then a newline → line is 10 > 8.
  decoder.push(Buffer.from("aaaaa"));
  const r = decoder.push(Buffer.from("bbbbb\n"));
  assert.notEqual(r.error, undefined);
  assert.deepEqual(r.lines, []);
});

test("byte line decoder rejects a frame exactly at the limit boundary (limit, limit+1)", () => {
  const ok = new ByteLineDecoder({ maxLineBytes: 4 });
  const rOk = ok.push(Buffer.from("abcd\n"));
  assert.equal(rOk.error, undefined);
  assert.deepEqual(rOk.lines, ["abcd"]);

  const over = new ByteLineDecoder({ maxLineBytes: 4 });
  const rOver = over.push(Buffer.from("abcde\n"));
  assert.notEqual(rOver.error, undefined);
  assert.deepEqual(rOver.lines, []);
});

test("byte line decoder bound applies per line, not to the whole packet", () => {
  const decoder = new ByteLineDecoder({ maxLineBytes: 4 });
  // Many short complete lines in one packet are all fine.
  const r = decoder.push(Buffer.from("a\nb\nc\nd\n"));
  assert.equal(r.error, undefined);
  assert.deepEqual(r.lines, ["a", "b", "c", "d"]);
});
