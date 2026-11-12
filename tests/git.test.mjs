// Runs the mod's pure Git layer against throwaway repositories.
//   node --test ~/herdr-git-panel-dev/test/
// Every repo lives under a fresh mkdtemp folder (with a space and Unicode in
// its name) and is deleted afterwards. Nothing touches a real project.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const MOD = join(homedir(), ".config/herdr-app/mods/git-panel/git");
const { Runner, displayArgv } = await import(join(MOD, "runner.js"));
const Q = await import(join(MOD, "queries.js"));
const O = await import(join(MOD, "ops.js"));
const F = await import(join(MOD, "merge-flow.js"));
const { explain } = await import(join(MOD, "errors.js"));

const LINKED = mkdtempSync(join(tmpdir(), "git panel ñ ")), TMP = realpathSync(LINKED);
after(() => rmSync(TMP, { recursive: true, force: true }));
assert.notEqual(LINKED, TMP, "macOS tmp is a symlink: the alias test below relies on it");

const ENV = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const exec = (cmd, args, { cwd, timeout }) => new Promise((resolve) => {
  execFile(cmd, args, { cwd, timeout, env: ENV, maxBuffer: 8 << 20 }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }));
});
const logs = [];
const git = new Runner({ exec, platform: "macos", onLog: (e) => logs.push(e) });
const exists = async (p) => existsSync(p);
const sh = async (cwd, ...args) => { const r = await exec("git", args, { cwd }); if (r.code) throw new Error(`git ${args.join(" ")}: ${r.stderr}`); return r.stdout; };

let n = 0;
async function makeRepo() {
  const dir = join(TMP, `repo ${++n} — ü`);
  mkdirSync(dir);
  await sh(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "uno\ndos\ntres\n");
  writeFileSync(join(dir, "con espacio.txt"), "x\n");
  await sh(dir, "add", "-A"); await sh(dir, "commit", "-qm", "base");
  return dir;
}
async function commit(dir, file, text, msg) { writeFileSync(join(dir, file), text); await sh(dir, "add", "--", file); await sh(dir, "commit", "-qm", msg); }
async function ctx(dir, extra = {}) {
  const repo = await Q.detect(git, dir);
  const [status, refs, ops] = await Promise.all([Q.status(git, repo.root), Q.refs(git, repo.root), Q.inProgress(git, repo.root, exists)]);
  return { repo, status, refs, ops, drafts: {}, ...extra };
}

test("detect, status with spaces and unicode, refs", async () => {
  const dir = await makeRepo();
  writeFileSync(join(dir, "nuevo ñandú.txt"), "hola\n");
  writeFileSync(join(dir, "con espacio.txt"), "y\n");
  const c = await ctx(dir);
  assert.equal(c.repo.root, dir);
  assert.equal(c.repo.linked, false);
  assert.equal(c.status.head, "main");
  assert.deepEqual(c.status.files.map((f) => f.path).sort(), ["con espacio.txt", "nuevo ñandú.txt"]);
  assert.equal(c.status.summary.untracked, 1);
  assert.equal(c.status.summary.unstaged, 1);
  assert.equal(c.refs.find((r) => r.current).name, "main");
  assert.equal(await Q.detect(git, TMP), null);
});

test("safe checkout: clean switch, then verify HEAD", async () => {
  const dir = await makeRepo();
  await sh(dir, "branch", "feature/login");
  const c = await ctx(dir);
  const chk = F.checkoutCheck({ ...c, target: "feature/login" });
  assert.deepEqual(chk.blocks, []);
  const repo = c.repo;
  await O.switchBranch(git, repo, "feature/login");
  assert.equal((await Q.status(git, dir)).head, "feature/login");
});

test("fast-forward: preview says ff, merge advances main", async () => {
  const dir = await makeRepo();
  await sh(dir, "switch", "-qc", "feature/login");
  await commit(dir, "login.txt", "login\n", "add login");
  await sh(dir, "switch", "-q", "main");
  const c = await ctx(dir);
  const p = await F.preview(git, { ...c, source: "feature/login", target: "main" });
  assert.equal(p.ff, true); assert.equal(p.incomingCount, 1); assert.deepEqual(p.blocks, []);
  assert.equal(p.sim, null, "ff needs no simulation");
  assert.deepEqual(p.files.map((f) => f.path), ["login.txt"]);
  const r = await O.merge(git, c.repo, "feature/login", "ff");
  assert.equal(r.conflicts, false);
  assert.equal(await Q.revParse(git, dir, "main"), await Q.revParse(git, dir, "feature/login"));
});

test("divergent merge without conflicts: simulated clean, merge commit created", async () => {
  const dir = await makeRepo();
  await sh(dir, "switch", "-qc", "feature/x");
  await commit(dir, "x.txt", "x\n", "x");
  await sh(dir, "switch", "-q", "main");
  await commit(dir, "m.txt", "m\n", "m");
  const c = await ctx(dir);
  const p = await F.preview(git, { ...c, source: "feature/x", target: "main" });
  assert.equal(p.ff, false); assert.equal(p.targetOnly, 1); assert.equal(p.sim.clean, true);
  const r = await O.merge(git, c.repo, "feature/x", "ff");
  assert.equal(r.conflicts, false);
  const [head] = await Q.log(git, dir, { limit: 1 });
  assert.equal(head.parents.length, 2);
});

test("conflict: predicted, merge stops, detected in progress, abort restores", async () => {
  const dir = await makeRepo();
  await sh(dir, "switch", "-qc", "feature/c");
  await commit(dir, "a.txt", "uno\nDOS rama\ntres\n", "rama");
  await sh(dir, "switch", "-q", "main");
  await commit(dir, "a.txt", "uno\nDOS main\ntres\n", "main");
  const before = await Q.revParse(git, dir, "HEAD");
  const c = await ctx(dir);
  const p = await F.preview(git, { ...c, source: "feature/c", target: "main" });
  assert.equal(p.sim.clean, false);
  assert.deepEqual(p.sim.conflicts, ["a.txt"]);
  assert.ok(p.warnings.some((w) => w.id === "conflicts-expected"));
  const r = await O.merge(git, c.repo, "feature/c", "ff");
  assert.equal(r.conflicts, true);
  assert.deepEqual(await Q.inProgress(git, dir, exists), ["merge"]);
  const st = await Q.status(git, dir);
  assert.equal(st.summary.conflicts, 1);
  // While merging, both entry points refuse.
  const c2 = await ctx(dir);
  assert.ok(F.checkoutCheck({ ...c2, target: "feature/c" }).blocks.some((b) => b.id === "in-progress"));
  await O.mergeAbort(git, c.repo);
  assert.deepEqual(await Q.inProgress(git, dir, exists), []);
  assert.equal(await Q.revParse(git, dir, "HEAD"), before);
});

test("dirty work tree: overlap blocks, unrelated warns, staged blocks; nothing is stashed", async () => {
  const dir = await makeRepo();
  await sh(dir, "switch", "-qc", "f");
  await commit(dir, "a.txt", "uno\ndos\ntres\ncuatro\n", "f");
  await sh(dir, "switch", "-q", "main");
  writeFileSync(join(dir, "a.txt"), "local\n");
  let p = await F.preview(git, { ...(await ctx(dir)), source: "f", target: "main" });
  assert.ok(p.blocks.some((b) => b.id === "dirty-overlap"));
  await sh(dir, "checkout", "--", "a.txt");
  writeFileSync(join(dir, "con espacio.txt"), "local\n");
  p = await F.preview(git, { ...(await ctx(dir)), source: "f", target: "main" });
  assert.deepEqual(p.blocks, []);
  assert.ok(p.warnings.some((w) => w.id === "dirty"));
  await sh(dir, "add", "--", "con espacio.txt");
  p = await F.preview(git, { ...(await ctx(dir)), source: "f", target: "main" });
  assert.ok(p.blocks.some((b) => b.id === "staged"));
  assert.equal((await sh(dir, "stash", "list")).trim(), "");
  // Checkout check warns but does not block on dirty files; git itself refuses on collision.
  await sh(dir, "reset", "-q", "--", "con espacio.txt");
  const chk = F.checkoutCheck({ ...(await ctx(dir)), target: "f" });
  assert.deepEqual(chk.blocks, []); assert.ok(chk.warnings.some((w) => w.id === "dirty"));
  writeFileSync(join(dir, "a.txt"), "colisión\n");
  await assert.rejects(O.switchBranch(git, (await ctx(dir)).repo, "f"), (e) => /sobrescribir cambios locales/.test(explain(e)));
  assert.equal((await Q.status(git, dir)).head, "main");
});

test("worktrees: branch used elsewhere is detected and blocks checkout", async () => {
  const dir = await makeRepo();
  await sh(dir, "branch", "wt-branch");
  const wt = join(TMP, `wt ${n} ö`);
  await sh(dir, "worktree", "add", "-q", wt, "wt-branch");
  const c = await ctx(dir);
  const ref = c.refs.find((r) => r.name === "wt-branch");
  assert.equal(ref.worktree, wt);
  const chk = F.checkoutCheck({ ...c, target: "wt-branch" });
  assert.equal(chk.otherWorktree, wt);
  assert.ok(chk.blocks.some((b) => b.id === "worktree"));
  const list = await Q.worktrees(git, dir);
  assert.deepEqual(list.map((w) => w.branch), ["main", "wt-branch"]);
  const linked = await Q.detect(git, wt);
  assert.equal(linked.linked, true); assert.equal(linked.commonDir, c.repo.commonDir);
  await assert.rejects(O.switchBranch(git, c.repo, "wt-branch"), (e) => /otro worktree/.test(explain(e)));
  // Entry A works in the other worktree itself (no checkout needed there).
  await commit(dir, "m2.txt", "m\n", "m2");
  const p = await F.preview(git, { ...(await ctx(wt)), source: "main", target: "wt-branch" });
  assert.equal(p.ff, true);
});

test("revalidation catches an agent committing between preview and merge", async () => {
  const dir = await makeRepo();
  await sh(dir, "switch", "-qc", "s");
  await commit(dir, "s.txt", "1\n", "s1");
  await sh(dir, "switch", "-q", "main");
  const c = await ctx(dir);
  const p = await F.preview(git, { ...c, source: "s", target: "main" });
  const same = await F.revalidate(git, { ...(await ctx(dir)), source: "s", target: "main" }, p);
  assert.equal(same.same, true);
  await sh(dir, "branch", "-f", "s", "s"); // no-op
  await sh(dir, "update-ref", "refs/heads/s", (await sh(dir, "commit-tree", "-p", "s", "-m", "agent", "s^{tree}")).trim());
  const moved = await F.revalidate(git, { ...(await ctx(dir)), source: "s", target: "main" }, p);
  assert.equal(moved.same, false);
  assert.equal(moved.fresh.incomingCount, 2);
});

test("unsaved editor drafts inside the repo block both flows", async () => {
  const dir = await makeRepo();
  await sh(dir, "branch", "b");
  const drafts = { [join(dir, "a.txt")]: { text: "x", baseline: "y" }, "/elsewhere/z.txt": {} };
  const c = await ctx(dir, { drafts });
  assert.ok(F.checkoutCheck({ ...c, target: "b" }).blocks.some((b) => b.id === "unsaved"));
  assert.deepEqual(F.unsavedIn(dir, drafts), [join(dir, "a.txt")]);
  // The editor may know the file through a symlinked spelling of the folder.
  const viaLink = dir.replace(TMP, LINKED), aliased = { [join(viaLink, "a.txt")]: {} };
  assert.deepEqual(F.unsavedIn(dir, aliased), []);
  const c2 = await ctx(dir, { drafts: aliased });
  c2.repo.aliases = [viaLink];
  assert.ok(F.checkoutCheck({ ...c2, target: "b" }).blocks.some((b) => b.id === "unsaved"));
});

test("up to date and unrelated histories are blocked", async () => {
  const dir = await makeRepo();
  await sh(dir, "branch", "same");
  let p = await F.preview(git, { ...(await ctx(dir)), source: "same", target: "main" });
  assert.ok(p.blocks.some((b) => b.id === "up-to-date"));
  await sh(dir, "switch", "-q", "--orphan", "lonely");
  await commit(dir, "o.txt", "o\n", "orphan");
  await sh(dir, "switch", "-q", "main");
  p = await F.preview(git, { ...(await ctx(dir)), source: "lonely", target: "main" });
  assert.ok(p.blocks.some((b) => b.id === "unrelated"));
});

test("branches: create (validated), rename, safe delete refuses unmerged", async () => {
  const dir = await makeRepo();
  const { repo } = await ctx(dir);
  assert.equal(await Q.checkBranchName(git, dir, "bad..name"), false);
  assert.equal(await Q.checkBranchName(git, dir, "-x"), false);
  assert.equal(await Q.checkBranchName(git, dir, "feature/ok"), true);
  await O.createBranch(git, repo, "feature/ok", "main", true);
  await commit(dir, "k.txt", "k\n", "k");
  await O.renameBranch(git, repo, "feature/ok", "feature/renamed");
  await sh(dir, "switch", "-q", "main");
  await assert.rejects(O.deleteBranch(git, repo, "feature/renamed"), (e) => /no están integrados/.test(explain(e)));
  assert.ok((await Q.refs(git, dir)).some((r) => r.name === "feature/renamed"));
});

test("fetch from a local remote, upstream ahead/behind, no prompts", async () => {
  const dir = await makeRepo();
  const bare = join(TMP, `remote ${n}.git`);
  await sh(TMP, "init", "-q", "--bare", "-b", "main", bare);
  await sh(dir, "remote", "add", "origin", bare);
  await sh(dir, "push", "-qu", "origin", "main");
  const other = join(TMP, `clone ${n}`);
  await sh(TMP, "clone", "-q", bare, other);
  await commit(other, "r.txt", "r\n", "remote work");
  await sh(other, "push", "-q");
  const { repo } = await ctx(dir);
  await O.fetch(git, repo, "origin");
  const last = logs.at(-1);
  assert.equal(last.argv[0], "env"); assert.equal(last.argv[1], "GIT_TERMINAL_PROMPT=0");
  const st = await Q.status(git, dir);
  assert.equal(st.upstream, "origin/main"); assert.equal(st.behind, 1); assert.equal(st.ahead, 0);
  const main = (await Q.refs(git, dir)).find((r) => r.name === "main" && r.type === "local");
  assert.equal(main.behind, 1);
  const p = await F.preview(git, { ...(await ctx(dir)), source: "origin/main", target: "main" });
  assert.equal(p.ff, true);
  assert.ok(!p.warnings.some((w) => w.id === "target-behind"), "integrating its own upstream is the update itself");
});

test("history: pages, decorations and tags", async () => {
  const dir = await makeRepo();
  for (let i = 0; i < 5; i++) await commit(dir, "h.txt", `${i}\n`, `c${i} con "comillas" y ñ`);
  await sh(dir, "tag", "v1.0");
  const p1 = await Q.log(git, dir, { limit: 3 }), p2 = await Q.log(git, dir, { skip: 3, limit: 3 });
  assert.equal(p1.length, 3); assert.equal(p2.length, 3);
  assert.ok(p1[0].refs.some((r) => r.kind === "head" && r.name === "main"));
  assert.ok(p1[0].refs.some((r) => r.kind === "tag" && r.name === "v1.0"));
  assert.equal(p1[0].subject, `c4 con "comillas" y ñ`);
  const files = await Q.commitFiles(git, dir, p1[0].hash);
  assert.deepEqual(files, [{ status: "M", path: "h.txt" }]);
});

test("errors read as sentences; argv is displayed quoted", () => {
  assert.match(explain({ stderr: "fatal: Unable to create '/r/.git/index.lock': File exists." }), /Otro proceso de Git/);
  assert.match(explain({ stderr: "fatal: 'main' is already used by worktree at '/tmp/wt'" }), /otro worktree/);
  assert.equal(displayArgv(["git", "--no-optional-locks", "-c", "core.quotePath=false", "commit", "-m", "it's ok"]), `git commit -m 'it'\\''s ok'`);
});

test("a draft identical to the file on disk is not unsaved", async () => {
  const dir = await makeRepo();
  await sh(dir, "branch", "b");
  const same = join(dir, "a.txt"), diff = join(dir, "con espacio.txt");
  const drafts = { [same]: { text: "uno\ndos\ntres\n", baseline: "" }, [diff]: { text: "otra cosa\n", baseline: "x\n" } };
  const { readFile } = await import("node:fs/promises");
  const real = await F.realDrafts(drafts, (p) => readFile(p, "utf8"));
  assert.deepEqual(Object.keys(real), [diff]);
  const chk = F.checkoutCheck({ ...(await ctx(dir, { drafts: real })), target: "b" });
  assert.ok(chk.blocks.some((b) => b.id === "unsaved" && b.text.includes("con espacio.txt") && !b.text.includes("a.txt,")));
});

test("editor left with another branch's version after a checkout: warns, never blocks", async () => {
  const { createHash } = await import("node:crypto");
  const { readFile } = await import("node:fs/promises");
  const dir = await makeRepo();
  // Same blob id as git hash-object, including non-ASCII text.
  const sample = "ñandú — línea\n";
  writeFileSync(join(dir, "probe.txt"), sample);
  assert.equal(F.blobId(sample, createHash, (t) => Buffer.from(t, "utf8")), (await sh(dir, "hash-object", "probe.txt")).trim());
  rmSync(join(dir, "probe.txt"));
  // lote.md differs between dev and main; the editor keeps dev's text open.
  await sh(dir, "switch", "-qc", "dev");
  await commit(dir, "lote.md", "versión de dev\n", "dev lote");
  await sh(dir, "switch", "-q", "main");
  await commit(dir, "lote.md", "versión de main\n", "main lote");
  await sh(dir, "branch", "qa");
  const lote = join(dir, "lote.md");
  const known = async (_p, text) => (await git.read(dir, ["cat-file", "-e", F.blobId(text, createHash, (t) => Buffer.from(t, "utf8"))], { expected: [0, 1, 128] })).code === 0;
  const read = (p) => readFile(p, "utf8");
  let real = await F.realDrafts({ [lote]: { text: "versión de dev\n", baseline: "" } }, read, known);
  assert.equal(real[lote].stale, true);
  let chk = F.checkoutCheck({ ...(await ctx(dir, { drafts: real })), target: "qa" });
  assert.ok(!chk.blocks.some((b) => b.id === "unsaved"));
  assert.ok(chk.warnings.some((w) => w.id === "stale-editor"));
  // Real unsaved work (text Git has never seen) still blocks.
  real = await F.realDrafts({ [lote]: { text: "algo que escribí y no guardé\n", baseline: "versión de main\n" } }, read, known);
  assert.ok(!real[lote].stale);
  chk = F.checkoutCheck({ ...(await ctx(dir, { drafts: real })), target: "qa" });
  assert.ok(chk.blocks.some((b) => b.id === "unsaved"));
});
