import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateRawSync } from "node:zlib";
import { createAllowedRootService, createHostApp } from "../dist/index.js";

// ---------------------------------------------------------------------------
// DOCX (OPC/zip) fixture builders — real minimal Word documents, no mocks.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** Minimal ZIP writer (deflate entries, `store: true` forces stored). */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const { name, data } = entry;
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const compressed = entry.store ? data : deflateRawSync(data, { level: 9 });
    const useDeflate = !entry.store && compressed.length < data.length;
    const stored = useDeflate ? compressed : data;
    const method = useDeflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, stored);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + stored.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const PACKAGE_RELS = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

function textDocxEntries(paragraphs) {
  const contentTypes = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const body = paragraphs.map((text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`).join("");
  const document = `${XML_HEAD}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  return [
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(PACKAGE_RELS, "utf8") },
    { name: "word/document.xml", data: Buffer.from(document, "utf8") },
  ];
}

function makeTextDocx(paragraphs) {
  return makeZip(textDocxEntries(paragraphs));
}

/** Valid docx padded to an exact byte size via a stored junk part (cap is `>`, not `>=`). */
function makeDocxOfExactSize(paragraphs, size) {
  const contentTypesWithBin = (entries) => [
    { ...entries[0], data: Buffer.from(entries[0].data.toString("utf8").replace("</Types>", '<Default Extension="bin" ContentType="application/octet-stream"/></Types>'), "utf8") },
    ...entries.slice(1),
  ];
  const base = makeZip([...contentTypesWithBin(textDocxEntries(paragraphs)), { name: "junk.bin", data: Buffer.alloc(0), store: true }]);
  assert.ok(base.length <= size, "fixture smaller than target size");
  return makeZip([
    ...contentTypesWithBin(textDocxEntries(paragraphs)),
    { name: "junk.bin", data: Buffer.alloc(size - base.length), store: true },
  ]);
}

// 1x1 transparent PNG.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function imageParagraph(relId) {
  return `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0"><wp:extent cx="9525" cy="9525"/><wp:docPr id="1" name="image1.png"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="1" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relId}"/></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9525" cy="9525"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

function imageDocxEntries(relsXml, bodyXml, includeMedia) {
  const contentTypes = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${includeMedia ? '<Default Extension="png" ContentType="image/png"/>' : ""}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const document = `${XML_HEAD}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${bodyXml}</w:body></w:document>`;
  const entries = [
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(PACKAGE_RELS, "utf8") },
    { name: "word/document.xml", data: Buffer.from(document, "utf8") },
    { name: "word/_rels/document.xml.rels", data: Buffer.from(relsXml, "utf8") },
  ];
  if (includeMedia) entries.push({ name: "word/media/image1.png", data: PNG_1X1 });
  return entries;
}

/** docx with an embedded PNG image — mammoth must inline it as a data: URI. */
function makeImageDocx() {
  const rels = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>`;
  return makeZip(imageDocxEntries(rels, `${imageParagraph("rIdImg1")}<w:p><w:r><w:t>with image</w:t></w:r></w:p>`, true));
}

/** docx whose only image relationship is EXTERNAL (http) — must never be fetched or surfaced. */
function makeExternalImageDocx(url) {
  const rels = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" TargetMode="External" Target="${url}"/></Relationships>`;
  return makeZip(imageDocxEntries(rels, `${imageParagraph("rIdImg1")}<w:p><w:r><w:t>external image</w:t></w:r></w:p>`, false));
}

// ---------------------------------------------------------------------------
// Host fixture (same shape as resources.test.mjs)
// ---------------------------------------------------------------------------

const temporary = [];
const gate = { config: { read: () => ({ status: "disabled", source: "test" }) } };
function temp(prefix) { const value = mkdtempSync(join(tmpdir(), prefix)); temporary.push(value); return value; }
afterEach(() => { while (temporary.length) rmSync(temporary.pop(), { recursive: true, force: true }); });

async function fixture() {
  const root = temp("pi-host-docx-");
  const allowedRoots = await createAllowedRootService({ roots: [root] });
  const host = createHostApp({ logger: {}, gate, resources: { allowedRoots } });
  return { root, app: host.app };
}
function headers(extra = {}) { return { host: "localhost", ...extra }; }
const preview = (app, path) => app.request(`http://localhost/v1/files?op=docx-preview&path=${encodeURIComponent(path)}`, { headers: headers() });

const EXPECTED_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("docx-preview renders a minimal docx as sandboxed HTML with strict headers", async () => {
  const { root, app } = await fixture();
  writeFileSync(join(root, "hello.docx"), makeTextDocx(["Hello DOCX preview", "Second paragraph"]));
  const res = await preview(app, join(root, "hello.docx"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.headers.get("content-security-policy"), EXPECTED_CSP);
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("cache-control"), "no-store");
  const html = await res.text();
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.includes("<p>Hello DOCX preview</p><p>Second paragraph</p>"), "mammoth body html is embedded");
  assert.ok(html.includes('class="file-title"'), "wrapper shows the file title");
  assert.ok(html.includes("hello.docx"));
  assert.ok(!/<script/i.test(html), "no script elements in the wrapper");
});

test("docx-preview matches the extension case-insensitively (.DOCX)", async () => {
  const { root, app } = await fixture();
  writeFileSync(join(root, "UPPER.DOCX"), makeTextDocx(["cased"]));
  const res = await preview(app, join(root, "UPPER.DOCX"));
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes("<p>cased</p>"));
});

test("docx-preview escapes the file name in the title", async () => {
  const { root, app } = await fixture();
  writeFileSync(join(root, "a&b<c>\"onerror=x.docx"), makeTextDocx(["payload"]));
  const res = await preview(app, join(root, "a&b<c>\"onerror=x.docx"));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("a&amp;b&lt;c&gt;&quot;onerror=x.docx"), "escaped title");
  assert.ok(!html.includes('class="file-title">a&b<c>'), "raw unescaped name never emitted");
});

test("docx-preview inlines embedded images as data URIs and never external http(s) sources", async () => {
  const { root, app } = await fixture();
  writeFileSync(join(root, "image.docx"), makeImageDocx());
  const res = await preview(app, join(root, "image.docx"));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('<img src="data:image/png;base64,'), "embedded image inlined as data URI");
  assert.equal(/src="(?!data:)/.test(html), false, "no non-data image sources");
  assert.equal(/(src|href)="https?:\/\//i.test(html), false, "no external http(s) references");
});

test("docx-preview never fetches or surfaces an external (TargetMode=External) image relationship", async () => {
  const { root, app } = await fixture();
  writeFileSync(join(root, "external.docx"), makeExternalImageDocx("http://example.invalid/evil.png"));
  const res = await preview(app, join(root, "external.docx"));
  assert.ok([200, 422].includes(res.status), `external-image docx resolves safely, got ${res.status}`);
  const body = await res.text();
  assert.equal(body.includes("example.invalid"), false, "external image URL never surfaces");
  assert.equal(/(src|href)="https?:\/\//i.test(body), false, "no external http(s) references");
});

test("docx-preview enforces the 10 MiB cap with > (not >=) semantics", async () => {
  const { root, app } = await fixture();
  const cap = 10 * 1024 * 1024;
  writeFileSync(join(root, "exact.docx"), makeDocxOfExactSize(["exact cap"], cap));
  const exact = await preview(app, join(root, "exact.docx"));
  assert.equal(exact.status, 200);
  assert.ok((await exact.text()).includes("<p>exact cap</p>"));
  writeFileSync(join(root, "over.docx"), makeDocxOfExactSize(["over cap"], cap + 1));
  const over = await preview(app, join(root, "over.docx"));
  assert.equal(over.status, 413);
  const body = await over.json();
  assert.equal(body.code, "DOCX_TOO_LARGE");
  assert.equal(body.error, "DOCX preview is limited to 10 MiB");
});

test("docx-preview rejects non-docx files with a fixed 400", async () => {
  const { root, app } = await fixture();
  writeFileSync(join(root, "notes.txt"), "plain text");
  writeFileSync(join(root, "legacy.doc"), "old word");
  writeFileSync(join(root, "noext"), "no extension");
  for (const name of ["notes.txt", "legacy.doc", "noext"]) {
    const res = await preview(app, join(root, name));
    assert.equal(res.status, 400, name);
    const body = await res.json();
    assert.equal(body.code, "DOCX_ONLY");
    assert.equal(body.error, "DOCX preview is only available for .docx files");
  }
});

test("docx-preview rejects directories with a fixed 400", async () => {
  const { root, app } = await fixture();
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(root, "folder.docx"));
  const res = await preview(app, join(root, "folder.docx"));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, "NOT_FILE");
});

test("docx-preview maps corrupt docx conversion failures to a fixed sanitized error", async () => {
  const { root, app } = await fixture();
  writeFileSync(join(root, "broken.docx"), Buffer.from("this is not a zip file at all"));
  const res = await preview(app, join(root, "broken.docx"));
  assert.equal(res.status, 422);
  const raw = await res.text();
  const body = JSON.parse(raw);
  assert.equal(body.code, "DOCX_PREVIEW_FAILED");
  assert.equal(body.error, "Unable to render this DOCX document");
  assert.equal(raw.includes("broken.docx"), false, "no path in error");
  assert.equal(raw.toLowerCase().includes("central directory"), false, "no mammoth/jszip raw message");
  assert.equal(raw.toLowerCase().includes("zip"), false, "no underlying library detail");
  // a valid zip that is not a word document fails the same fixed way
  writeFileSync(join(root, "notword.docx"), makeZip([{ name: "a.txt", data: Buffer.from("hi") }]));
  const notWord = await preview(app, join(root, "notword.docx"));
  assert.equal(notWord.status, 422);
  assert.equal((await notWord.json()).code, "DOCX_PREVIEW_FAILED");
});

test("docx-preview keeps AllowedRoot authorization: traversal, NUL, symlink escape and missing paths fail closed", async () => {
  const { root, app } = await fixture();
  const outside = temp("pi-host-docx-outside-");
  writeFileSync(join(outside, "secret.docx"), makeTextDocx(["SECRET DOCUMENT CONTENT"]));
  symlinkSync(join(outside, "secret.docx"), join(root, "link.docx"));
  for (const value of [resolve(root, "..", "outside.docx"), `${root}\0bad`, join(root, "link.docx"), join(root, "missing.docx")]) {
    const res = await preview(app, value);
    assert.ok([400, 403, 404].includes(res.status), `${value}: ${res.status}`);
    const body = await res.text();
    assert.equal(body.includes("SECRET DOCUMENT CONTENT"), false, "outside-root content never read");
    assert.equal(body.includes("secret.docx"), false, "outside-root path never echoed");
  }
  // the symlink case specifically must be PATH_FORBIDDEN before any read
  const forbidden = await preview(app, join(root, "link.docx"));
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).code, "PATH_FORBIDDEN");
});

test("docx-preview stays distinct from preview/read/raw: binary docx keeps its existing response shape", async () => {
  const { root, app } = await fixture();
  const bytes = makeTextDocx(["ambiguity"]);
  writeFileSync(join(root, "same.docx"), bytes);
  // preview/read keep refusing binary content (415 BINARY_FILE, requires raw);
  // raw keeps streaming the exact bytes; only docx-preview returns HTML.
  for (const op of ["preview", "read"]) {
    const res = await app.request(`http://localhost/v1/files?op=${op}&path=${encodeURIComponent(join(root, "same.docx"))}`, { headers: headers() });
    assert.equal(res.status, 415, op);
    assert.equal((await res.json()).code, "BINARY_FILE");
  }
  const rawRes = await app.request(`http://localhost/v1/files?op=raw&path=${encodeURIComponent(join(root, "same.docx"))}`, { headers: headers() });
  assert.equal(rawRes.status, 200);
  assert.equal(rawRes.headers.get("content-type"), "application/octet-stream");
  assert.deepEqual([...Buffer.from(await rawRes.arrayBuffer())], [...bytes], "raw streams the raw bytes");
  const htmlRes = await preview(app, join(root, "same.docx"));
  assert.equal(htmlRes.status, 200);
  assert.equal(htmlRes.headers.get("content-type"), "text/html; charset=utf-8");
});
