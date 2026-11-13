// Read-only questions about a repository. Pure (runner + exists injected).
import { parseStatus, parseRefs, parseWorktrees, parseLog, parseNameStatus, parseMergeTree, parseLeftRight, summarize, REF_FORMAT, LOG_FORMAT } from "./parse.js";
import { GitError } from "./runner.js";

/** Where the repository is: worktree root, its git dir and the shared common dir. */
export async function detect(git, cwd) {
  const r = await git.read(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir", "--show-prefix"], { expected: [0, 128] });
  if (r.code !== 0) return null;
  const [root, gitDir, commonDir, prefix = ""] = r.stdout.split("\n");
  if (!root) return null;
  // The folder as the pane spells it (through a symlink, say): the editor's paths use it.
  const trimmed = cwd.replace(/[\\/]+$/, ""), sub = prefix.replace(/\/$/, "");
  const alias = sub && trimmed.endsWith("/" + sub) ? trimmed.slice(0, -(sub.length + 1)) : sub ? null : trimmed;
  return { root, gitDir, commonDir, linked: gitDir !== commonDir, aliases: alias && alias !== root ? [alias] : [] };
}

const MARKERS = [
  ["merge", "MERGE_HEAD"], ["cherry-pick", "CHERRY_PICK_HEAD"], ["revert", "REVERT_HEAD"],
  ["rebase", "rebase-merge/head-name"], ["rebase", "rebase-apply/head-name"], ["bisect", "BISECT_LOG"],
];

/** Operations Git has left in progress here (merge, rebase, cherry-pick, revert, bisect). */
export async function inProgress(git, root, exists) {
  const args = ["rev-parse", "--path-format=absolute"];
  for (const [, p] of MARKERS) args.push("--git-path", p);
  const r = await git.read(root, args);
  if (r.code !== 0) return [];
  const paths = r.stdout.split("\n");
  const found = [];
  for (let i = 0; i < MARKERS.length; i++) if (paths[i] && await exists(paths[i]) && !found.includes(MARKERS[i][0])) found.push(MARKERS[i][0]);
  return found;
}

export async function status(git, root) {
  const out = await git.readOk(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
  const st = parseStatus(out);
  st.summary = summarize(st.files);
  return st;
}

export async function refs(git, root) {
  return parseRefs(await git.readOk(root, ["for-each-ref", `--format=${REF_FORMAT}`, "refs/heads", "refs/remotes", "refs/tags"]));
}

export async function remotes(git, root) {
  const r = await git.read(root, ["remote"]);
  return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
}

export async function worktrees(git, root) {
  const r = await git.read(root, ["worktree", "list", "--porcelain", "-z"]);
  return r.code === 0 ? parseWorktrees(r.stdout) : [];
}

/** A page of history. `all`: every branch, else from HEAD. */
export async function log(git, root, { skip = 0, limit = 200, all = false, rev = null } = {}) {
  const args = ["log", "-z", "--topo-order", `--format=${LOG_FORMAT}`, `--skip=${skip}`, `-n`, String(limit)];
  if (all) args.push("--branches", "--remotes", "--tags", "HEAD");
  else if (rev) args.push(rev);
  args.push("--");
  const r = await git.read(root, args);
  if (r.code !== 0) {
    if (/does not have any commits|bad default revision|unknown revision/i.test(r.stderr)) return [];
    throw new GitError(r, args);
  }
  return parseLog(r.stdout);
}

/** Files a commit changed (against its first parent). */
export async function commitFiles(git, root, hash) {
  return parseNameStatus(await git.readOk(root, ["show", "--name-status", "-z", "--format=", "-m", "--first-parent", hash, "--"]));
}

export async function commitBody(git, root, hash) {
  const r = await git.read(root, ["show", "-s", "--format=%B", hash, "--"]);
  return r.code === 0 ? r.stdout.trim() : "";
}

export async function revParse(git, root, rev) {
  const r = await git.read(root, ["rev-parse", "-q", "--verify", `${rev}^{commit}`], { expected: [0, 1] });
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function isAncestor(git, root, a, b) {
  const r = await git.read(root, ["merge-base", "--is-ancestor", a, b], { expected: [0, 1] });
  return r.code === 0;
}

export async function mergeBase(git, root, a, b) {
  const r = await git.read(root, ["merge-base", a, b], { expected: [0, 1] });
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function leftRight(git, root, a, b) {
  return parseLeftRight(await git.readOk(root, ["rev-list", "--left-right", "--count", `${a}...${b}`, "--"]));
}

/** Commits in `to` that `from` doesn't have, newest first. */
export async function between(git, root, from, to, limit = 50) {
  return parseLog(await git.readOk(root, ["log", "-z", `--format=${LOG_FORMAT}`, "-n", String(limit), `${from}..${to}`, "--"]));
}

export async function changedFiles(git, root, from, to) {
  return parseNameStatus(await git.readOk(root, ["diff", "--name-status", "-z", "--no-renames", from, to, "--"]));
}

/** Simulates the merge without touching the work tree or index (git ≥ 2.38). */
export async function simulateMerge(git, root, ours, theirs) {
  const r = await git.read(root, ["merge-tree", "--write-tree", "--name-only", "--messages", ours, theirs], { expected: [0, 1] });
  if (r.code === 0 || r.code === 1) return { ok: true, clean: r.code === 0, ...parseMergeTree(r.stdout) };
  return { ok: false, error: (r.stderr || "").trim() };
}

export async function checkBranchName(git, root, name) {
  const r = await git.read(root, ["check-ref-format", "--branch", name], { expected: [0, 1, 128] });
  return r.code === 0;
}

/**
 * A file's diff as text. which: "staged" (index vs HEAD), "unstaged" (work
 * tree vs index), "untracked" (new file vs nothing), or a range { from, to }
 * (to: a commit; with from null it's that commit against its first parent).
 */
export async function fileDiff(git, root, path, which) {
  let args;
  if (which === "staged") args = ["diff", "--cached", "--no-ext-diff", "--no-renames", "--", path];
  else if (which === "unstaged") args = ["diff", "--no-ext-diff", "--no-renames", "--", path];
  else if (which === "untracked") args = ["diff", "--no-ext-diff", "--no-index", "--", "/dev/null", path];
  else if (which?.from) args = ["diff", "--no-ext-diff", "--no-renames", which.from, which.to, "--", path];
  else args = ["show", "--no-ext-diff", "--format=", "--first-parent", "-m", which.to, "--", path];
  const r = await git.read(root, args, { expected: [0, 1] });
  if (r.code !== 0 && r.code !== 1) throw new GitError(r, args);
  return r.stdout;
}

/** Added/removed lines per path for the work tree (staged + unstaged). */
export async function numstat(git, root, cached) {
  const r = await git.read(root, ["diff", ...(cached ? ["--cached"] : []), "--numstat", "-z", "--no-renames"], { expected: [0, 128] });
  const out = {};
  if (r.code !== 0) return out;
  for (const e of r.stdout.split("\0")) {
    const [a, d, ...rest] = e.split("\t");
    if (!rest.length) continue;
    out[rest.join("\t")] = { add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" };
  }
  return out;
}

/** Text of the default merge message while a merge is in progress. */
export async function mergeMessage(git, root, exists, read) {
  const r = await git.read(root, ["rev-parse", "--path-format=absolute", "--git-path", "MERGE_MSG"]);
  if (r.code !== 0) return null;
  const p = r.stdout.trim();
  if (!(await exists(p))) return null;
  return ((await read(p)) ?? "").split("\n").filter((l) => !l.startsWith("#")).join("\n").trim();
}

/**
 * Simulates applying one commit onto HEAD without touching anything:
 * cherry-pick = merge-tree --merge-base=C^ HEAD C; revert = --merge-base=C HEAD C^.
 * `parent`: the parent to diff against (mainline for merge commits).
 */
export async function simulatePick(git, root, commit, parent, revert) {
  const args = revert
    ? ["merge-tree", "--write-tree", "--name-only", "--messages", `--merge-base=${commit}`, "HEAD", parent]
    : ["merge-tree", "--write-tree", "--name-only", "--messages", `--merge-base=${parent}`, "HEAD", commit];
  const r = await git.read(root, args, { expected: [0, 1] });
  if (r.code === 0 || r.code === 1) return { ok: true, clean: r.code === 0, ...parseMergeTree(r.stdout) };
  return { ok: false, error: (r.stderr || "").trim() };
}

/** Lines with conflict markers per conflicted path (reads the files; bounded). */
export async function markerCounts(root, paths, read) {
  const out = {};
  for (const p of paths.slice(0, 50)) {
    try { const text = await read(`${root}/${p}`); out[p] = text ? (text.match(/^<{7}( |$)/gm) ?? []).length : null; }
    catch { out[p] = null; }
  }
  return out;
}

// ---------- fast-forwards, from the reflog ----------
// A fast-forward leaves no commit behind, so History can't show it by itself.
// The branch's reflog still knows: "merge dev: Fast-forward" (git merge),
// "pull …: Fast-forward", "fetch . refs/remotes/x:refs/heads/y: fast-forward"
// (Actualizar). Each entry's previous position is the next (older) entry.

/** Parses `log -g -z --format=%H%x1f%gs%x1f%ct` of one branch into fast-forward events. */
export function parseFfReflog(stdout, branch) {
  const rows = stdout.split("\0").map((r) => r.replace(/^\n/, "")).filter(Boolean).map((r) => { const [hash, subject = "", ct] = r.split("\x1f"); return { hash, subject, at: Number(ct) * 1000 }; });
  const out = [];
  for (let i = 0; i < rows.length - 1; i++) {
    const { hash, subject, at } = rows[i], from = rows[i + 1].hash;
    if (!/fast[- ]forward\s*$/i.test(subject) || from === hash) continue;
    let source = null, m;
    if ((m = /^merge (.+?): Fast-forward$/i.exec(subject))) source = m[1];
    else if ((m = /^fetch \. refs\/remotes\/(.+?):refs\/heads\/.+: fast-forward$/i.exec(subject))) source = m[1];
    else if (/^pull\b/i.test(subject)) source = "pull";
    out.push({ branch, from, to: hash, source, at });
  }
  return out;
}

/**
 * Recent fast-forwards of local branches: [{ branch, from, to, source, at }],
 * newest first, at most `perBranch` each and none older than `maxAgeMs`.
 * Branches without a reflog (fresh clones, reflog off) give nothing.
 */
export async function ffMarks(git, root, branches, { perBranch = 3, depth = 40, maxAgeMs = 30 * 864e5, now = Date.now() } = {}) {
  const lists = await Promise.all(branches.slice(0, 25).map(async (b) => {
    const r = await git.read(root, ["log", "-g", "-z", "--format=%H%x1f%gs%x1f%ct", "-n", String(depth), `refs/heads/${b}`, "--"], { expected: [0, 128] });
    return r.code === 0 ? parseFfReflog(r.stdout, b).filter((e) => now - e.at <= maxAgeMs).slice(0, perBranch) : [];
  }));
  return lists.flat().sort((a, b) => b.at - a.at);
}

/** One sentence for a commit that was a branch's position before a fast-forward. */
export function ffMarkText(e) {
  const by = e.source === "pull" ? "de un Pull" : e.source ? `del fast-forward de ${e.source}` : "de un fast-forward";
  return `${e.branch} estaba aquí antes ${by} y avanzó a ${e.to.slice(0, 7)} sin commit de merge.`;
}

/**
 * A rebase Git has stopped in: which branch, onto what, and how far.
 * `read(path)` returns a file's text or null. Returns null when no rebase is in progress.
 */
export async function rebaseInfo(git, root, read) {
  const r = await git.read(root, ["rev-parse", "--path-format=absolute", "--git-path", "rebase-merge", "--git-path", "rebase-apply"]);
  if (r.code !== 0) return null;
  const [merge, apply] = r.stdout.split("\n");
  const get = async (dir, f) => { try { const t = await read(`${dir}/${f}`); return t == null ? null : t.trim(); } catch { return null; } };
  for (const [dir, done, total] of [[merge, "msgnum", "end"], [apply, "next", "last"]]) {
    const head = dir && await get(dir, "head-name");
    if (!head) continue;
    const onto = await get(dir, "onto");
    const ontoName = onto ? (await git.read(root, ["name-rev", "--name-only", "--no-undefined", "--refs=refs/heads/*", "--refs=refs/remotes/*", onto], { expected: [0, 128] })).stdout.trim().replace(/~\d+$|\^\d+$/, "") || null : null;
    return {
      branch: head.replace(/^refs\/heads\//, ""), onto, ontoName: ontoName && !/[~^]/.test(ontoName) ? ontoName : null,
      step: Number(await get(dir, done)) || 0, total: Number(await get(dir, total)) || 0,
      stopped: await get(dir, "stopped-sha"),
    };
  }
  return null;
}
