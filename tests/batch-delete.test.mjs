// Several branches at once: ⌘/⇧-click selection, which ones -d takes, and the
// sequential run that never leaves commits without a branch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { MODS, Q, O, F, git, sh, exec, commit, ctx, withRemote } from "./helpers/repo.mjs";

const SEL = await import(join(MODS, "git-panel/git/selection.js"));
const order = ["g:local", "refs/heads/a", "refs/heads/b", "refs/heads/c", "g:origin", "refs/remotes/origin/a", "refs/heads/d"];

test("selection: plain click, ⌘ toggles, ⇧ takes a range of local branches only", () => {
  let s = SEL.clickSelect(null, "refs/heads/a", order, {});
  assert.deepEqual(s, { selected: ["refs/heads/a"], anchor: "refs/heads/a", multi: false });
  s = SEL.clickSelect(s, "refs/heads/c", order, { platform: true });
  assert.deepEqual(s.selected, ["refs/heads/a", "refs/heads/c"]); assert.equal(s.multi, true);
  s = SEL.clickSelect(s, "refs/heads/a", order, { platform: true });
  assert.deepEqual(s.selected, ["refs/heads/c"]);
  s = SEL.clickSelect({ selected: ["refs/heads/a"], anchor: "refs/heads/a" }, "refs/heads/d", order, { shift: true });
  assert.deepEqual(s.selected, ["refs/heads/a", "refs/heads/b", "refs/heads/c", "refs/heads/d"], "groups and remote rows are skipped");
  s = SEL.clickSelect(s, "refs/remotes/origin/a", order, { platform: true });
  assert.deepEqual(s, { selected: ["refs/remotes/origin/a"], anchor: "refs/remotes/origin/a", multi: false }, "a remote row is a single selection");
  assert.deepEqual(SEL.keepExisting(["refs/heads/a", "refs/heads/gone"], ["refs/heads/a"]), ["refs/heads/a"]);
});

/** origin; main; done1, done2 merged and pushed; wip pushed but not merged; local-only merged branch. */
async function setup() {
  const { src, bare } = await withRemote();
  await sh(src, "remote", "set-head", "origin", "main");
  for (const b of ["done1", "done2"]) { await sh(src, "switch", "-qc", b, "main"); await commit(src, `${b}.txt`, b, b); await sh(src, "push", "-q", "-u", "origin", b); }
  await sh(src, "switch", "-qc", "wip", "main"); await commit(src, "w.txt", "w", "wip"); await sh(src, "push", "-q", "-u", "origin", "wip");
  await sh(src, "switch", "-q", "main");
  await sh(src, "merge", "-q", "--no-ff", "-m", "m1", "done1"); await sh(src, "merge", "-q", "--no-ff", "-m", "m2", "done2"); await sh(src, "push", "-q", "origin", "main");
  await sh(src, "branch", "-q", "plain", "main");
  return { src, bare };
}
async function rowsFor(d, names) {
  const c = await ctx(d), merged = {}, pairs = {}, shas = {};
  for (const n of names) {
    const l = c.refs.find((r) => r.type === "local" && r.name === n);
    if (!l) continue;
    const up = l.upstream ? c.refs.find((r) => r.type === "remote" && r.name === l.upstream) ?? null : null;
    merged[n] = (await Q.isAncestor(git, d, l.ref, "HEAD")) || Boolean(up && await Q.isAncestor(git, d, l.ref, up.ref));
    if (up) { pairs[n] = F.pairDeleteCheck({ local: l, upstreamRef: up, head: "origin/main", only: await Q.onlyIn(git, d, [l.ref, up.ref]) }); shas[n] = up.oid; }
  }
  return { rows: F.batchDeleteRows({ names, refs: c.refs, root: d, merged, pairs }), shas, repo: c.repo };
}
const has = async (cwd, ref) => (await exec("git", ["rev-parse", "--verify", "-q", ref], { cwd })).code === 0;

test("batch rows: merged ones go (with their upstream offered), the current and unmerged are skipped", async () => {
  const { src } = await setup();
  const { rows } = await rowsFor(src, ["done1", "done2", "plain", "main", "wip"]);
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.deepEqual(["done1", "done2", "plain"].map((n) => by[n].ok), [true, true, true]);
  assert.equal(by.done1.pair.enabled, true);
  assert.equal(by.plain.pair, null, "no upstream, nothing to offer");
  assert.equal(by.main.reason, "es la rama actual");
  assert.equal(by.wip.ok, true, "-d accepts it: it is merged into its upstream");
  assert.equal(by.wip.pair.enabled, false, "but deleting both would orphan its commit");
});

test("run: locals with -d, remotes only where ticked and safe; the rest stays", async () => {
  const { src, bare } = await setup();
  const { rows, shas, repo } = await rowsFor(src, ["done1", "done2", "plain", "wip"]);
  const ticked = { done1: true, done2: false };
  for (const r of rows.filter((x) => x.ok)) {
    await O.deleteBranch(git, repo, r.name, false);
    if (ticked[r.name] && r.pair?.enabled) {
      assert.equal(await Q.remoteBranchSha(git, src, r.pair.remote, r.pair.branch), shas[r.name]);
      assert.equal(await Q.onlyIn(git, src, `refs/remotes/origin/${r.name}`), 0);
      await O.deleteRemoteBranch(git, repo, r.pair.remote, r.pair.branch);
    }
  }
  for (const n of ["done1", "done2", "plain", "wip"]) assert.equal(await has(src, `refs/heads/${n}`), false, `local ${n} deleted`);
  assert.equal(await has(bare, "refs/heads/done1"), false, "ticked upstream deleted");
  assert.equal(await has(bare, "refs/heads/done2"), true, "unticked upstream kept");
  assert.equal(await has(bare, "refs/heads/wip"), true, "unsafe upstream kept: its commit is still on the remote");
});

test("two stacked branches merged only into their upstreams: the second remote is refused once the first is gone", async () => {
  const { src } = await withRemote();
  await sh(src, "switch", "-qc", "a"); await commit(src, "a.txt", "a", "a"); await sh(src, "push", "-q", "-u", "origin", "a");
  await sh(src, "switch", "-qc", "b"); await commit(src, "b.txt", "b", "b"); await sh(src, "push", "-q", "-u", "origin", "b");
  await sh(src, "switch", "-q", "main");
  const { rows, repo } = await rowsFor(src, ["a", "b"]);
  // a's commit is also in b, so a's pair looks safe; b's is not.
  assert.equal(rows[0].pair.enabled, true);
  assert.equal(rows[1].pair.enabled, false);
  await O.deleteBranch(git, repo, "a", false);
  await O.deleteRemoteBranch(git, repo, "origin", "a");
  await O.deleteBranch(git, repo, "b", false);
  // The panel's final guard before b's remote: a's and b's commits would be orphaned.
  assert.equal(await Q.onlyIn(git, src, "refs/remotes/origin/b"), 2);
});
