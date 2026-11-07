import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mergeMarkerSection, START, END } from "../dist/merge.js";

const fresh = () => join(mkdtempSync(join(tmpdir(), "cs-merge-")), "CLAUDE.md");
const count = (s, needle) => s.split(needle).length - 1;

test("absent file → created with only the managed block", () => {
  const f = fresh();
  assert.equal(mergeMarkerSection(f, "persona A"), "created");
  assert.equal(readFileSync(f, "utf-8"), `${START}\npersona A\n${END}\n`);
});

test("existing user file without markers → content kept, block appended", () => {
  const f = fresh();
  writeFileSync(f, "# My rules\n\nnever run rm -rf");
  assert.equal(mergeMarkerSection(f, "persona A"), "appended");
  const out = readFileSync(f, "utf-8");
  assert.ok(out.startsWith("# My rules\n\nnever run rm -rf"));
  assert.ok(out.includes("persona A"));
});

test("reinstall → only the block is replaced, no duplication", () => {
  const f = fresh();
  writeFileSync(f, "# My rules");
  mergeMarkerSection(f, "persona A");
  const once = readFileSync(f, "utf-8");
  assert.equal(mergeMarkerSection(f, "persona A"), "replaced");
  assert.equal(readFileSync(f, "utf-8"), once);
  assert.equal(count(once, START), 1);
});

test("switch persona → old block gone, user content and new block present", () => {
  const f = fresh();
  writeFileSync(f, "# My rules\n");
  mergeMarkerSection(f, "persona A");
  writeFileSync(f, readFileSync(f, "utf-8") + "\n## Added later by the user\n");
  mergeMarkerSection(f, "persona B");
  const out = readFileSync(f, "utf-8");
  assert.ok(out.includes("# My rules"));
  assert.ok(out.includes("## Added later by the user"));
  assert.ok(out.includes("persona B"));
  assert.ok(!out.includes("persona A"));
  assert.equal(count(out, START), 1);
  assert.equal(count(out, END), 1);
});
