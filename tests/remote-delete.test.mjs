// Deleting a branch on origin: checks, the exact command, and the race guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { MODS, Q, O, F, git, sh, exec, commit, ctx, withRemote } from "./helpers/repo.mjs";

const { explain } = await import(join(MODS, "git-panel/git/errors.js"));

/** origin with main (default) and feature; a teammate clone. */
async function setup() {
  const { src, bare } = await withRemote();
  await sh(bare, "symbolic-ref", "HEAD", "refs/heads/main");
  await sh(src, "remote", "set-head", "origin", "main");
  await sh(src, "switch", "-qc", "feature"); await commit(src, "f.txt", "f\n", "feature work");
  await sh(src, "push", "-q", "-u", "origin", "feature"); await sh(src, "switch", "-q", "main");
  const mate = bare + "-mate";
  await sh(src, "clone", "-q", bare, mate);
  return { src, bare, mate };
}
const check = async (d, name) => {
  const c = await ctx(d), ref = c.refs.find((r) => r.type === "remote" && r.name === name) ?? null;
  const only = ref ? await Q.onlyIn(git, d, ref.ref) : 0;
  return { c, ref, chk: F.remoteDeleteCheck({ refs: c.refs, remotes: await Q.remotes(git, d), ref, head: await Q.remoteHead(git, d, "origin"), only }) };
};

test("the remote's default branch is blocked", async () => {
  const { src } = await setup();
  assert.equal(await Q.remoteHead(git, src, "origin"), "origin/main");
  const { chk } = await check(src, "origin/main");
  assert.deepEqual(chk.blocks.map((b) => b.id), ["default"]);
  assert.deepEqual(chk.warnings, [], "only the block is shown");
});

test("a branch whose commits a local branch still has: warns it is tracked, no second confirmation", async () => {
  const { src } = await setup();
  const { chk } = await check(src, "origin/feature");
  assert.deepEqual(chk.blocks, []);
  assert.equal(chk.needsSecond, false);
  assert.deepEqual(chk.warnings.map((w) => w.id), ["tracked", "team"]);
  assert.equal(chk.command, "git push origin --delete refs/heads/feature");
});

test("commits that exist only on the remote branch need a second confirmation", async () => {
  const { src, mate } = await setup();
  await sh(mate, "switch", "-q", "feature"); await commit(mate, "m.txt", "m\n", "mate work"); await sh(mate, "push", "-q", "origin", "feature");
  await O.fetch(git, (await ctx(src)).repo, "origin");
  const { chk } = await check(src, "origin/feature");
  assert.equal(chk.needsSecond, true);
  assert.match(chk.warnings.find((w) => w.id === "only").text, /^1 commit\(s\) solo están en origin\/feature/);
});

test("delete: the remote loses the branch, the local branch and its commits stay", async () => {
  const { src, bare } = await setup();
  const before = (await sh(src, "rev-parse", "feature")).trim();
  assert.equal(await Q.remoteBranchSha(git, src, "origin", "feature"), before);
  await O.deleteRemoteBranch(git, (await ctx(src)).repo, "origin", "feature");
  assert.equal((await exec("git", ["rev-parse", "--verify", "-q", "refs/heads/feature"], { cwd: bare })).code, 1);
  assert.equal(await Q.remoteBranchSha(git, src, "origin", "feature"), null);
  assert.equal((await sh(src, "rev-parse", "feature")).trim(), before);
  assert.equal((await exec("git", ["rev-parse", "--verify", "-q", "refs/remotes/origin/feature"], { cwd: src })).code, 1, "git push removes the tracking ref too");
  const logged = (await import("./helpers/repo.mjs")).logs.filter((e) => e.argv.includes("--delete"));
  assert.ok(logged.length >= 1, "the command is in the panel's log");
  assert.ok(!logged.some((e) => e.argv.some((a) => /^--force|^-f$/.test(a))), "never a force push");
});

test("race guard: if someone pushed after the check, the sha differs; an already deleted branch is detected first", async () => {
  const { src, mate } = await setup();
  const seen = (await sh(src, "rev-parse", "origin/feature")).trim();
  await sh(mate, "switch", "-q", "feature"); await commit(mate, "late.txt", "x\n", "late push"); await sh(mate, "push", "-q", "origin", "feature");
  const now = await Q.remoteBranchSha(git, src, "origin", "feature");
  assert.notEqual(now, seen, "the panel compares these and refuses");
  await O.deleteRemoteBranch(git, (await ctx(src)).repo, "origin", "feature");
  // Already gone: the panel asks ls-remote first and says so instead of pushing.
  assert.equal(await Q.remoteBranchSha(git, src, "origin", "feature"), null);
  assert.match(explain({ stderr: "error: unable to delete 'feature': remote ref does not exist" }), /ya no existe en el remoto/);
});

test("a server refusal (protected branch) reads as a sentence", () => {
  assert.match(explain({ stderr: " ! [remote rejected] feature (protected branch hook declined)" }), /rechazó eliminar la rama/);
});
