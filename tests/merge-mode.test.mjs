// Fast-forward explanations and the per-repository merge mode.
//   node --test tests/merge-mode.test.mjs
// Throwaway repositories only, deleted afterwards.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const MOD = join(homedir(), ".config/herdr-app/mods/git-panel/git");
const { Runner } = await import(join(MOD, "runner.js"));
const Q = await import(join(MOD, "queries.js"));
const O = await import(join(MOD, "ops.js"));
const F = await import(join(MOD, "merge-flow.js"));

const TMP = realpathSync(mkdtempSync(join(tmpdir(), "git panel ff ")));
after(() => rmSync(TMP, { recursive: true, force: true }));

const ENV = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const exec = (cmd, args, { cwd, timeout }) => new Promise((resolve) => {
  execFile(cmd, args, { cwd, timeout, env: ENV, maxBuffer: 8 << 20 }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }));
});
const git = new Runner({ exec, platform: "macos", onLog: () => {} });
const sh = async (cwd, ...args) => { const r = await exec("git", args, { cwd }); if (r.code) throw new Error(`git ${args.join(" ")}: ${r.stderr}`); return r.stdout; };
const exists = async () => false;

let n = 0;
async function makeRepo() {
  const dir = join(TMP, `repo ${++n}`);
  mkdirSync(dir);
  await sh(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "uno\n");
  await sh(dir, "add", "-A"); await sh(dir, "commit", "-qm", "base");
  return dir;
}
async function commit(dir, file, text, msg) { writeFileSync(join(dir, file), text); await sh(dir, "add", "--", file); await sh(dir, "commit", "-qm", msg); }
async function ctx(dir) {
  const repo = await Q.detect(git, dir);
  const [status, refs, ops] = await Promise.all([Q.status(git, repo.root), Q.refs(git, repo.root), Q.inProgress(git, repo.root, exists)]);
  return { repo, status, refs, ops, drafts: {} };
}
/** main + dev two commits ahead of it (fast-forward possible). */
async function ffRepo() {
  const dir = await makeRepo();
  await sh(dir, "switch", "-qc", "dev");
  await commit(dir, "b.txt", "b\n", "add b");
  await commit(dir, "c.txt", "c\n", "add c");
  await sh(dir, "switch", "-q", "main");
  return dir;
}
const parents = async (dir, rev) => (await sh(dir, "rev-list", "--parents", "-n", "1", rev)).trim().split(" ").length - 1;

test("preview line: ff and ff-only explain the missing merge commit; no-ff says it will be visible", async () => {
  const dir = await ffRepo();
  const p = await F.preview(git, { ...(await ctx(dir)), source: "dev", target: "main" });
  assert.equal(p.ff, true);
  const sha = p.sourceSha.slice(0, 7);
  for (const mode of ["ff", "ff-only"]) {
    const line = F.ffPreviewLine(p, mode);
    assert.match(line, new RegExp(`main avanzará a ${sha}, sin commit de merge`));
    assert.match(line, /Siempre crear commit de merge/);
  }
  assert.match(F.ffPreviewLine(p, "no-ff"), /Se creará un commit de merge.*visible en el grafo/);
});

test("preview line: nothing to explain when the branches diverged", async () => {
  const dir = await ffRepo();
  await commit(dir, "m.txt", "m\n", "main only");
  const p = await F.preview(git, { ...(await ctx(dir)), source: "dev", target: "main" });
  assert.equal(p.ff, false);
  assert.equal(F.ffPreviewLine(p, "ff"), null);
});

test("result line names the branch and the new HEAD", () => {
  assert.equal(F.ffResultLine("dev", "7f7e9f6abcdef0123"),
    `dev avanzó a 7f7e9f6, sin commit de merge; elige "Siempre crear commit de merge" si quieres verlo en el grafo.`);
});

test("ff leaves no merge commit; no-ff creates one with two parents", async () => {
  const a = await ffRepo();
  await O.merge(git, (await ctx(a)).repo, "dev", "ff");
  assert.equal(await Q.revParse(git, a, "main"), await Q.revParse(git, a, "dev"));
  assert.equal(await parents(a, "main"), 1);

  const b = await ffRepo();
  await O.merge(git, (await ctx(b)).repo, "dev", "no-ff");
  assert.notEqual(await Q.revParse(git, b, "main"), await Q.revParse(git, b, "dev"));
  assert.equal(await parents(b, "main"), 2);
});

test("modeFor: remembered mode applies only when a fast-forward is possible", () => {
  const ff = { ff: true }, div = { ff: false };
  assert.equal(F.modeFor(ff, null), "ff");
  assert.equal(F.modeFor(ff, "no-ff"), "no-ff");
  assert.equal(F.modeFor(ff, "ff-only"), "ff-only");
  assert.equal(F.modeFor(ff, "rebase"), "ff", "unknown values fall back");
  assert.equal(F.modeFor(div, "ff-only"), "ff", "ff-only would fail on divergent branches");
  assert.equal(F.modeFor(div, "no-ff"), "ff");
  assert.equal(F.modeFor(null, "no-ff"), "ff");
});

test("shouldRemember: merges where the choice mattered, never Pull", () => {
  assert.equal(F.shouldRemember("A", { ff: true }), true);
  assert.equal(F.shouldRemember("B", { ff: true }), true);
  assert.equal(F.shouldRemember("pull", { ff: true }), false);
  assert.equal(F.shouldRemember("A", { ff: false }), false);
});

test("modeKey is shared by a repository's worktrees and separate per machine and repo", async () => {
  const dir = await ffRepo();
  const wt = join(TMP, `wt ${n}`);
  await sh(dir, "worktree", "add", "-q", wt, "dev");
  const main = (await ctx(dir)).repo, linked = (await ctx(wt)).repo;
  assert.equal(F.modeKey(main, null), F.modeKey(linked, null));
  assert.notEqual(F.modeKey(main, null), F.modeKey(main, "server"));
  const other = (await ctx(await makeRepo())).repo;
  assert.notEqual(F.modeKey(main, null), F.modeKey(other, null));
});

test("revalidation that turns a fast-forward into a divergent merge resets ff-only, and the merge succeeds", async () => {
  const dir = await ffRepo();
  const c = await ctx(dir);
  const old = await F.preview(git, { ...c, source: "dev", target: "main" });
  let mode = F.modeFor(old, "ff-only");
  assert.equal(mode, "ff-only");
  await commit(dir, "agent.txt", "x\n", "an agent commits on main"); // between preview and confirm
  const rv = await F.revalidate(git, { ...(await ctx(dir)), source: "dev", target: "main" }, old);
  assert.equal(rv.same, false);
  mode = F.modeFor(rv.fresh, mode);
  assert.equal(mode, "ff");
  const r = await O.merge(git, (await ctx(dir)).repo, "dev", mode);
  assert.equal(r.conflicts, false);
  assert.equal(await parents(dir, "main"), 2);
});
