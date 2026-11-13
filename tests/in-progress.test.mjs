// Rebase and bisect in progress: read, continue, abort; labels; unsaved editor work blocks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Q, O, F, git, sh, exec, makeRepo, commit, ctx, exists } from "./helpers/repo.mjs";

const read = async (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
/** feature (2 commits) rebased onto main, where main changed the same line → stops at commit 1/2. */
async function stoppedRebase() {
  const d = await makeRepo();
  await sh(d, "switch", "-qc", "feature");
  await commit(d, "a.txt", "uno\nFEATURE\ntres\n", "feature edits line 2");
  await commit(d, "f.txt", "f\n", "feature adds f");
  await sh(d, "switch", "-q", "main");
  await commit(d, "a.txt", "uno\nMAIN\ntres\n", "main edits line 2");
  await sh(d, "switch", "-q", "feature");
  const r = await exec("git", ["rebase", "main"], { cwd: d });
  assert.notEqual(r.code, 0, "the rebase must stop on the conflict");
  return d;
}

test("rebaseInfo: branch, onto (by name) and progress; null without a rebase", async () => {
  const d = await stoppedRebase();
  const c = await ctx(d);
  assert.deepEqual(c.ops, ["rebase"]);
  const info = await Q.rebaseInfo(git, d, read);
  assert.equal(info.branch, "feature");
  assert.equal(info.ontoName, "main");
  assert.equal(info.onto, (await sh(d, "rev-parse", "main")).trim());
  assert.deepEqual([info.step, info.total], [1, 2]);
  assert.equal(await Q.rebaseInfo(git, await makeRepo(), read), null);
});

test("rebase: labels are swapped (ours = the base); continue blocked by conflicts, then finishes", async () => {
  const d = await stoppedRebase();
  const info = await Q.rebaseInfo(git, d, read);
  const L = F.sideLabels("rebase", null, info);
  assert.equal(L.ours, "main (base del rebase)");
  assert.equal(L.theirs, "tu commit de feature");
  assert.equal(F.sideLabels("merge", "main").ours, "main");
  let c = await ctx(d);
  assert.deepEqual(F.inProgressCheck(c, "continue").blocks.map((b) => b.id), ["conflicts"]);
  await O.resolveWith(git, c.repo, "a.txt", "theirs"); // the feature's version
  c = await ctx(d);
  const chk = F.inProgressCheck(c, "continue");
  assert.deepEqual(chk.blocks, []);
  assert.equal(chk.command, "git -c core.editor=true rebase --continue");
  assert.deepEqual(await O.continueOp(git, c.repo, "rebase"), { conflicts: false });
  assert.deepEqual(await Q.inProgress(git, d, exists), []);
  assert.equal(readFileSync(join(d, "a.txt"), "utf8"), "uno\nFEATURE\ntres\n");
  assert.equal((await sh(d, "rev-list", "--count", "main..feature")).trim(), "2");
  assert.equal((await sh(d, "merge-base", "main", "feature")).trim(), (await sh(d, "rev-parse", "main")).trim());
});

test("rebase continue that stops again reports conflicts instead of failing", async () => {
  const d = await makeRepo();
  await sh(d, "switch", "-qc", "feature");
  await commit(d, "a.txt", "uno\nF1\ntres\n", "f1");
  await commit(d, "a.txt", "uno\nF2\ntres\n", "f2");
  await sh(d, "switch", "-q", "main");
  await commit(d, "a.txt", "uno\nMAIN\ntres\n", "main");
  await sh(d, "switch", "-q", "feature");
  await exec("git", ["rebase", "main"], { cwd: d });
  const c = await ctx(d);
  await O.resolveWith(git, c.repo, "a.txt", "ours"); // keep main's line → f2 now conflicts with it
  assert.deepEqual(await O.continueOp(git, c.repo, "rebase"), { conflicts: true });
  assert.deepEqual((await ctx(d)).ops, ["rebase"]);
  assert.deepEqual([(await Q.rebaseInfo(git, d, read)).step, (await Q.rebaseInfo(git, d, read)).total], [2, 2]);
});

test("rebase abort puts the branch back exactly where it was", async () => {
  const d = await stoppedRebase();
  const before = (await sh(d, "rev-parse", "ORIG_HEAD")).trim();
  const c = await ctx(d);
  const chk = F.inProgressCheck(c, "abort");
  assert.deepEqual(chk.blocks, []);
  assert.equal(chk.command, "git rebase --abort");
  assert.match(chk.detail, /tus commits originales siguen intactos/);
  await O.abortOp(git, c.repo, "rebase");
  assert.deepEqual(await Q.inProgress(git, d, exists), []);
  assert.equal((await sh(d, "rev-parse", "feature")).trim(), before);
  assert.equal((await sh(d, "symbolic-ref", "--short", "HEAD")).trim(), "feature");
});

test("unsaved editor drafts block continue and abort of a rebase", async () => {
  const d = await stoppedRebase();
  const c = await ctx(d, { drafts: { [join(d, "a.txt")]: { text: "mine" } } });
  assert.ok(F.inProgressCheck(c, "abort").blocks.some((b) => b.id === "unsaved"));
  assert.ok(F.inProgressCheck(c, "continue").blocks.some((b) => b.id === "unsaved"));
});

test("bisect: detected, ended with bisect reset back on the branch", async () => {
  const d = await makeRepo();
  await commit(d, "b.txt", "1\n", "c1"); await commit(d, "b.txt", "2\n", "c2"); await commit(d, "b.txt", "3\n", "c3");
  await sh(d, "bisect", "start", "HEAD", "HEAD~3");
  let c = await ctx(d);
  assert.deepEqual(c.ops, ["bisect"]);
  const chk = F.inProgressCheck(c, "abort");
  assert.equal(chk.command, "git bisect reset");
  assert.equal(chk.title, "¿Terminar el bisect?");
  assert.ok(F.inProgressCheck(c, "continue").blocks.some((b) => b.id === "unsupported"));
  await O.abortOp(git, c.repo, "bisect");
  c = await ctx(d);
  assert.deepEqual(c.ops, []);
  assert.equal(c.status.head, "main");
});

test("an empty commit after resolving reads as a sentence", async () => {
  const { explain } = await import(join(process.env.HOME, ".config/herdr-app/mods/git-panel/git/errors.js"));
  assert.match(explain({ stderr: "No changes - did you forget to use 'git add'?" }), /commit vacío/);
  assert.equal(explain(Object.assign(new Error("Hay 1 archivo(s) sin guardar"), { plain: true })), "Hay 1 archivo(s) sin guardar");
});
