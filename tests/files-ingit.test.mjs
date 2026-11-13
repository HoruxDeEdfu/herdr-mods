// code-files: telling an edited tab whose text Git already stores (safe to reload)
// from real unsaved work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { MODS, sh, exec, makeRepo, commit } from "./helpers/repo.mjs";

const B = await import(join(MODS, "code-files/gitblob.js"));
const id = (text) => B.blobId(text, createHash, (x) => Buffer.from(x, "utf8"));
const known = async (path, text) => (await exec("git", B.knownArgs(id(text)), { cwd: B.folderOf(path) })).code === 0;

test("blobId matches git hash-object, Unicode included", async () => {
  const d = await makeRepo();
  for (const text of ["", "hola\n", "ñandú — 日本\nsin salto final"]) {
    writeFileSync(join(d, "x.txt"), text);
    assert.equal(id(text), (await sh(d, "hash-object", "x.txt")).trim());
  }
});

test("after a checkout, the other branch's version is known; real edits are not", async () => {
  const d = await makeRepo();
  mkdirSync(join(d, "src"));
  await commit(d, "src/app.js", "main version\n", "main");
  await sh(d, "switch", "-qc", "dev");
  await commit(d, "src/app.js", "dev version\n", "dev");
  const file = join(d, "src/app.js");
  // The tab still shows main's text while the disk now has dev's.
  assert.equal(await known(file, "main version\n"), true);
  assert.equal(await known(file, "main version\nplus my unsaved line\n"), false);
});

test("outside a repository nothing counts as known", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "no repo "));
  assert.equal(await known(join(dir, "a.txt"), "hola\n"), false);
  assert.equal(B.folderOf("/a/b/c.txt"), "/a/b");
  assert.equal(B.folderOf("/c.txt"), "/");
});
