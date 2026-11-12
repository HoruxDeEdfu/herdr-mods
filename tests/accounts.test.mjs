// Accounts: reading which account a repo uses, pinning and unpinning one.
// Throwaway repos and a fake `gh`; the real gh and global config are never touched.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, realpathSync, chmodSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const MOD = join(homedir(), ".config/herdr-app/mods/git-panel/git");
const { Runner } = await import(join(MOD, "runner.js"));
const A = await import(join(MOD, "accounts.js"));
const Q = await import(join(MOD, "queries.js"));

const TMP = realpathSync(mkdtempSync(join(tmpdir(), "git panel acct ")));
after(() => rmSync(TMP, { recursive: true, force: true }));
// A global config of our own, with the gh credential helper like the real one.
const GLOBAL = join(TMP, "global.gitconfig");
writeFileSync(GLOBAL, `[user]\n\tname = Work Me\n\temail = me@work.example\n[credential "https://github.com"]\n\thelper =\n\thelper = !gh-global-helper\n`);
// Fake gh: `auth token --user X` prints TOKEN-X.
const GH = join(TMP, "fake gh");
writeFileSync(GH, `#!/bin/sh\nif [ "$1 $2 $3" = "auth token --user" ]; then echo "TOKEN-$4"; exit 0; fi\nexit 1\n`);
chmodSync(GH, 0o755);
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: GLOBAL, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
const exec = (cmd, args, { cwd, timeout } = {}) => new Promise((res) => {
  const p = execFile(cmd, args, { cwd, timeout, env: ENV }, (e, stdout, stderr) => res({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout, stderr }));
  if (cmd === "git" && args.includes("fill")) { p.stdin.end("protocol=https\nhost=github.com\n\n"); }
});
const git = new Runner({ exec, platform: "macos" });
const sh = async (cwd, ...a) => (await exec("git", a, { cwd })).stdout;
const ACCOUNTS = [{ host: "github.com", login: "work", active: true }, { host: "github.com", login: "me", active: false }];
let n = 0;
async function repo(url = "https://github.com/me/x.git") {
  const dir = join(TMP, `r${++n} ñ`); mkdirSync(dir);
  await sh(dir, "init", "-q", "-b", "main");
  if (url) await sh(dir, "remote", "add", "origin", url);
  return dir;
}
const state = async (dir) => A.repoAccount(git, dir, await Q.remotes(git, dir), ACCOUNTS);
const R = async (dir) => Q.detect(git, dir);

test("remoteHost", () => {
  assert.deepEqual(A.remoteHost("https://github.com/a/b.git"), { host: "github.com", https: true });
  assert.deepEqual(A.remoteHost("https://user@GitHub.com/a/b"), { host: "github.com", https: true });
  assert.deepEqual(A.remoteHost("git@github.com:a/b.git"), { host: "github.com", https: false });
  assert.deepEqual(A.remoteHost("ssh://git@gitlab.com/a/b"), { host: "gitlab.com", https: false });
  assert.equal(A.remoteHost("/some/path"), null);
});

test("helper string round-trips its login, quoting included", () => {
  assert.equal(A.helperLogin(A.helperFor("/opt/gh", "me")), "me");
  assert.equal(A.helperLogin(A.helperFor("/a b/gh", "o'neil")), "o'neil");
  assert.equal(A.helperLogin("!gh auth git-credential"), null);
});

test("unpinned: global identity and gh's active account", async () => {
  const s = await state(await repo());
  assert.equal(s.email, "me@work.example"); assert.equal(s.emailScope, "global");
  assert.equal(s.pushLogin, "work"); assert.equal(s.pushSource, "global"); assert.equal(s.pin, null);
});

test("pin → git itself asks gh for that account; outside the repo, the global one", async () => {
  const dir = await repo();
  await A.pin(git, await R(dir), await state(dir), { login: "me", name: "Personal Me", email: "me@home.example", gh: GH });
  const s = await state(dir);
  assert.equal(s.email, "me@home.example"); assert.equal(s.emailScope, "local");
  assert.equal(s.pushLogin, "me"); assert.equal(s.pushSource, "pinned"); assert.equal(s.pin.login, "me"); assert.ok(s.pin.helperOk);
  const fill = await exec("git", ["credential", "fill"], { cwd: dir });
  assert.match(fill.stdout, /username=me\n/); assert.match(fill.stdout, /password=TOKEN-me\n/);
  // re-pin to the other account: replaced, not duplicated
  await A.pin(git, await R(dir), s, { login: "work", name: "Work Me", email: "me@work.example", gh: GH });
  const helpers = (await sh(dir, "config", "--local", "--get-all", "credential.https://github.com.helper")).split("\n").filter((l) => l !== "");
  assert.equal(helpers.length, 1); assert.equal(A.helperLogin(helpers[0]), "work");
});

test("unpin restores the repo's own identity and removes only what the panel wrote", async () => {
  const dir = await repo();
  await sh(dir, "config", "--local", "user.email", "custom@repo.example");
  await sh(dir, "config", "--local", "core.autocrlf", "false");
  await A.pin(git, await R(dir), await state(dir), { login: "me", name: "Personal Me", email: "me@home.example", gh: GH });
  await A.unpin(git, await R(dir), await state(dir));
  const s = await state(dir);
  assert.equal(s.email, "custom@repo.example"); assert.equal(s.emailScope, "local");
  assert.equal(s.name, "Work Me"); assert.equal(s.nameScope, "global");
  assert.equal(s.pin, null); assert.equal(s.pushSource, "global");
  assert.equal((await sh(dir, "config", "--local", "core.autocrlf")).trim(), "false");
  assert.equal(await sh(dir, "config", "--local", "--get-regexp", "^herdr-git-panel"), "");
});

test("a repo's own credential helper is never replaced", async () => {
  const dir = await repo();
  await sh(dir, "config", "--local", "credential.https://github.com.helper", "store");
  const s = await state(dir);
  assert.ok(s.foreignHelper); assert.equal(s.pushSource, "own-helper");
  await assert.rejects(A.pin(git, await R(dir), s, { login: "me", name: "x", email: "x@y", gh: GH }), /propio helper/);
  assert.equal((await sh(dir, "config", "--local", "--get-all", "credential.https://github.com.helper")).trim(), "store");
});

test("ssh remote: identity only, push decided by the ssh key", async () => {
  const dir = await repo("git@github.com:me/x.git");
  await A.pin(git, await R(dir), await state(dir), { login: "me", name: "P", email: "p@home.example", gh: null });
  const s = await state(dir);
  assert.equal(s.pushSource, "ssh"); assert.equal(s.email, "p@home.example"); assert.ok(s.pin.helperOk);
  assert.equal(await sh(dir, "config", "--local", "--get-all", "credential.https://github.com.helper"), "");
});

test("warnings: author email of one account, push of another", () => {
  const profiles = { me: { email: "me@home.example" }, work: { email: "me@work.example" } };
  assert.deepEqual(A.accountWarnings({ email: "me@work.example", pushLogin: "work" }, profiles), []);
  assert.equal(A.accountWarnings({ email: "ME@home.example", pushLogin: "work" }, profiles).length, 1);
  assert.equal(A.accountWarnings({ pin: { login: "me", helperOk: false }, email: "me@home.example", pushLogin: "work" }, profiles).length, 2);
});

test("a hand-written per-account helper counts as pinned; pinning from the panel replaces it", async () => {
  const dir = await repo();
  await sh(dir, "config", "--local", "--add", "credential.https://github.com.helper", "");
  await sh(dir, "config", "--local", "--add", "credential.https://github.com.helper", `!f() { test "$1" = get || exit 0; echo "username=me"; echo "password=$(gh auth token --user me)"; }; f`);
  const s = await state(dir);
  assert.equal(s.pushLogin, "me"); assert.equal(s.pushSource, "pinned"); assert.equal(s.manualPin, "me"); assert.equal(s.pin, null); assert.equal(s.foreignHelper, false);
  await A.pin(git, await R(dir), s, { login: "work", name: "W", email: "w@work.example", gh: GH });
  const t = await state(dir);
  assert.equal(t.pushLogin, "work"); assert.equal(t.pin.login, "work"); assert.equal(t.manualPin, null);
});
