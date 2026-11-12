// Which account a repository uses, and pinning one to it.
//
// "Account" is two separate things in Git:
//   - the commit author: user.name / user.email (config);
//   - who fetches and pushes over HTTPS: the credential helper. With the
//     GitHub CLI that is `gh auth git-credential`, which always answers with
//     gh's *active* account, the same for every repository.
// Pinning writes both into this repository's own .git/config (git config
// --local), so nothing global changes. The helper it writes asks gh for one
// named account's token (`gh auth token --user`), and an empty helper first
// clears the inherited list so the global one isn't asked too.
// Everything the panel sets is recorded under [herdr-git-panel] so unpinning
// removes exactly that and restores what was there before.

const SECTION = "herdr-git-panel";
const ok = (r, what) => { if (r.code !== 0) throw Object.assign(new Error((r.stderr || r.stdout || `${what} failed`).trim()), { stderr: r.stderr ?? "" }); return r; };

/** "https://github.com/a/b.git" | "git@github.com:a/b" | "ssh://git@host/a" → { host, https } */
export function remoteHost(url) {
  if (!url) return null;
  let m = /^https?:\/\/(?:[^@/]+@)?([^/:]+)/i.exec(url);
  if (m) return { host: m[1].toLowerCase(), https: true };
  m = /^ssh:\/\/(?:[^@/]+@)?([^/:]+)/i.exec(url) ?? /^(?:[^@/]+@)?([^/:]+):(?!\/)/.exec(url);
  if (m) return { host: m[1].toLowerCase(), https: false };
  return null;
}

/** The helper string pinned for one gh account. `gh` is gh's absolute path. */
export function helperFor(gh, login) {
  const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `!f() { test "$1" = get || return 0; echo username=${q(login)}; echo "password=$(${q(gh)} auth token --user ${q(login)})"; }; f`;
}

/** Which login a helper string stands for, when it's one this panel wrote. */
export function helperLogin(value) {
  // Ours quote the login; hand-written ones (same mechanism) may not.
  const m = /auth token --user\s+(?:'((?:[^']|'\\'')*)'|"([^"]*)"|([^\s;)"'$]+))/.exec(value ?? "");
  if (!m) return null;
  return m[1] !== undefined ? m[1].replace(/'\\''/g, "'") : m[2] ?? m[3];
}

/** gh's accounts: [{ host, login, active }], [] when gh is missing or signed out. */
export async function ghAccounts(exec, on) {
  let r;
  try { r = await exec("gh", ["auth", "status", "--json", "hosts"], { on, timeout: 15000 }); } catch { return []; }
  let hosts;
  try { hosts = JSON.parse(r.stdout || "{}").hosts ?? {}; } catch { return []; }
  const out = [];
  for (const [host, list] of Object.entries(hosts)) for (const a of list ?? []) if (a.login) out.push({ host: host.toLowerCase(), login: a.login, active: Boolean(a.active), ok: a.state === "success" });
  return out;
}

/** gh's absolute path (the helper runs from git, outside any login shell). */
export async function ghPath(exec, on) {
  try { const r = await exec("sh", ["-c", "command -v gh"], { on, timeout: 10000 }); const p = r.stdout.trim(); return r.code === 0 && p.startsWith("/") ? p : null; }
  catch { return null; }
}

/** `git config --null` output → [[key, value], …] (keys lowercased by Git). */
function pairs(out) {
  return (out ?? "").split("\0").filter(Boolean).map((e) => { const i = e.indexOf("\n"); return i < 0 ? [e, ""] : [e.slice(0, i), e.slice(i + 1)]; });
}

/**
 * The repository's account state. `accounts`: from ghAccounts.
 * Returns { remote, host, https, name, email, emailScope, pin, pushLogin, pushSource, foreignHelper, accounts }.
 */
export async function repoAccount(git, root, remotes, accounts) {
  const remote = remotes.includes("origin") ? "origin" : remotes[0] ?? null;
  let host = null, https = false;
  if (remote) {
    const u = await git.read(root, ["remote", "get-url", remote]);
    const h = u.code === 0 ? remoteHost(u.stdout.trim()) : null;
    if (h) ({ host, https } = h);
  }
  const local = pairs((await git.read(root, ["config", "--local", "--null", "--get-regexp", `^(user\\.(name|email)|${SECTION}\\..*|credential\\..*\\.helper)$`], { expected: [0, 1] })).stdout);
  const get = (k) => local.filter(([key]) => key === k).map(([, v]) => v);
  const scoped = async (key) => {
    const r = await git.read(root, ["config", "--show-scope", "--get", key], { expected: [0, 1] });
    const line = r.stdout.replace(/\n$/, ""); const i = line.indexOf("\t");
    return r.code === 0 && i > 0 ? { scope: line.slice(0, i), value: line.slice(i + 1) } : { scope: null, value: null };
  };
  const [name, email] = await Promise.all([scoped("user.name"), scoped("user.email")]);
  const pinLogin = get(`${SECTION}.account`)[0] ?? null;
  const pinHost = get(`${SECTION}.host`)[0] ?? null;
  const helperKey = host ? `credential.https://${host}.helper` : null;
  const helpers = helperKey ? get(helperKey) : [];
  const ours = helpers.map(helperLogin).find(Boolean) ?? null;
  // Any other helper the person set up for this repo: the panel never replaces it.
  const foreignHelper = helpers.some((h) => h !== "" && !helperLogin(h));
  const onHost = accounts.filter((a) => a.host === host);
  let pushLogin = null, pushSource = null;
  if (!https) pushSource = remote ? "ssh" : null;
  else if (ours) { pushLogin = ours; pushSource = "pinned"; }
  else if (foreignHelper) pushSource = "own-helper";
  else if (onHost.length) { pushLogin = onHost.find((a) => a.active)?.login ?? null; pushSource = "global"; }
  return {
    remote, host, https, name: name.value, nameScope: name.scope, email: email.value, emailScope: email.scope,
    pin: pinLogin ? { login: pinLogin, host: pinHost, helperOk: !https || ours === pinLogin } : null,
    // A per-account helper written by hand (not by this panel): pinned all the same.
    manualPin: !pinLogin && ours ? ours : null,
    pushLogin, pushSource, foreignHelper, accounts: onHost,
  };
}

/**
 * Notes about a mismatch, using the emails remembered per login
 * (`profiles`: { [login]: { name, email } }).
 */
export function accountWarnings(a, profiles) {
  const w = [];
  if (!a) return w;
  if (a.pin && !a.pin.helperOk) w.push(`La fijación de ${a.pin.login} está incompleta: falta su credencial. Vuelve a fijar la cuenta.`);
  const owner = Object.entries(profiles ?? {}).find(([, p]) => p?.email && a.email && p.email.toLowerCase() === a.email.toLowerCase())?.[0];
  if (owner && a.pushLogin && owner !== a.pushLogin) w.push(`Los commits se firman con el correo de ${owner} (${a.email}), pero el push sale con ${a.pushLogin}.`);
  return w;
}

/** Pins `login` (author name/email + HTTPS credential) to this repository only. */
export async function pin(git, repo, a, { login, name, email, gh }) {
  if (a.foreignHelper) throw new Error("Este repositorio ya tiene su propio helper de credenciales en .git/config. El panel no lo reemplaza: quítalo a mano si quieres fijar una cuenta.");
  if (a.https && !gh) throw new Error("No encuentro el programa gh. La cuenta de push se elige con GitHub CLI (gh).");
  const w = (args, label) => git.write(repo.root, ["config", "--local", ...args], { lock: repo.commonDir, label });
  const wOk = async (args, label) => ok(await w(args, label), "git config");
  const label = `Fijar cuenta ${login}`;
  if (!a.pin) { // first pin: remember the repo's own identity, if it had one
    if (a.nameScope === "local") await wOk([`${SECTION}.prevname`, a.name], label);
    if (a.emailScope === "local") await wOk([`${SECTION}.prevemail`, a.email], label);
  }
  await wOk(["user.name", name], label);
  await wOk(["user.email", email], label);
  if (a.https && a.host) {
    const key = `credential.https://${a.host}.helper`;
    const r = await w(["--unset-all", key], label);
    if (r.code !== 0 && r.code !== 5) ok(r, "git config");
    await wOk(["--add", key, ""], label);
    await wOk(["--add", key, helperFor(gh, login)], label);
  }
  await wOk([`${SECTION}.account`, login], label);
  await wOk([`${SECTION}.host`, a.host ?? ""], label);
}

/** Removes what pin() wrote and restores the repo's previous identity. */
export async function unpin(git, repo, a) {
  const label = "Quitar cuenta fijada";
  const w = (args) => git.write(repo.root, ["config", "--local", ...args], { lock: repo.commonDir, label });
  const prev = pairs((await git.read(repo.root, ["config", "--local", "--null", "--get-regexp", `^${SECTION}\\.prev`], { expected: [0, 1] })).stdout);
  const host = a.pin?.host || a.host;
  if (host && !a.foreignHelper) { const r = await w(["--unset-all", `credential.https://${host}.helper`]); if (r.code !== 0 && r.code !== 5) ok(r, "git config"); }
  for (const k of ["user.name", "user.email"]) { const r = await w(["--unset-all", k]); if (r.code !== 0 && r.code !== 5) ok(r, "git config"); }
  for (const [k, v] of prev) ok(await w([k === `${SECTION}.prevname` ? "user.name" : "user.email", v]), "git config");
  const r = await w(["--remove-section", SECTION]);
  if (r.code !== 0 && r.code !== 128) ok(r, "git config");
}

/** Changes gh's active account: every repository without a pin follows it. */
export async function switchGlobal(git, root, host, login) {
  return ok(await git.raw(root, ["gh", "auth", "switch", "--hostname", host, "--user", login], { kind: "write", log: true, label: `Cuenta global → ${login}` }), "gh auth switch");
}
