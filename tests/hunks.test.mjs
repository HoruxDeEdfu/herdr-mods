// Stage / unstage one hunk: only the index changes, the file never does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MODS, Q, O, git, sh, makeRepo, commit, ctx } from "./helpers/repo.mjs";

const D = await import(join(MODS, "git-panel/git/diff.js"));
const { explain } = await import(join(MODS, "git-panel/git/errors.js"));
const lines = (n, f = (i) => `línea ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join("\n") + "\n";

/** A 40-line file with three separate edits → three hunks. */
async function threeHunks() {
  const d = await makeRepo();
  await commit(d, "big.txt", lines(40), "big");
  const edited = lines(40, (i) => (i === 3 ? "TRES" : i === 20 ? "VEINTE" : i === 37 ? "TREINTA Y SIETE" : `línea ${i}`));
  writeFileSync(join(d, "big.txt"), edited);
  return { d, edited, patchFile: join(d, ".git", "herdr-git-panel-hunk.patch") };
}

test("splitHunks / hunkRowIndexes agree with the rows the panel draws", async () => {
  const { d } = await threeHunks();
  const text = await Q.fileDiff(git, d, "big.txt", "unstaged");
  const { header, hunks } = D.splitHunks(text);
  assert.equal(hunks.length, 3);
  assert.ok(header[0].startsWith("diff --git"));
  assert.deepEqual(hunks.map((h) => [h.adds, h.dels]), [[1, 1], [1, 1], [1, 1]]);
  const rows = D.diffRows(text).rows;
  const idx = D.hunkRowIndexes(rows);
  assert.equal(idx.length, 3);
  assert.deepEqual(idx.map((i) => rows[i].text), hunks.map((h) => h.header));
  assert.equal(D.canSplit(text), true);
});

test("stage the middle hunk only, then unstage it; the file on disk never changes", async () => {
  const { d, edited, patchFile } = await threeHunks();
  const repo = (await ctx(d)).repo;
  const text = await Q.fileDiff(git, d, "big.txt", "unstaged");
  writeFileSync(patchFile, D.hunkPatch(text, 1));
  await O.applyHunk(git, repo, patchFile);
  const staged = await Q.fileDiff(git, d, "big.txt", "staged");
  assert.match(staged, /\+VEINTE/);
  assert.doesNotMatch(staged, /TRES|TREINTA/);
  assert.equal(D.splitHunks(await Q.fileDiff(git, d, "big.txt", "unstaged")).hunks.length, 2);
  assert.equal(readFileSync(join(d, "big.txt"), "utf8"), edited);

  writeFileSync(patchFile, D.hunkPatch(staged, 0));
  await O.applyHunk(git, repo, patchFile, { reverse: true });
  assert.equal(await Q.fileDiff(git, d, "big.txt", "staged"), "");
  assert.equal(readFileSync(join(d, "big.txt"), "utf8"), edited);
});

test("the last hunk applies even after earlier ones were staged (line offsets)", async () => {
  const { d, patchFile } = await threeHunks();
  const repo = (await ctx(d)).repo;
  for (let k = 0; k < 3; k++) {
    const text = await Q.fileDiff(git, d, "big.txt", "unstaged");
    writeFileSync(patchFile, D.hunkPatch(text, D.splitHunks(text).hunks.length - 1));
    await O.applyHunk(git, repo, patchFile);
  }
  assert.equal(await Q.fileDiff(git, d, "big.txt", "unstaged"), "");
});

test("not split: new files, deletions, binaries; a stale patch fails with a sentence", async () => {
  const { d, patchFile } = await threeHunks();
  writeFileSync(join(d, "nuevo.txt"), "a\nb\n");
  assert.equal(D.canSplit(await Q.fileDiff(git, d, "nuevo.txt", "untracked")), false);
  await sh(d, "add", "nuevo.txt");
  assert.equal(D.canSplit(await Q.fileDiff(git, d, "nuevo.txt", "staged")), false);
  await sh(d, "rm", "-q", "--cached", "a.txt");
  assert.equal(D.canSplit(await Q.fileDiff(git, d, "a.txt", "staged")), false);
  assert.equal(D.canSplit(""), false);
  assert.throws(() => D.hunkPatch("", 0), /No existe el fragmento 1/);
  // A patch from an old diff no longer applies to the index.
  const text = await Q.fileDiff(git, d, "big.txt", "unstaged");
  writeFileSync(patchFile, D.hunkPatch(text, 0));
  await O.applyHunk(git, (await ctx(d)).repo, patchFile);
  let err;
  try { await O.applyHunk(git, (await ctx(d)).repo, patchFile); } catch (e) { err = e; }
  assert.ok(err, "applying the same hunk twice must fail");
  assert.match(explain(err), /El archivo cambió desde que se mostró el diff/);
});
