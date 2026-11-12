// Stage 3: graph lanes, cherry-pick, revert, conflict sides, worktrees. Throwaway repos only.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const MOD = join(homedir(), ".config/herdr-app/mods/git-panel/git");
const { Runner } = await import(join(MOD, "runner.js"));
const Q = await import(join(MOD, "queries.js"));
const O = await import(join(MOD, "ops.js"));
const F = await import(join(MOD, "merge-flow.js"));
const { layoutGraph } = await import(join(MOD, "graph.js"));
const { explain } = await import(join(MOD, "errors.js"));

const TMP = realpathSync(mkdtempSync(join(tmpdir(), "git panel s3 ")));
after(() => rmSync(TMP, { recursive: true, force: true }));
const ENV = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const exec = (cmd, args, { cwd, timeout }) => new Promise((res) => execFile(cmd, args, { cwd, timeout, env: ENV, maxBuffer: 8 << 20 }, (e, stdout, stderr) => res({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout, stderr })));
const git = new Runner({ exec, platform: "macos" });
const exists = async (p) => existsSync(p);
const sh = async (cwd, ...a) => { const r = await exec("git", a, { cwd }); if (r.code) throw new Error(r.stderr); return r.stdout; };
let n = 0;
async function repo() {
  const dir = join(TMP, `r${++n} ñ`); mkdirSync(dir);
  await sh(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "1\n2\n3\n"); await sh(dir, "add", "-A"); await sh(dir, "commit", "-qm", "base");
  return dir;
}
const commit = async (dir, f, text, m) => { writeFileSync(join(dir, f), text); await sh(dir, "add", "-A"); await sh(dir, "commit", "-qm", m); };
const ctx = async (dir) => { const r = await Q.detect(git, dir); return { repo: r, status: await Q.status(git, dir), refs: await Q.refs(git, dir), ops: await Q.inProgress(git, dir, exists), drafts: {} }; };
const byHash = async (dir, rev) => (await Q.log(git, dir, { rev, limit: 1 }))[0];

test("graph: linear, branch + merge, lanes reused", () => {
  const lin = layoutGraph([{ hash: "c", parents: ["b"] }, { hash: "b", parents: ["a"] }, { hash: "a", parents: [] }]);
  assert.deepEqual(lin.map((r) => r.col), [0, 0, 0]);
  assert.deepEqual(lin[0].top, []); assert.deepEqual(lin[2].bottom, []);
  // M merges F into main:  M(parents: m1, f1), f1(base), m1(base), base
  const g = layoutGraph([
    { hash: "M", parents: ["m1", "f1"] }, { hash: "f1", parents: ["base"] }, { hash: "m1", parents: ["base"] }, { hash: "base", parents: [] }]);
  assert.equal(g[0].col, 0); assert.deepEqual(g[0].links, [1]); assert.deepEqual(g[0].bottom, [0, 1]);
  assert.equal(g[1].col, 1);
  assert.equal(g[2].col, 0); assert.deepEqual(g[2].top, [0, 1]);
  assert.equal(g[3].col, 0); assert.deepEqual(g[3].links, [1], "the side lane ends at the fork point");
  assert.ok(g.every((r) => r.lanes <= 2));
});

test("graph on a real repo with merges stays narrow", async () => {
  const dir = await repo();
  for (let i = 0; i < 4; i++) {
    await sh(dir, "switch", "-qc", `f${i}`); await commit(dir, `f${i}.txt`, `${i}\n`, `f${i}`);
    await sh(dir, "switch", "-q", "main"); await commit(dir, `m${i}.txt`, `${i}\n`, `m${i}`);
    await sh(dir, "merge", "-q", "--no-edit", `f${i}`);
  }
  const g = layoutGraph(await Q.log(git, dir, { limit: 100 }));
  assert.ok(Math.max(...g.map((r) => r.lanes)) <= 2);
});

test("cherry-pick: clean, already included, empty, conflict + abort", async () => {
  const dir = await repo();
  await sh(dir, "switch", "-qc", "f"); await commit(dir, "b.txt", "b\n", "add b"); await commit(dir, "a.txt", "1\nF\n3\n", "f edits a");
  await sh(dir, "switch", "-q", "main"); await commit(dir, "a.txt", "1\nM\n3\n", "main edits a");
  const addB = await byHash(dir, "f~1"), editA = await byHash(dir, "f");
  let c = await ctx(dir);
  let p = await F.pickPreview(git, { ...c, commit: addB, revert: false });
  assert.deepEqual(p.blocks, []); assert.equal(p.sim.clean, true);
  assert.equal((await O.cherryPick(git, c.repo, addB.hash)).conflicts, false);
  c = await ctx(dir);
  p = await F.pickPreview(git, { ...c, commit: addB, revert: false });
  assert.ok(p.blocks.some((b) => b.id === "empty"), "same change already applied");
  p = await F.pickPreview(git, { ...c, commit: await byHash(dir, "main~1"), revert: false });
  assert.ok(p.blocks.some((b) => b.id === "already"));
  p = await F.pickPreview(git, { ...c, commit: editA, revert: false });
  assert.equal(p.sim.clean, false); assert.deepEqual(p.sim.conflicts, ["a.txt"]);
  const before = await Q.revParse(git, dir, "HEAD");
  assert.equal((await O.cherryPick(git, c.repo, editA.hash)).conflicts, true);
  assert.deepEqual(await Q.inProgress(git, dir, exists), ["cherry-pick"]);
  await O.abortOp(git, c.repo, "cherry-pick");
  assert.deepEqual(await Q.inProgress(git, dir, exists), []);
  assert.equal(await Q.revParse(git, dir, "HEAD"), before);
});

test("cherry-pick conflict resolved with one side, then continue", async () => {
  const dir = await repo();
  await sh(dir, "switch", "-qc", "f"); await commit(dir, "a.txt", "1\nF\n3\n", "f");
  await sh(dir, "switch", "-q", "main"); await commit(dir, "a.txt", "1\nM\n3\n", "m");
  const c = await ctx(dir);
  await O.cherryPick(git, c.repo, (await byHash(dir, "f")).hash);
  await O.resolveWith(git, c.repo, "a.txt", "theirs");
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "1\nF\n3\n");
  assert.equal((await Q.status(git, dir)).summary.conflicts, 0);
  await O.continueOp(git, c.repo, "cherry-pick");
  assert.deepEqual(await Q.inProgress(git, dir, exists), []);
  assert.equal((await byHash(dir, "HEAD")).subject, "f");
});

test("revert: normal commit, merge commit (-m 1), not in branch, merge conflict 'ours'", async () => {
  const dir = await repo();
  await commit(dir, "x.txt", "x\n", "add x");
  let c = await ctx(dir);
  const addX = await byHash(dir, "HEAD");
  let p = await F.pickPreview(git, { ...c, commit: addX, revert: true });
  assert.deepEqual(p.blocks, []); assert.equal(p.sim.clean, true);
  await O.revert(git, c.repo, addX.hash, null);
  assert.equal(existsSync(join(dir, "x.txt")), false);
  await sh(dir, "switch", "-qc", "g"); await commit(dir, "g.txt", "g\n", "g");
  await sh(dir, "switch", "-q", "main"); await commit(dir, "h.txt", "h\n", "h"); await sh(dir, "merge", "-q", "--no-edit", "g");
  c = await ctx(dir);
  const merge = await byHash(dir, "HEAD");
  p = await F.pickPreview(git, { ...c, commit: merge, revert: true });
  assert.equal(p.mainline, 1); assert.ok(p.warnings.some((w) => w.id === "merge-commit"));
  await O.revert(git, c.repo, merge.hash, p.mainline);
  assert.equal(existsSync(join(dir, "g.txt")), false); assert.equal(existsSync(join(dir, "h.txt")), true);
  await sh(dir, "switch", "-qc", "other", "HEAD~3"); await commit(dir, "o.txt", "o\n", "o");
  const o = await byHash(dir, "HEAD"); await sh(dir, "switch", "-q", "main");
  p = await F.pickPreview(git, { ...(await ctx(dir)), commit: o, revert: true });
  assert.ok(p.blocks.some((b) => b.id === "not-in-head"));
  // A merge conflict resolved with "ours" keeps HEAD's version.
  await sh(dir, "switch", "-qc", "k"); await commit(dir, "a.txt", "1\nK\n3\n", "k");
  await sh(dir, "switch", "-q", "main"); await commit(dir, "a.txt", "1\nMAIN\n3\n", "main a");
  c = await ctx(dir);
  await O.merge(git, c.repo, "k", "ff");
  await O.resolveWith(git, c.repo, "a.txt", "ours");
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "1\nMAIN\n3\n");
  await O.commit(git, c.repo, null);
  assert.deepEqual(await Q.inProgress(git, dir, exists), []);
});

test("pick blocked by dirty overlap, staged files and work in progress", async () => {
  const dir = await repo();
  await sh(dir, "switch", "-qc", "f"); await commit(dir, "a.txt", "1\n2\n3\n4\n", "f");
  await sh(dir, "switch", "-q", "main");
  const f = await byHash(dir, "f");
  writeFileSync(join(dir, "a.txt"), "local\n");
  let p = await F.pickPreview(git, { ...(await ctx(dir)), commit: f, revert: false });
  assert.ok(p.blocks.some((b) => b.id === "dirty-overlap"));
  await sh(dir, "add", "a.txt");
  p = await F.pickPreview(git, { ...(await ctx(dir)), commit: f, revert: false });
  assert.ok(p.blocks.some((b) => b.id === "staged"));
});

test("worktrees: Herdr path, add new/existing branch, remove refuses dirty and main, prune", async () => {
  const dir = await repo();
  const c = await ctx(dir);
  assert.equal(F.worktreePath("/home/u", c.repo.commonDir, "feature/Login ñ"), `/home/u/.herdr/worktrees/${dir.split("/").pop()}/feature-Login`);
  const base = join(TMP, "wts");
  const p1 = join(base, "nueva rama"), p2 = join(base, "existente");
  await O.worktreeAdd(git, c.repo, p1, "nueva", true, "HEAD");
  await sh(dir, "branch", "existente");
  await O.worktreeAdd(git, c.repo, p2, "existente", false);
  let wts = await Q.worktrees(git, dir);
  assert.equal(wts[0].branch, "main", "the main worktree comes first");
  assert.deepEqual(wts.map((w) => w.branch).sort(), ["existente", "main", "nueva"]);
  assert.ok(F.worktreeRemoveCheck({ repo: c.repo, worktrees: wts, target: dir }).blocks.some((b) => b.id === "main"));
  writeFileSync(join(p1, "sucio.txt"), "x\n");
  assert.deepEqual(F.worktreeRemoveCheck({ repo: c.repo, worktrees: wts, target: p1 }).blocks, []);
  await assert.rejects(O.worktreeRemove(git, c.repo, p1), (e) => /untracked|modified|Git:/i.test(e.stderr + explain(e)));
  assert.ok(existsSync(join(p1, "sucio.txt")), "nothing was deleted");
  await O.worktreeRemove(git, c.repo, p2);
  assert.equal(existsSync(p2), false);
  assert.ok((await Q.refs(git, dir)).some((r) => r.name === "existente"), "branch kept");
  rmSync(p1, { recursive: true, force: true });
  wts = await Q.worktrees(git, dir);
  assert.ok(wts.find((w) => w.branch === "nueva").prunable);
  await O.worktreePrune(git, c.repo);
  assert.deepEqual((await Q.worktrees(git, dir)).map((w) => w.branch), ["main"]);
});

test("conflict rows: ours/theirs/base sections and markers", async () => {
  const { conflictRows } = await import(join(MOD, "diff.js"));
  const r = conflictRows("a\n<<<<<<< HEAD\nmine\n||||||| base\nold\n=======\nyours\n>>>>>>> f\nz\n");
  assert.deepEqual(r.rows.map((x) => x.kind), [" ", "@", "o", "@", "b", "@", "t", "@", " "]);
  assert.deepEqual(r.rows.map((x) => x.b), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(conflictRows("x\n===== no\n").rows.map((x) => x.kind), [" ", " "]);
});

test("branch behind origin: fast-forward without checkout; diverged, current and worktree are refused; push a non-current branch", async () => {
  const dir = await repo();
  const bare = join(TMP, `ff-remote${n}.git`), other = join(TMP, `ff-other${n}`);
  await sh(TMP, "init", "-q", "--bare", "-b", "main", bare);
  await sh(dir, "remote", "add", "origin", bare);
  await sh(dir, "switch", "-qc", "qa"); await commit(dir, "q.txt", "q\n", "qa base");
  await sh(dir, "push", "-qu", "origin", "main", "qa");
  await sh(dir, "push", "-q", "origin", "qa");
  await sh(dir, "branch", "-u", "origin/qa", "qa");
  await sh(dir, "switch", "-q", "main"); await sh(dir, "branch", "-u", "origin/main", "main");
  await sh(TMP, "clone", "-q", "-b", "qa", bare, other);
  for (let i = 0; i < 3; i++) await commit(other, "q.txt", `q${i}\n`, `remoto qa ${i}`);
  await sh(other, "push", "-q");
  const r = (await ctx(dir)).repo;
  await O.fetch(git, r, "origin");
  let c = await ctx(dir);
  let ff = F.fastForwardCheck({ ...c, branch: "qa" });
  assert.deepEqual(ff.blocks, []); assert.equal(ff.behind, 3); assert.equal(ff.upstream, "origin/qa");
  const head = await Q.revParse(git, dir, "HEAD");
  await O.fastForwardBranch(git, r, "qa", ff.upstream);
  assert.equal(await Q.revParse(git, dir, "qa"), await Q.revParse(git, dir, "origin/qa"));
  assert.equal(await Q.revParse(git, dir, "HEAD"), head, "HEAD and the work tree never move");
  assert.equal((await Q.status(git, dir)).head, "main");
  c = await ctx(dir);
  assert.ok(F.fastForwardCheck({ ...c, branch: "qa" }).blocks.some((b) => b.id === "up-to-date"));
  assert.ok(F.fastForwardCheck({ ...c, branch: "main" }).blocks.some((b) => b.id === "current"));
  // Diverged: a local commit on qa plus a new remote one.
  await sh(dir, "switch", "-q", "qa"); await commit(dir, "local.txt", "l\n", "local qa"); await sh(dir, "switch", "-q", "main");
  await commit(other, "q.txt", "q9\n", "remoto qa 9"); await sh(other, "push", "-q");
  await O.fetch(git, r, "origin");
  c = await ctx(dir);
  assert.ok(F.fastForwardCheck({ ...c, branch: "qa" }).blocks.some((b) => b.id === "diverged"));
  // Git itself refuses a non fast-forward even if asked.
  await assert.rejects(O.fastForwardBranch(git, r, "qa", "origin/qa"));
  // Push a branch that isn't checked out.
  await sh(dir, "switch", "-qc", "solo-local"); await commit(dir, "s.txt", "s\n", "s"); await sh(dir, "switch", "-q", "main");
  c = await ctx(dir);
  const p = F.pushCheck({ ...c, remotes: ["origin"], branch: "solo-local" });
  assert.deepEqual(p.blocks, []); assert.equal(p.setUpstream, true); assert.equal(p.branch, "solo-local");
  await O.push(git, r, p.remote, p.branch, true);
  assert.equal((await Q.refs(git, dir)).find((x) => x.name === "solo-local" && x.type === "local").upstream, "origin/solo-local");
});

test("pull decision: up to date → message, clean fast-forward → direct, anything else → preview", async () => {
  const dir = await repo();
  const bare = join(TMP, `pd-remote${n}.git`), other = join(TMP, `pd-other${n}`);
  await sh(TMP, "init", "-q", "--bare", "-b", "main", bare);
  await sh(dir, "remote", "add", "origin", bare); await sh(dir, "push", "-qu", "origin", "main");
  await sh(TMP, "clone", "-q", bare, other);
  const pv = async () => { const c = await ctx(dir); return F.preview(git, { ...c, source: "origin/main", target: "main" }); };
  assert.equal(F.pullDecision(await pv()), "up-to-date");
  await commit(other, "r.txt", "r\n", "remote"); await sh(other, "push", "-q");
  await O.fetch(git, (await ctx(dir)).repo, "origin");
  writeFileSync(join(dir, "a.txt"), "1\n2\n3\nlocal unrelated\n"); // a local edit the pull doesn't touch
  assert.equal(F.pullDecision(await pv()), "fast");
  writeFileSync(join(dir, "r.txt"), "untracked clash\n"); // the pull would overwrite this → review
  assert.equal(F.pullDecision(await pv()), "review");
  rmSync(join(dir, "r.txt"));
  await O.merge(git, (await ctx(dir)).repo, "origin/main", "ff-only");
  assert.equal(await Q.revParse(git, dir, "main"), await Q.revParse(git, dir, "origin/main"));
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "1\n2\n3\nlocal unrelated\n", "local edit kept");
  await commit(dir, "l.txt", "l\n", "local"); await commit(other, "r2.txt", "r\n", "remote 2"); await sh(other, "push", "-q");
  await O.fetch(git, (await ctx(dir)).repo, "origin");
  assert.equal(F.pullDecision(await pv()), "review", "diverged needs a merge commit: preview");
});
