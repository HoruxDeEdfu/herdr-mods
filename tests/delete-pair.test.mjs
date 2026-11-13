// Deleting a local branch can also delete its upstream: offered unticked, only when safe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Q, O, F, git, sh, exec, commit, ctx, withRemote } from "./helpers/repo.mjs";

async function setup() {
  const { src, bare } = await withRemote();
  await sh(src, "remote", "set-head", "origin", "main");
  await sh(src, "switch", "-qc", "feature"); await commit(src, "f.txt", "f\n", "feature work");
  await sh(src, "push", "-q", "-u", "origin", "feature"); await sh(src, "switch", "-q", "main");
  return { src, bare };
}
async function pair(d, name) {
  const c = await ctx(d);
  const local = c.refs.find((r) => r.type === "local" && r.name === name);
  const up = local?.upstream ? c.refs.find((r) => r.type === "remote" && r.name === local.upstream) ?? null : null;
  const only = up ? await Q.onlyIn(git, d, [local.ref, up.ref]) : 0;
  return F.pairDeleteCheck({ local, upstreamRef: up, head: await Q.remoteHead(git, d, "origin"), only });
}
const exists = async (cwd, ref) => (await exec("git", ["rev-parse", "--verify", "-q", ref], { cwd })).code === 0;

test("no upstream, or upstream gone: nothing to offer", async () => {
  const { src } = await setup();
  await sh(src, "switch", "-qc", "solo"); await sh(src, "switch", "-q", "main");
  assert.equal(await pair(src, "solo"), null);
  await sh(src, "push", "-q", "origin", "--delete", "feature"); await sh(src, "fetch", "-q", "--prune", "origin");
  assert.equal(await pair(src, "feature"), null);
});

test("commits only in the branch and its upstream: offered but disabled (deleting both would orphan them)", async () => {
  const { src } = await setup();
  const p = await pair(src, "feature");
  assert.equal(p.enabled, false);
  assert.match(p.reason, /^1 commit\(s\) solo están en feature y origin\/feature/);
});

test("merged into main: enabled; local -d then remote delete leaves main intact", async () => {
  const { src, bare } = await setup();
  await sh(src, "merge", "-q", "--no-ff", "-m", "merge feature", "feature"); await sh(src, "push", "-q", "origin", "main");
  const p = await pair(src, "feature");
  assert.deepEqual([p.enabled, p.remote, p.branch, p.command], [true, "origin", "feature", "git push origin --delete refs/heads/feature"]);
  const sha = (await sh(src, "rev-parse", "origin/feature")).trim();
  const repo = (await ctx(src)).repo;
  await O.deleteBranch(git, repo, "feature");
  assert.equal(await Q.remoteBranchSha(git, src, "origin", "feature"), sha, "race guard sees the same commit");
  assert.equal(await Q.onlyIn(git, src, "refs/remotes/origin/feature"), 0, "final guard: nothing would be orphaned");
  await O.deleteRemoteBranch(git, repo, "origin", "feature");
  assert.equal(await exists(bare, "refs/heads/feature"), false);
  assert.equal(await exists(bare, "refs/heads/main"), true);
});

test("the remote's default branch is never offered as deletable", async () => {
  const { src } = await setup();
  await sh(src, "branch", "-q", "--track", "main-copy", "origin/main");
  const p = await pair(src, "main-copy");
  assert.equal(p.enabled, false);
  assert.match(p.reason, /rama principal de origin/);
});

test("a -d refusal leaves the remote alone (the panel only deletes it after -d worked)", async () => {
  const { src, bare } = await setup();
  await sh(src, "switch", "-q", "feature"); await commit(src, "g.txt", "g\n", "unpushed"); await sh(src, "switch", "-q", "main");
  let err; try { await O.deleteBranch(git, (await ctx(src)).repo, "feature"); } catch (e) { err = e; }
  assert.match(err.stderr, /not fully merged/);
  assert.equal(await exists(bare, "refs/heads/feature"), true);
});
