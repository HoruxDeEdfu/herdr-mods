// Stage 2: stage/unstage/commit, diffs, push/pull checks. Throwaway repos only.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync, realpathSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const MOD = join(homedir(), ".config/herdr-app/mods/git-panel/git");
const { Runner } = await import(join(MOD, "runner.js"));
const Q = await import(join(MOD, "queries.js"));
const O = await import(join(MOD, "ops.js"));
const F = await import(join(MOD, "merge-flow.js"));
const D = await import(join(MOD, "diff.js"));
const { explain } = await import(join(MOD, "errors.js"));

const TMP = realpathSync(mkdtempSync(join(tmpdir(), "git panel s2 ")));
after(() => rmSync(TMP, { recursive: true, force: true }));
const ENV = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const exec = (cmd, args, { cwd, timeout }) => new Promise((res) => execFile(cmd, args, { cwd, timeout, env: ENV, maxBuffer: 8 << 20 }, (e, stdout, stderr) => res({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout, stderr })));
const git = new Runner({ exec, platform: "macos" });
const exists = async (p) => existsSync(p);
const sh = async (cwd, ...a) => { const r = await exec("git", a, { cwd }); if (r.code) throw new Error(r.stderr); return r.stdout; };
let n = 0;
async function repo(withCommit = true) {
  const dir = join(TMP, `r${++n} ñ`); mkdirSync(dir);
  await sh(dir, "init", "-q", "-b", "main");
  if (withCommit) { writeFileSync(join(dir, "a b.txt"), "uno\ndos\n"); writeFileSync(join(dir, "gone.txt"), "x\n"); await sh(dir, "add", "-A"); await sh(dir, "commit", "-qm", "base"); }
  return { dir, r: await Q.detect(git, dir) };
}
const ctx = async (dir) => { const r = await Q.detect(git, dir); return { repo: r, status: await Q.status(git, dir), refs: await Q.refs(git, dir), ops: await Q.inProgress(git, dir, exists), remotes: await Q.remotes(git, dir), drafts: {} }; };

test("stage / unstage: modified, new, deleted, names with spaces; commit", async () => {
  const { dir, r } = await repo();
  writeFileSync(join(dir, "a b.txt"), "uno\nDOS\n");
  writeFileSync(join(dir, "nuevo ñ.txt"), "hola\n");
  unlinkSync(join(dir, "gone.txt"));
  await O.stage(git, r, ["a b.txt", "nuevo ñ.txt", "gone.txt"]);
  let st = await Q.status(git, dir);
  assert.equal(st.summary.staged, 3); assert.equal(st.summary.unstaged, 0);
  await O.unstage(git, r, ["nuevo ñ.txt"], true);
  st = await Q.status(git, dir);
  assert.equal(st.summary.staged, 2); assert.equal(st.summary.untracked, 1);
  assert.equal(readFileSync(join(dir, "nuevo ñ.txt"), "utf8"), "hola\n", "unstage never touches the file");
  await O.commit(git, r, "cambio con \"comillas\" y\n\nsegunda línea");
  const [c] = await Q.log(git, dir, { limit: 1 });
  assert.equal(c.subject, 'cambio con "comillas" y');
  assert.match(await Q.commitBody(git, dir, c.hash), /segunda línea/);
});

test("unstage before the first commit", async () => {
  const { dir } = await repo(false);
  const r = await Q.detect(git, dir);
  writeFileSync(join(dir, "x.txt"), "x\n");
  await O.stage(git, r, ["x.txt"]);
  await O.unstage(git, r, ["x.txt"], false);
  assert.equal((await Q.status(git, dir)).summary.untracked, 1);
});

test("diffs: unstaged, staged, untracked, commit, range; parsed rows", async () => {
  const { dir, r } = await repo();
  writeFileSync(join(dir, "a b.txt"), "uno\ndos\ntres\n");
  let rows = D.diffRows(await Q.fileDiff(git, dir, "a b.txt", "unstaged"));
  assert.equal(rows.adds, 1); assert.equal(rows.dels, 0);
  assert.deepEqual(rows.rows.filter((x) => x.kind === "+").map((x) => [x.b, x.text]), [[3, "tres"]]);
  await O.stage(git, r, ["a b.txt"]);
  assert.equal(D.diffRows(await Q.fileDiff(git, dir, "a b.txt", "staged")).adds, 1);
  assert.equal(D.diffRows(await Q.fileDiff(git, dir, "a b.txt", "unstaged")).rows.length, 0);
  writeFileSync(join(dir, "nuevo ñ.txt"), "a\nb\n");
  assert.equal(D.diffRows(await Q.fileDiff(git, dir, "nuevo ñ.txt", "untracked")).adds, 2);
  await O.commit(git, r, "tres");
  const [c] = await Q.log(git, dir, { limit: 1 });
  assert.equal(D.diffRows(await Q.fileDiff(git, dir, "a b.txt", { to: c.hash })).adds, 1);
  assert.equal(D.diffRows(await Q.fileDiff(git, dir, "a b.txt", { from: "HEAD~1", to: "HEAD" })).adds, 1);
  writeFileSync(join(dir, "bin.dat"), Buffer.from([0, 1, 2, 0, 255]));
  assert.equal(D.diffRows(await Q.fileDiff(git, dir, "bin.dat", "untracked")).binary, true);
});

test("conflict markers and resolving a conflict by staging", async () => {
  const { dir, r } = await repo();
  await sh(dir, "switch", "-qc", "f"); writeFileSync(join(dir, "a b.txt"), "uno\nF\n"); await sh(dir, "commit", "-qam", "f");
  await sh(dir, "switch", "-q", "main"); writeFileSync(join(dir, "a b.txt"), "uno\nM\n"); await sh(dir, "commit", "-qam", "m");
  assert.equal((await O.merge(git, r, "f", "ff")).conflicts, true);
  assert.equal(D.hasConflictMarkers(readFileSync(join(dir, "a b.txt"), "utf8")), true);
  writeFileSync(join(dir, "a b.txt"), "uno\nM y F\n");
  assert.equal(D.hasConflictMarkers(readFileSync(join(dir, "a b.txt"), "utf8")), false);
  await O.stage(git, r, ["a b.txt"]);
  assert.equal((await Q.status(git, dir)).summary.conflicts, 0);
  assert.match(await Q.mergeMessage(git, dir, exists, async (p) => readFileSync(p, "utf8")), /Merge branch 'f'/);
  await O.commit(git, r, null); // concludes the merge with Git's message
  assert.deepEqual(await Q.inProgress(git, dir, exists), []);
  const [c] = await Q.log(git, dir, { limit: 1 });
  assert.equal(c.parents.length, 2);
});

test("push: publish a new branch, push ahead, refuse when behind (no force)", async () => {
  const { dir, r } = await repo();
  const bare = join(TMP, `remote${n}.git`);
  await sh(TMP, "init", "-q", "--bare", "-b", "main", bare);
  await sh(dir, "remote", "add", "origin", bare);
  let c = await ctx(dir);
  let p = F.pushCheck(c);
  assert.equal(p.setUpstream, true); assert.equal(p.remote, "origin"); assert.deepEqual(p.blocks, []);
  await O.push(git, r, p.remote, p.branch, p.setUpstream);
  c = await ctx(dir);
  assert.equal(c.status.upstream, "origin/main");
  assert.ok(F.pushCheck(c).blocks.some((b) => b.id === "nothing"));
  writeFileSync(join(dir, "n.txt"), "n\n"); await sh(dir, "add", "-A"); await sh(dir, "commit", "-qm", "n");
  c = await ctx(dir); p = F.pushCheck(c);
  assert.equal(p.ahead, 1); assert.deepEqual(p.blocks, []);
  await O.push(git, r, p.remote, p.branch, false);
  // Someone else pushes; we commit locally: behind and ahead → blocked, and git itself refuses.
  const other = join(TMP, `clone${n}`); await sh(TMP, "clone", "-q", bare, other);
  writeFileSync(join(other, "o.txt"), "o\n"); await sh(other, "add", "-A"); await sh(other, "commit", "-qm", "o"); await sh(other, "push", "-q");
  writeFileSync(join(dir, "l.txt"), "l\n"); await sh(dir, "add", "-A"); await sh(dir, "commit", "-qm", "l");
  await O.fetch(git, r, "origin");
  c = await ctx(dir);
  assert.ok(F.pushCheck(c).blocks.some((b) => b.id === "behind"));
  await assert.rejects(O.push(git, r, "origin", "main", false), (e) => /rechaz|rejected|fetch first|Git:/i.test(explain(e) + e.stderr));
  // Pull plan: integrate origin/main through the merge preview.
  const pc = F.pullCheck(c);
  assert.deepEqual(pc.blocks, []); assert.equal(pc.upstream, "origin/main");
  const pv = await F.preview(git, { ...c, source: pc.upstream, target: "main" });
  assert.equal(pv.ff, false); assert.equal(pv.incomingCount, 1); assert.equal(pv.sim.clean, true);
});
