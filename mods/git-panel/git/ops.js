// Commands that change the repository. Each goes through Runner.write: one at a
// time per repository, logged, never --force, never stash/reset/clean.
// Names come from for-each-ref or are checked with check-ref-format first, so
// none can start with "-"; "--" separates paths where Git allows it.
import { GitError } from "./runner.js";

const ok = (r, args) => { if (r.code !== 0) throw new GitError(r, args); return r; };

export async function switchBranch(git, repo, name) {
  const args = ["switch", "--no-guess", name];
  return ok(await git.write(repo.root, args, { lock: repo.commonDir, label: `Cambiar a ${name}` }), args);
}

/** A local branch that tracks a remote one (origin/x → x). */
export async function trackRemote(git, repo, remoteName, localName) {
  const args = ["switch", "--create", localName, "--track", remoteName];
  return ok(await git.write(repo.root, args, { lock: repo.commonDir, label: `Crear ${localName} desde ${remoteName}` }), args);
}

export async function createBranch(git, repo, name, start, checkout) {
  const args = checkout ? ["switch", "--create", name, start] : ["branch", name, start];
  return ok(await git.write(repo.root, args, { lock: repo.commonDir, label: `Crear rama ${name}` }), args);
}

export async function renameBranch(git, repo, from, to) {
  const args = ["branch", "--move", from, to];
  return ok(await git.write(repo.root, args, { lock: repo.commonDir, label: `Renombrar ${from}` }), args);
}

/** `force` (-D) only after the person confirmed losing unmerged commits. */
export async function deleteBranch(git, repo, name, force = false) {
  const args = ["branch", force ? "-D" : "-d", name];
  return ok(await git.write(repo.root, args, { lock: repo.commonDir, label: `Eliminar ${name}` }), args);
}

/** Deletes a branch on a remote: git push <remote> --delete refs/heads/<branch>. Not a force push. */
export async function deleteRemoteBranch(git, repo, remote, branch) {
  const args = ["push", remote, "--delete", `refs/heads/${branch}`];
  return ok(await git.write(repo.root, args, { lock: repo.commonDir, network: true, timeout: 180000, label: `Eliminar ${remote}/${branch} del remoto` }), args);
}

export async function fetch(git, repo, remote, { prune = false } = {}) {
  const args = ["fetch", ...(prune ? ["--prune"] : []), remote ?? "--all"];
  return ok(await git.write(repo.root, args, { lock: repo.commonDir, network: true, timeout: 180000, label: "Fetch" }), args);
}

/**
 * mode: "ff" (fast-forward when possible), "no-ff" (always a merge commit), "ff-only".
 * Resolves with { conflicts: boolean, result } and does not throw on conflicts.
 */
export async function merge(git, repo, source, mode, message) {
  const args = ["merge", "--no-edit", mode === "no-ff" ? "--no-ff" : mode === "ff-only" ? "--ff-only" : "--ff"];
  if (message && mode !== "ff-only") args.push("-m", message);
  args.push(source);
  const r = await git.write(repo.root, args, { lock: repo.commonDir, timeout: 300000, label: `Merge ${source}` });
  if (r.code === 0) return { conflicts: false, result: r };
  if (/CONFLICT|Automatic merge failed/i.test(r.stdout + r.stderr)) return { conflicts: true, result: r };
  throw new GitError(r, args);
}

export async function mergeAbort(git, repo) {
  const args = ["merge", "--abort"];
  return ok(await git.write(repo.root, args, { lock: repo.commonDir, label: "Abortar merge" }), args);
}

/** Adds paths to the index (new, modified and deleted alike). Marks conflicts resolved. */
export async function stage(git, repo, paths) {
  const args = ["add", "-A", "--", ...paths];
  return ok(await git.write(repo.root, args, { lock: repo.commonDir, label: paths.length === 1 ? `Stage ${paths[0]}` : `Stage ${paths.length} archivos` }), args);
}

/**
 * Applies one hunk to the index only (`git apply --cached`), never to the work
 * tree. `reverse` takes a staged hunk back out. The patch is a file Git reads
 * (exec has no stdin): the caller writes it inside the worktree's git dir.
 */
export async function applyHunk(git, repo, patchFile, { reverse = false, label } = {}) {
  const args = ["apply", "--cached", "--whitespace=nowarn", ...(reverse ? ["--reverse"] : []), patchFile];
  return ok(await git.write(repo.root, args, { lock: repo.commonDir, label: label ?? (reverse ? "Unstage fragmento" : "Stage fragmento") }), args);
}

/** Takes paths out of the index; the work tree is untouched. */
export async function unstage(git, repo, paths, hasHead) {
  const args = hasHead ? ["restore", "--staged", "--", ...paths] : ["rm", "--cached", "-r", "--quiet", "--", ...paths];
  return ok(await git.write(repo.root, args, { lock: repo.commonDir, label: paths.length === 1 ? `Unstage ${paths[0]}` : `Unstage ${paths.length} archivos` }), args);
}

/** message null while concluding a merge: Git's prepared message (--no-edit). */
export async function commit(git, repo, message) {
  const args = message ? ["commit", "-m", message] : ["commit", "--no-edit"];
  return ok(await git.write(repo.root, args, { lock: repo.commonDir, timeout: 300000, label: "Commit" }), args);
}

/** Never --force. setUpstream publishes a branch that has none. */
export async function push(git, repo, remote, branch, setUpstream) {
  const args = ["push", ...(setUpstream ? ["--set-upstream"] : []), remote, `refs/heads/${branch}:refs/heads/${branch}`];
  return ok(await git.write(repo.root, args, { lock: repo.commonDir, network: true, timeout: 300000, label: `Push ${branch}` }), args);
}

/** mainline: for a merge commit, which parent counts as "before" (1 = the branch it was merged into). */
export async function cherryPick(git, repo, sha, mainline) {
  const args = ["cherry-pick", ...(mainline ? ["-m", String(mainline)] : []), sha];
  const r = await git.write(repo.root, args, { lock: repo.commonDir, timeout: 300000, label: `Cherry-pick ${sha.slice(0, 7)}` });
  if (r.code === 0) return { conflicts: false };
  if (/CONFLICT|could not apply|after resolving the conflicts/i.test(r.stdout + r.stderr)) return { conflicts: true };
  throw new GitError(r, args);
}

export async function revert(git, repo, sha, mainline) {
  const args = ["revert", "--no-edit", ...(mainline ? ["-m", String(mainline)] : []), sha];
  const r = await git.write(repo.root, args, { lock: repo.commonDir, timeout: 300000, label: `Revert ${sha.slice(0, 7)}` });
  if (r.code === 0) return { conflicts: false };
  if (/CONFLICT|could not revert|after resolving the conflicts/i.test(r.stdout + r.stderr)) return { conflicts: true };
  throw new GitError(r, args);
}

/** kind: "merge" | "cherry-pick" | "revert" | "rebase" | "bisect" (bisect ends with reset). Never touches anything Git didn't start. */
export async function abortOp(git, repo, kind) {
  const args = kind === "bisect" ? ["bisect", "reset"] : [kind, "--abort"];
  return ok(await git.write(repo.root, args, { lock: repo.commonDir, label: `Abortar ${kind}` }), args);
}

/**
 * Continues a cherry-pick/revert/rebase after conflicts, keeping Git's message (no editor).
 * Returns { conflicts }: a rebase (or a multi-commit pick) may stop again at the next commit.
 */
export async function continueOp(git, repo, kind) {
  const args = ["-c", "core.editor=true", kind, "--continue"];
  const r = await git.write(repo.root, args, { lock: repo.commonDir, timeout: 300000, label: `Continuar ${kind}` });
  if (r.code === 0) return { conflicts: false };
  if (/CONFLICT|could not apply|after resolving the conflicts/i.test(r.stdout + r.stderr)) return { conflicts: true };
  throw new GitError(r, args);
}

/**
 * Resolves one conflicted file with one side, then stages it.
 * side "ours": the branch being merged into (HEAD); "theirs": the incoming one.
 */
export async function resolveWith(git, repo, path, side) {
  const args = ["checkout", side === "ours" ? "--ours" : "--theirs", "--", path];
  ok(await git.write(repo.root, args, { lock: repo.commonDir, label: `Resolver ${path} (${side})` }), args);
  return stage(git, repo, [path]);
}

/** create: a new branch from `start`; else checks out an existing branch there. */
export async function worktreeAdd(git, repo, path, branch, create, start) {
  const args = create ? ["worktree", "add", "-b", branch, path, start ?? "HEAD"] : ["worktree", "add", path, branch];
  return ok(await git.write(repo.root, args, { lock: repo.commonDir, timeout: 600000, label: `Worktree ${branch}` }), args);
}

/** Never --force: Git refuses when the worktree has changes or is locked. */
export async function worktreeRemove(git, repo, path) {
  const args = ["worktree", "remove", path];
  return ok(await git.write(repo.root, args, { lock: repo.commonDir, timeout: 600000, label: "Eliminar worktree" }), args);
}

export async function worktreePrune(git, repo) {
  const args = ["worktree", "prune", "--verbose"];
  return ok(await git.write(repo.root, args, { lock: repo.commonDir, label: "Podar worktrees" }), args);
}

/** Moves a branch that isn't checked out to its upstream, fast-forward only (Git refuses anything else). */
export async function fastForwardBranch(git, repo, branch, upstream) {
  const args = ["fetch", ".", `refs/remotes/${upstream}:refs/heads/${branch}`];
  return ok(await git.write(repo.root, args, { lock: repo.commonDir, label: `Actualizar ${branch}` }), args);
}
