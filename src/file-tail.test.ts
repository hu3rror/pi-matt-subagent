import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createFileTail } from "./file-tail.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "file-tail-test-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let counter = 0;
const freshFile = () => path.join(tmp, `tail-${counter++}.log`);

test("reports only what was appended since the previous read", () => {
  const file = freshFile();
  fs.writeFileSync(file, "hello");
  const tail = createFileTail(file);
  assert.equal(tail.read(), "hello");
  assert.equal(tail.read(), "");
  fs.appendFileSync(file, " world");
  assert.equal(tail.read(), " world");
});

test("a character split across two reads arrives whole", () => {
  const file = freshFile();
  fs.writeFileSync(file, "");
  const tail = createFileTail(file);
  const bytes = Buffer.from("é", "utf8");
  fs.appendFileSync(file, bytes.subarray(0, 1));
  assert.equal(tail.read(), "");
  fs.appendFileSync(file, bytes.subarray(1));
  assert.equal(tail.read(), "é");
});

test("a file that does not exist yet reads as empty", () => {
  const file = freshFile();
  const tail = createFileTail(file);
  assert.equal(tail.read(), "");
  fs.writeFileSync(file, "late");
  assert.equal(tail.read(), "late");
});

test("caps one read at a chunk and picks the rest up next time", () => {
  const file = freshFile();
  fs.writeFileSync(file, "a".repeat(70 * 1024));
  const tail = createFileTail(file);
  assert.equal(tail.read().length, 64 * 1024);
  assert.equal(tail.read().length, 6 * 1024);
  assert.equal(tail.read(), "");
});
