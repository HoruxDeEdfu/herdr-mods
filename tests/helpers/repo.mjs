// Shared setup for the newer tests: throwaway repositories under a fresh
// mkdtemp folder, Git isolated from the person's config, the installed mod.
import { after } from "node:test";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, realpathSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

export const MODS = join(homedir(), ".config/herdr-app/mods");
const MOD = join(MODS, "git-panel/git");
export const { Runner } = await import(join(MOD, "runner.js"));
export const Q = await import(join(MOD, "queries.js"));
export const O = await import(join(MOD, "ops.js"));
export const F = await import(join(MOD, "merge-flow.js"));

export const TMP = realpathSync(mkdtempSync(join(tmpdir(), "git panel test ")));
after(() => rmSync(TMP, { recursive: true, force: true }));

export const ENV = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_EDITOR: "true" };
export const exec = (cmd, args, { cwd, timeout, env } = {}) => new Promise((resolve) => {
  execFile(cmd, args, { cwd, timeout, env: env ?? ENV, maxBuffer: 8 << 20 }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }));
});
export const logs = [];
export const git = new Runner({ exec, platform: "macos", onLog: (e) => logs.push(e) });
export const exists = async (p) => existsSync(p);
export const sh = async (cwd, ...args) => { const r = await exec("git", args, { cwd }); if (r.code) throw new Error(`git ${args.join(" ")}: ${r.stderr}`); return r.stdout; };

let n = 0;
export function dir(name = "repo") { const d = join(TMP, `${name} ${++n}`); mkdirSync(d); return d; }
export async function makeRepo() {
  const d = dir();
  await sh(d, "init", "-q", "-b", "main");
  await sh(d, "config", "core.logAllRefUpdates", "true");
  writeFileSync(join(d, "a.txt"), "uno\ndos\ntres\n");
  await sh(d, "add", "-A"); await sh(d, "commit", "-qm", "base");
  return d;
}
export async function commit(d, file, text, msg) { writeFileSync(join(d, file), text); await sh(d, "add", "--", file); await sh(d, "commit", "-qm", msg); }
export async function ctx(d, extra = {}) {
  const repo = await Q.detect(git, d);
  const [status, refs, ops] = await Promise.all([Q.status(git, repo.root), Q.refs(git, repo.root), Q.inProgress(git, repo.root, exists)]);
  return { repo, status, refs, ops, drafts: {}, ...extra };
}
/** A bare "origin" with `main` pushed, and a clone of it. */
export async function withRemote() {
  const src = await makeRepo();
  const bare = dir("origin");
  await sh(bare, "init", "-q", "--bare", "-b", "main");
  await sh(src, "remote", "add", "origin", bare);
  await sh(src, "push", "-q", "-u", "origin", "main");
  return { src, bare };
}
