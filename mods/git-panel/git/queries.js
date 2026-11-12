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
