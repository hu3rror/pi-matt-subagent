// Committed-state parse guard for the extension: `node --check` silently
// passes .ts files under an ESM+strip package scope even when they carry
// syntax errors (a lost `/**` in a doc comment shipped unparseable once —
// this test would have caught it). `stripTypeScriptTypes` parses the file
// as TypeScript and throws on any invalid syntax; nothing here resolves
// imports, so it stays free of the pi runtime.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const EXTENSION = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "extensions",
  "subagent.ts",
);

test("extensions/subagent.ts parses as TypeScript (committed state must load)", () => {
  const source = readFileSync(EXTENSION, "utf8");
  assert.doesNotThrow(() => stripTypeScriptTypes(source), "extension must be valid TypeScript");
});