// Git panel: branches, a safe merge flow, history and the working tree, for the
// repository of the focused pane (or a worktree pinned from the panel).
// Git CLI is the source of truth; every change goes through git/ops.js, one at
// a time per repository, and is listed in the operations log.
// The same folder also draws its context menu when opened as a popup.
import { View } from "gpui-kit";
import { InputState, VirtualListScrollHandle } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, props, shared, setShared, openOverlay, closeOverlay, layout, appHome, window as hostWindow, nextCommand, run as runCommand, home, notify, writeTextFile } from "herdr";
import { createHash } from "crypto";
import { Buffer } from "buffer";
import { Runner } from "./git/runner.js";
import * as Q from "./git/queries.js";
import * as O from "./git/ops.js";
import * as F from "./git/merge-flow.js";
import * as A from "./git/accounts.js";
import { diffRows, hasConflictMarkers, conflictRows } from "./git/diff.js";
import { layoutGraph } from "./git/graph.js";
import { explain } from "./git/errors.js";
import { renderPanel } from "./ui/panel.js";
import { renderMenu, PICK } from "./ui/menu.js";

const DRAFTS = () => `${appHome()}/mods/code-files/.drafts/drafts.json`;
// Name and email per gh login. A dotfile: the installer and exports leave it alone.
const PROFILES = () => `${appHome()}/mods/git-panel/.accounts.json`;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+$/;
const basename = (p) => (p ?? "").split(/[\\/]/).filter(Boolean).pop() ?? p;
const PAGE = 200, LOG_MAX = 200;

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}

const under = (root, p) => p === root || p.startsWith(root.endsWith("/") ? root : root + "/");

function findPath(node, id, path = []) {
  if (!node) return null;
  const here = [...path, node];
  if (node.id === id) return here;
  for (const c of node.children ?? []) { const f = findPath(c, id, here); if (f) return f; }
  return null;
}

/** The diff views a status entry has: staged and/or unstaged, untracked, conflict. */
export function whichOf(f) {
  if (f.kind === "untracked") return ["untracked"];
  if (f.kind === "unmerged") return ["unstaged"];
  const w = [];
  if (f.x !== ".") w.push("staged");
  if (f.y !== ".") w.push("unstaged");
  return w;
}

export default class GitPanel extends View {
  init(_props, cx) {
    this.p = props() ?? {};
    this.handle = cx.focus_handle();
    if (this.p.menu) { this.kind = "menu"; this.sel = this.p.menu.items.findIndex((i) => !i.disabled && !i.sep); this.handle.focus(); return; }
    this.kind = "panel";
    this.uid = Math.random().toString(36).slice(2);
    this.tab = this.stored("tab") ?? "branches";
    this.width = 560;
    this.runners = new Map();
    this.data = null; this.error = null; this.loading = false; this.lastRefresh = 0; this.stale = 0;
    this.op = null; this.banner = null; this.sheet = null; this.pinned = null;
    this.collapsed = new Set(JSON.parse(this.stored("collapsed") ?? "null") ?? ["tags"]);
    this.selectedRef = null;
    this.history = { commits: [], done: false, loading: false, all: this.stored("historyAll") === "1", selected: null, detail: null, fp: null };
    this.oplog = JSON.parse(this.stored("oplog") ?? "[]");
    this.menuActions = new Map();
    this.filter = InputState.new({ placeholder: "Filtrar ramas…" });
    this.filter.on("change", (_e, cx) => { this.filterText = this.filter.value(); cx.notify(); });
    this.filterText = "";
    this.pickInput = InputState.new({ placeholder: "Buscar rama…" });
    this.pickInput.on("change", (_e, cx) => { this.pickText = this.pickInput.value(); cx.notify(); });
    this.pickText = "";
    this.nameInput = InputState.new({ placeholder: "nombre-de-rama" });
    this.nameInput.on("change", (_e, cx) => { if (this.sheet?.kind === "input") { this.sheet.value = this.nameInput.value(); this.sheet.error = null; cx.notify(); } });
    this.nameInput.on("submit", (_e, cx) => { if (this.sheet?.kind === "input") this.submitInput(cx); });
    this.idName = InputState.new({ placeholder: "Tu nombre" });
    this.idEmail = InputState.new({ placeholder: "correo@ejemplo.com" });
    for (const i of [this.idName, this.idEmail]) {
      i.on("change", (_e, cx) => { if (this.sheet?.kind === "account") { this.sheet.error = null; cx.notify(); } });
      i.on("submit", (_e, cx) => { if (this.sheet?.kind === "account") this.confirmPin(cx); });
    }
    this.profiles = {}; this.profilesText = null; this.gh = new Map();
    cx.spawn(async (cx) => { await this.loadProfiles(); cx.notify(); });
    this.commitInput = InputState.new({ placeholder: "Mensaje del commit" });
    this.commitText = "";
    this.commitInput.on("change", (_e, cx) => { const had = Boolean(this.commitText.trim()); this.commitText = this.commitInput.value(); if (had !== Boolean(this.commitText.trim())) cx.notify(); });
    this.commitInput.on("submit", (_e, cx) => this.doCommit(cx));
    this.changeSel = null; // { path, which }
    this.diff = null;      // { key, rows, adds, dels, binary, cut, loading, error }
    this.historyScroll = VirtualListScrollHandle.new();
    this.typing = new Set();
    for (const [name, input] of [["filter", this.filter], ["pick", this.pickInput], ["name", this.nameInput], ["commit", this.commitInput], ["idName", this.idName], ["idEmail", this.idEmail]]) {
      input.on("focus", () => this.typing.add(name));
      input.on("blur", () => this.typing.delete(name));
    }
    this.graphOn = this.stored("graph") !== "0";
    this.branchScroll = VirtualListScrollHandle.new();
    this.refresh(cx);
    cx.timer.every(700, (cx) => this.tick(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.handle.focus();
        else if (c === "fetch") this.fetch(cx);
        else if (c === "merge") this.startMerge(cx);
        cx.notify();
      }
    });
  }

  // ---------- small persistence (per copy) ----------
  stored(k) { try { return localStorage.getItem(k); } catch { return null; } }
  store(k, v) { try { localStorage.setItem(k, v); } catch {} }

  // ---------- context ----------
  context() { return this.pinned ?? location(); }
  contextKey() { return JSON.stringify(this.context()); }

  git(on) {
    const key = on ?? "";
    if (!this.runners.has(key)) this.runners.set(key, new Runner({ exec, on: on ?? null, platform: hostWindow()?.platform, onLog: (e) => this.addLog(e) }));
    return this.runners.get(key);
  }

  addLog(e) {
    this.oplog.unshift({ ...e, cwd: e.cwd });
    if (this.oplog.length > LOG_MAX) this.oplog.length = LOG_MAX;
    this.store("oplog", JSON.stringify(this.oplog));
  }

  /**
   * Files the editor (code-files) holds with edits not on disk. Read-only: its
   * drafts file, then each file itself. A draft whose text already equals the
   * file on disk (an agent wrote the same content, say) loses nothing, so it
   * doesn't count.
   */
  async readDrafts(on, root) {
    if (on) return {};
    let drafts;
    try { drafts = JSON.parse((await readTextFile(DRAFTS())) ?? "{}") ?? {}; } catch { return {}; }
    // Does Git already store exactly this text? Then the draft loses nothing.
    const known = async (path, text) => {
      const id = F.blobId(text, createHash, (t) => Buffer.from(t, "utf8"));
      // From the repository root: the file's own folder may not exist on this branch.
      if (!root) return false;
      const r = await this.git(null).read(root, ["cat-file", "-e", id], { expected: [0, 1, 128] });
      return r.code === 0;
    };
    return F.realDrafts(drafts, (p) => readTextFile(p), known);
  }

  exists(on) { return async (p) => { try { return (await readTextFile(p, { on })) !== null; } catch { return false; } }; }

  /** The repository on screen, as a context an action can be bound to. */
  bound() { return this.data ? { cwd: this.data.repo.root, on: this.data.on ?? null } : null; }

  /**
   * A fresh look at the repository, for decisions (never the cached view).
   * `sheet`: the sheet the decision belongs to. Its repository is fixed when it
   * opens, so switching space or pane meanwhile can never redirect a change.
   */
  async fresh(sheet) {
    const c = sheet ? (sheet.ctx ??= this.bound()) : this.bound() ?? this.context();
    if (!c?.cwd) throw new Error("No hay carpeta activa.");
    const git = this.git(c.on);
    const repo = await Q.detect(git, c.cwd);
    if (!repo) throw new Error("not a git repository");
    if (sheet && repo.root !== c.cwd) throw new Error(`El repositorio cambió (${repo.root}); vuelve a abrir la acción.`);
    const [status, refs, ops, drafts] = await Promise.all([Q.status(git, repo.root), Q.refs(git, repo.root), Q.inProgress(git, repo.root, this.exists(c.on)), this.readDrafts(c.on, repo.root)]);
    return { git, on: c.on, repo, status, refs, ops, drafts };
  }

  // ---------- refresh ----------
  visible() {
    const path = findPath(layout(), this.p.block ?? "git");
    if (!path) return true;
    for (let i = 0; i < path.length; i++) {
      const n = path[i];
      if (n.hidden) return false;
      if (n.type === "stack" && path[i + 1] && n.active && n.active !== path[i + 1].id) return false;
    }
    return true;
  }

  tick(cx) {
    const now = Date.now(), visible = this.visible();
    if (this.banner && this.banner.level !== "block" && now - this.banner.at > 9000) { this.banner = null; cx.notify(); }
    if (this.tab === "history" && visible && !this.history.done && (this.historyEnd ?? 0) >= this.history.commits.length - 20) this.moreHistory(cx);
    if (this.loading || this.op) return;
    const remote = Boolean(this.context().on);
    if (this.stale && visible && now - this.stale >= 400 && now - this.lastRefresh >= 1500) { this.stale = 0; this.refresh(cx); return; }
    const every = !visible ? 60000 : remote ? 20000 : 10000;
    if (now - this.lastRefresh >= every) this.refresh(cx);
  }

  refresh(cx, { history = false } = {}) {
    if (this.loading) { this.again = true; return; }
    const c = this.context(), key = JSON.stringify(c);
    if (key !== this.ctxKey) {
      this.ctxKey = key; this.data = null; this.error = null; this.selectedRef = null;
      this.history = { ...this.history, commits: [], done: false, selected: null, detail: null, fp: null };
      if (this.sheet && !this.sheet.running) this.sheet = null;
    }
    if (!c.cwd) { this.error = "No hay carpeta activa en este espacio."; return; }
    this.loading = true; this.lastRefresh = Date.now();
    cx.spawn(async (cx) => {
      try {
        const git = this.git(c.on);
        const repo = await Q.detect(git, c.cwd);
        if (this.contextKey() !== key) return;
        if (!repo) { this.data = null; this.error = "notrepo"; this.unwatch(); return; }
        const [status, refs, ops, worktrees, remotes, drafts] = await Promise.all([
          Q.status(git, repo.root), Q.refs(git, repo.root), Q.inProgress(git, repo.root, this.exists(c.on)),
          Q.worktrees(git, repo.root), Q.remotes(git, repo.root), this.readDrafts(c.on, repo.root)]);
        if (this.contextKey() !== key) return;
        const [staged, unstaged, account] = await Promise.all([Q.numstat(git, repo.root, true), Q.numstat(git, repo.root, false), this.readAccount(git, repo.root, remotes, c.on)]);
        const rebase = ops.includes("rebase") ? await Q.rebaseInfo(git, repo.root, (p) => readTextFile(p, { on: c.on })).catch(() => null) : null;
        this.data = { on: c.on, repo, status, refs, ops, worktrees, remotes, drafts, account, rebase, numstat: { staged, unstaged } };
        this.syncChangeSelection(cx);
        this.error = null;
        const fp = JSON.stringify([repo.root, status.oid, status.head, refs.map((r) => r.ref + r.oid)]);
        if (history || fp !== this.history.fp) { this.history.fp = fp; await this.loadHistory(cx, true); }
        this.watch(repo, c.on, cx);
      } catch (e) {
        if (this.contextKey() === key) this.error = explain(e);
      } finally {
        this.loading = false; this.lastRefresh = Date.now();
        if (this.again) { this.again = false; this.refresh(cx); }
        cx.notify();
      }
    });
  }

  unwatch() { this.watchGen = (this.watchGen ?? 0) + 1; this.watching = null; }

  // Agents change files, commits and refs from terminals Herdr doesn't see:
  // watch the worktree and the shared common dir (refs of every worktree).
  watch(repo, on, cx) {
    if (on) { if (this.watching) this.unwatch(); return; }
    const dirs = [repo.root];
    if (!under(repo.root, repo.commonDir)) dirs.push(repo.commonDir);
    const key = dirs.join("\0");
    if (this.watching === key) return;
    this.unwatch(); this.watching = key;
    const gen = this.watchGen;
    for (const dir of dirs) cx.spawn(async () => {
      try {
        while (gen === this.watchGen) {
          const paths = await watchFolder(dir);
          if (gen !== this.watchGen) break;
          if (paths.length && paths.every((p) => p.endsWith(".lock"))) continue;
          this.stale = this.stale || Date.now();
        }
      } catch { /* timer fallback keeps refreshing */ }
    });
  }

  // ---------- history ----------
  async loadHistory(cx, reset) {
    const d = this.data;
    if (!d || this.history.loading) return;
    const h = this.history;
    h.loading = true;
    try {
      const skip = reset ? 0 : h.commits.length;
      const page = await Q.log(this.git(d.on), d.repo.root, { skip, limit: PAGE, all: h.all });
      h.commits = reset ? page : h.commits.concat(page);
      if (reset) {
        // Where each local branch was before a recent fast-forward (it leaves no commit to show).
        const marks = await Q.ffMarks(this.git(d.on), d.repo.root, d.refs.filter((r) => r.type === "local").map((r) => r.name)).catch(() => []);
        h.ffAt = {};
        for (const e of marks) (h.ffAt[e.from] ??= []).push(e);
      }
      h.graph = layoutGraph(h.commits);
      h.done = page.length < PAGE;
      if (h.selected && !h.commits.some((c) => c.hash === h.selected)) { h.selected = null; h.detail = null; }
    } catch (e) { this.say("block", explain(e)); }
    finally { h.loading = false; cx.notify(); }
  }

  moreHistory(cx) {
    if (this.history.done || this.history.loading) return;
    cx.spawn(async (cx) => this.loadHistory(cx, false));
  }

  setHistoryAll(all, cx) {
    this.history.all = all; this.store("historyAll", all ? "1" : "0");
    cx.spawn(async (cx) => this.loadHistory(cx, true));
  }

  selectCommit(hash, cx) {
    const h = this.history;
    if (h.selected === hash) { h.selected = null; h.detail = null; cx.notify(); return; }
    h.selected = hash; h.detail = { loading: true };
    const d = this.data;
    cx.spawn(async (cx) => {
      try {
        const git = this.git(d.on);
        const [files, body] = await Promise.all([Q.commitFiles(git, d.repo.root, hash), Q.commitBody(git, d.repo.root, hash)]);
        if (h.selected === hash) h.detail = { files, body };
      } catch (e) { if (h.selected === hash) h.detail = { error: explain(e) }; }
      cx.notify();
    });
  }

  /** From a branch to its commit: loads pages (all branches) until it's there. */
  showInHistory(oid, cx) {
    this.setTab("history");
    const h = this.history;
    cx.spawn(async (cx) => {
      if (!h.all && !h.commits.some((c) => c.hash === oid)) { h.all = true; await this.loadHistory(cx, true); }
      while (!h.commits.some((c) => c.hash === oid) && !h.done && h.commits.length < 5000) await this.loadHistory(cx, false);
      const i = h.commits.findIndex((c) => c.hash === oid);
      if (i < 0) { this.say("info", "Ese commit no está en las primeras 5000 entradas del historial."); cx.notify(); return; }
      this.historyScroll.scroll_to_item(i, "center");
      h.selected = null; this.selectCommit(oid, cx);
    });
  }

  setTab(tab) { this.tab = tab; this.store("tab", tab); }

  toggleGroup(id, cx) {
    if (this.collapsed.has(id)) this.collapsed.delete(id); else this.collapsed.add(id);
    this.store("collapsed", JSON.stringify([...this.collapsed]));
    cx.notify();
  }

  // ---------- accounts (author + push account, per project) ----------
  async loadProfiles() {
    try { const text = await readTextFile(PROFILES()); this.profilesText = text; this.profiles = text ? JSON.parse(text) : {}; }
    catch { this.profiles = {}; }
  }
  async saveProfile(login, name, email) {
    const next = { ...this.profiles, [login]: { name, email } };
    const text = JSON.stringify(next, null, 2) + "\n";
    try { await writeTextFile(PROFILES(), text, this.profilesText); }
    catch { await this.loadProfiles(); await writeTextFile(PROFILES(), JSON.stringify({ ...this.profiles, [login]: { name, email } }, null, 2) + "\n", this.profilesText); }
    this.profilesText = text; this.profiles = next;
  }
  /** gh's accounts and path, asked at most once a minute per machine (or when forced). */
  async ghInfo(on, force = false) {
    const k = on ?? "";
    const hit = this.gh.get(k);
    if (hit && !force && Date.now() - hit.at < 60000) return hit;
    const run = (cmd, args, o) => exec(cmd, args, { ...o, on: on ?? undefined });
    const [list, path] = await Promise.all([A.ghAccounts(run, on ?? undefined), hit?.path ? hit.path : A.ghPath(run, on ?? undefined)]);
    const info = { at: Date.now(), list, path };
    this.gh.set(k, info);
    return info;
  }
  async readAccount(git, root, remotes, on, force = false) {
    try {
      const gh = await this.ghInfo(on, force);
      const a = await A.repoAccount(git, root, remotes, gh.list);
      a.warnings = A.accountWarnings(a, this.profiles);
      return a;
    } catch { return null; }
  }

  accountMenu(cx) {
    const d = this.data, a = d?.account;
    if (!a) return;
    const busy = Boolean(this.op), items = [];
    const who = a.pushLogin ?? a.pin?.login;
    for (const acc of a.accounts) {
      const pinned = (a.pin?.login ?? a.manualPin) === acc.login;
      items.push({ id: `pin-${acc.login}`, label: pinned ? `✓ Fijado a ${acc.login} (editar…)` : `Fijar este proyecto a ${acc.login}…`, disabled: busy || a.foreignHelper,
        hint: a.foreignHelper ? "Este repo tiene su propio helper de credenciales" : "Autor de los commits y cuenta de push, solo en este repositorio", run: (cx) => this.askPin(acc.login, cx) });
    }
    if (!a.accounts.length) items.push({ id: "pin-none", label: a.https ? "No hay cuentas de gh para este remoto" : "Fijar autor de este proyecto…", disabled: busy || a.https, hint: a.https ? `Inicia sesión con: gh auth login --hostname ${a.host ?? "github.com"}` : "Con remoto SSH, la cuenta de push la decide tu llave SSH", run: (cx) => this.askPin(null, cx) });
    if (a.pin) items.push({ id: "unpin", label: "Quitar la fijación (usar la global)", disabled: busy, run: (cx) => this.askUnpin(cx) });
    else if (a.manualPin) items.push({ id: "unpin-manual", label: "Fijación hecha a mano (fuera del panel)", disabled: true, hint: "Está en .git/config. El panel no la quita: fija una cuenta desde aquí y podrás quitarla después." });
    const others = a.accounts.filter((x) => !x.active);
    if (a.https && others.length) {
      items.push({ sep: true, id: "s-global" });
      for (const x of others) items.push({ id: `global-${x.login}`, label: `Cuenta global de gh → ${x.login}…`, disabled: busy, hint: "Cambia la cuenta de todos los proyectos sin fijación", run: (cx) => this.askSwitchGlobal(x.login, cx) });
    }
    items.push({ sep: true, id: "s-info" });
    items.push({ id: "refresh-acc", label: "Volver a leer las cuentas de gh", run: (cx) => { this.ghInfo(d.on, true).then(() => this.refresh(cx)); } });
    const title = `${who ? `Push: ${who}` : "Push: —"} · Autor: ${a.email ?? "sin correo"}`;
    this.openMenu(title, items, cx);
  }

  askPin(login, cx) {
    const a = this.data?.account;
    if (!a) return;
    const prof = login ? this.profiles[login] : null;
    // Without a remembered profile, the current author only fits the account it already goes with.
    const useCurrent = !login || a.pin?.login === login || (!a.pin && a.pushLogin === login);
    const name = prof?.name ?? a.name ?? "";
    const email = prof?.email ?? (useCurrent ? a.email : "") ?? "";
    this.idName.set_value(name); this.idEmail.set_value(email);
    (email ? this.idName : this.idEmail).focus();
    this.sheet = { ctx: this.bound(), kind: "account", login, title: login ? `Fijar este proyecto a ${login}` : "Fijar el autor de este proyecto", account: a };
    cx.notify();
  }

  confirmPin(cx) {
    const s = this.sheet;
    if (s?.kind !== "account" || s.running) return;
    const name = this.idName.value().trim(), email = this.idEmail.value().trim();
    if (!name) { s.error = "Escribe el nombre que firmará los commits."; cx.notify(); return; }
    if (!EMAIL.test(email)) { s.error = "Escribe un correo válido."; cx.notify(); return; }
    const login = s.login;
    this.run(cx, login ? `Fijar cuenta ${login}` : "Fijar autor", async (f) => {
      const gh = await this.ghInfo(f.on, true);
      const a = await A.repoAccount(f.git, f.repo.root, await Q.remotes(f.git, f.repo.root), gh.list);
      if (login && a.https && !gh.list.some((x) => x.login === login && x.host === a.host)) throw new Error(`gh ya no tiene la sesión de ${login} en ${a.host}.`);
      await A.pin(f.git, f.repo, a, { login: login ?? "", name, email, gh: gh.path });
      if (login) await this.saveProfile(login, name, email);
    }, login ? `Este proyecto usa ahora ${login}: commits como ${email} y push con ${login}.` : `Los commits de este proyecto se firman como ${email}.`);
  }

  askUnpin(cx) {
    const a = this.data?.account;
    if (!a?.pin) return;
    const global = a.accounts.find((x) => x.active)?.login;
    this.sheet = { ctx: this.bound(), kind: "confirm", title: `Quitar la fijación a ${a.pin.login}`,
      detail: `Este proyecto volverá a usar la configuración global: el autor de tu ~/.gitconfig${global ? ` y la cuenta activa de gh (${global})` : ""}. Si el repositorio tenía un nombre o correo propio antes de fijarlo, se restaura. Solo se borra lo que escribió el panel en .git/config.`,
      action: "Quitar fijación", run: (cx) => this.run(cx, "Quitar cuenta fijada", async (f) => {
        const gh = await this.ghInfo(f.on);
        await A.unpin(f.git, f.repo, await A.repoAccount(f.git, f.repo.root, await Q.remotes(f.git, f.repo.root), gh.list));
      }, "Fijación quitada: el proyecto usa la cuenta global.") };
    cx.notify();
  }

  askSwitchGlobal(login, cx) {
    const a = this.data?.account;
    if (!a?.host) return;
    this.sheet = { ctx: this.bound(), kind: "confirm", title: `Cuenta global de gh → ${login}`,
      detail: `Todos los proyectos sin cuenta fijada harán fetch y push con ${login} en ${a.host}. El autor de los commits no cambia: eso es tu ~/.gitconfig, o la fijación de cada proyecto. Ejecuta: gh auth switch --hostname ${a.host} --user ${login}`,
      action: `Cambiar a ${login}`, run: (cx) => this.run(cx, `Cuenta global → ${login}`, async (f) => {
        await A.switchGlobal(f.git, f.repo.root, a.host, login);
        await this.ghInfo(f.on, true);
      }, `La cuenta global de gh es ahora ${login}.`) };
    cx.notify();
  }

  // ---------- messages ----------
  /** Success and info go to Herdr's own notifications; warnings and errors stay in the panel to be read. */
  say(level, text) {
    if (level === "ok" || level === "info") {
      notify({ title: this.data ? `Git · ${basename(this.data.repo.root)}` : "Git", body: text, level: level === "ok" ? "success" : "info", timeout: 4000 });
      if (this.banner && this.banner.level !== "block") this.banner = null;
      return;
    }
    this.banner = { level, text, at: Date.now() };
  }

  /** Runs a change: one at a time, visible, refreshed afterwards. */
  async act(cx, label, fn) {
    if (this.op) { this.say("warn", `Espera: ${this.op} sigue en curso.`); cx.notify(); return undefined; }
    this.op = label; this.banner = null; cx.notify();
    try { return await fn(); }
    finally { this.op = null; this.refresh(cx, { history: true }); cx.notify(); }
  }

  // ---------- context menu (a popup of this same mod) ----------
  openMenu(title, items, cx) {
    const nonce = Math.random().toString(36).slice(2);
    this.menuActions = new Map(items.filter((i) => i.run).map((i) => [i.id, i.run]));
    this.menuNonce = nonce;
    const height = items.reduce((h, i) => h + (i.sep ? 9 : 30), title ? 34 : 10) + 4;
    openOverlay({ mod: "git-panel", kind: "popup", width: 300, height, props: { menu: { owner: this.uid, nonce, title, items: items.map(({ run, ...rest }) => rest) } } });
    cx.notify();
  }

  takePick(cx) {
    const pick = shared(PICK);
    if (!pick || pick.owner !== this.uid || pick.nonce !== this.menuNonce) return;
    this.menuNonce = null;
    const run = this.menuActions.get(pick.id);
    cx.spawn(async (cx) => { setShared(PICK, null); run?.(cx); cx.notify(); });
  }

  branchMenu(ref, cx) {
    const d = this.data;
    if (!d) return;
    const head = d.status.head, detached = d.status.detached, busy = Boolean(this.op);
    const elsewhere = ref.type === "local" && ref.worktree && ref.worktree !== d.repo.root;
    const items = [];
    // Short labels; the counts say the rest.
    const sync = [];
    if (ref.type === "local") {
      const up = ref.upstream && !ref.gone ? ref.upstream : null;
      const n = (k, x) => (x ? ` ${k}${x}` : "");
      if (ref.current) {
        sync.push({ id: "pull", label: `Pull${n("↓", up && ref.behind)}`, disabled: busy || !up, hint: up ? `Fetch e integrar ${up}` : "No sigue a ninguna remota", run: (cx) => this.startPull(cx) });
        sync.push({ id: "push", label: up ? `Push${n("↑", ref.ahead)}` : "Publicar", disabled: busy, hint: up ? `A ${up}` : "Crear la rama en el remoto", run: (cx) => this.startPush(cx) });
      } else {
        if (up) sync.push({ id: "ff", label: `Actualizar${n("↓", ref.behind)}`, disabled: busy, hint: `Avanzar a ${up} sin cambiar de rama (fast-forward)`, run: (cx) => this.askFastForward(ref.name, cx) });
        sync.push({ id: "push", label: up ? `Push${n("↑", ref.ahead)}` : "Publicar", disabled: busy, hint: up ? `A ${up}, sin cambiar de rama` : "Crear la rama en el remoto", run: (cx) => this.startPush(cx, ref.name) });
      }
      sync.push({ sep: true, id: "s-sync" });
    }
    items.push(...sync);
    if (ref.type === "local" && ref.current) {
      items.push({ id: "merge-a", label: `Fusionar otra rama en ${head}…`, disabled: busy, run: (cx) => this.startMerge(cx) });
      items.push({ id: "hist", label: "Ver en History", run: (cx) => this.showInHistory(ref.oid, cx) });
      items.push({ sep: true, id: "s1" });
      items.push({ id: "new", label: "Nueva rama desde aquí…", disabled: busy, run: (cx) => this.askCreate(ref.name, cx) });
      items.push({ id: "rename", label: "Renombrar…", disabled: busy, run: (cx) => this.askRename(ref.name, cx) });
    } else if (ref.type === "local") {
      items.push({ id: "checkout", label: `Cambiar a ${ref.name}`, disabled: busy || elsewhere, hint: elsewhere ? "Abierta en otro worktree" : null, run: (cx) => this.askCheckout(ref.name, null, cx) });
      if (elsewhere) items.push({ id: "open-wt", label: "Ver ese worktree en el panel", run: (cx) => this.pinWorktree(ref.worktree, cx) });
      items.push({ sep: true, id: "s0" });
      items.push({ id: "integrate", label: detached ? `Fusionar HEAD → ${ref.name}` : `Fusionar ${head} → ${ref.name}…`, disabled: busy || detached, hint: detached ? "HEAD desacoplado: no hay rama que integrar" : `Cambia a ${ref.name} (con confirmación) y fusiona ${head} en ella`, run: (cx) => this.integrateInto(ref.name, cx) });
      items.push({ id: "merge-here", label: `Fusionar ${ref.name} → ${head ?? "HEAD"}…`, disabled: busy || detached, hint: `En la rama actual, sin cambiar de rama`, run: (cx) => this.preview(ref.name, cx) });
      items.push({ id: "compare", label: `Comparar con ${head ?? "HEAD"}`, run: (cx) => this.compare(ref.name, cx) });
      items.push({ id: "hist", label: "Ver en History", run: (cx) => this.showInHistory(ref.oid, cx) });
      items.push({ sep: true, id: "s1" });
      items.push({ id: "new", label: "Nueva rama desde aquí…", disabled: busy, run: (cx) => this.askCreate(ref.name, cx) });
      if (!ref.worktree) items.push({ id: "wt", label: "Abrir en un worktree nuevo…", disabled: busy, hint: "Sin cambiar la rama de este worktree", run: (cx) => this.askWorktreeFor(ref.name, cx) });
      items.push({ id: "rename", label: "Renombrar…", disabled: busy, run: (cx) => this.askRename(ref.name, cx) });
      items.push({ id: "delete", label: "Eliminar…", danger: true, disabled: busy || elsewhere, hint: elsewhere ? "Abierta en otro worktree" : null, run: (cx) => this.askDelete(ref.name, cx) });
    } else if (ref.type === "remote") {
      const local = ref.name.slice(ref.remote.length + 1);
      const exists = d.refs.some((r) => r.type === "local" && r.name === local);
      items.push({ id: "track", label: exists ? `Ya existe la rama local ${local}` : `Crear rama local ${local} que la siga`, disabled: busy || exists, run: (cx) => this.askTrack(ref.name, local, cx) });
      items.push({ id: "merge-here", label: `Fusionar ${ref.name} → ${head ?? "HEAD"}…`, disabled: busy || detached, hint: `En la rama actual, sin cambiar de rama`, run: (cx) => this.preview(ref.name, cx) });
      items.push({ id: "compare", label: `Comparar con ${head ?? "HEAD"}`, run: (cx) => this.compare(ref.name, cx) });
      items.push({ id: "hist", label: "Ver en History", run: (cx) => this.showInHistory(ref.oid, cx) });
      items.push({ sep: true, id: "s1" });
      items.push({ id: "new", label: "Nueva rama desde aquí…", disabled: busy, run: (cx) => this.askCreate(ref.name, cx) });
    } else {
      items.push({ id: "hist", label: "Ver en History", run: (cx) => this.showInHistory(ref.oid, cx) });
      items.push({ id: "compare", label: `Comparar con ${head ?? "HEAD"}`, run: (cx) => this.compare(ref.name, cx) });
      items.push({ id: "new", label: "Nueva rama desde este tag…", disabled: busy, run: (cx) => this.askCreate(ref.name, cx) });
    }
    this.openMenu(ref.name, items, cx);
  }





  pinWorktree(path, cx) {
    this.pinned = { cwd: path, on: this.context().on };
    this.sheet = null; this.refresh(cx); cx.notify();
  }
  unpin(cx) { this.pinned = null; this.refresh(cx); cx.notify(); }

  // ---------- fetch ----------
  fetch(cx) {
    const d = this.data;
    if (!d) return;
    if (!d.remotes.length) { this.say("info", "Este repositorio no tiene remotos."); cx.notify(); return; }
    // One remote: fetch it. Several: all of them (git fetch --all). Never --prune unasked.
    const remote = d.remotes.length === 1 ? d.remotes[0] : null;
    cx.spawn(async (cx) => {
      await this.act(cx, "Fetch", async () => {
        try { await O.fetch(this.git(d.on), d.repo, remote ?? undefined); this.say("ok", `Fetch completado${remote ? ` (${remote})` : " (todos los remotos)"}.`); }
        catch (e) { this.say("block", explain(e)); }
      });
    });
  }

  // ---------- merge, entry A (and "Fusionar X en la actual") ----------
  startMerge(cx) {
    const d = this.data;
    if (!d) return;
    if (d.status.detached || !d.status.head) { this.say("block", "HEAD está desacoplado: cambia a una rama antes de fusionar."); cx.notify(); return; }
    this.pickInput.set_value(""); this.pickText = "";
    this.sheet = { ctx: this.bound(), kind: "pick", purpose: "merge", title: `¿Qué rama quieres fusionar en ${d.status.head}?` };
    cx.notify();
  }

  startCompare(cx) {
    if (!this.data) return;
    this.pickInput.set_value(""); this.pickText = "";
    this.sheet = { ctx: this.bound(), kind: "pick", purpose: "compare", title: `Comparar ${this.data.status.head ?? "HEAD"} con…` };
    cx.notify();
  }

  picked(name, cx) {
    if (this.sheet?.purpose === "compare") this.compare(name, cx);
    else this.preview(name, cx);
  }

  /** The preview: always on fresh data; `entry` says how we got here. */
  preview(source, cx, entry = "A", ctx = null) {
    const head = this.data?.status.head;
    this.sheet = { kind: "preview", entry, source, target: head, loading: true, mode: "ff", ctx: ctx ?? this.bound() };
    const sheet = this.sheet;
    cx.spawn(async (cx) => {
      try {
        const f = await this.fresh(sheet);
        sheet.target = f.status.head;
        sheet.preview = await F.preview(f.git, { ...f, source, target: f.status.head });
        // The mode chosen last in this repository (never for Pull: it keeps Git's default).
        const saved = entry === "pull" ? null : this.stored(F.modeKey(f.repo, f.on));
        sheet.mode = F.modeFor(sheet.preview, saved);
        sheet.modeRemembered = Boolean(saved) && saved !== "ff" && sheet.mode === saved;
        // Nothing to integrate, from any entry point: a notification, not a blocked sheet.
        if (F.pullDecision(sheet.preview) === "up-to-date") {
          if (this.sheet === sheet) this.sheet = null;
          this.say("info", `${f.status.head} ya contiene todo lo de ${source}. No hay nada que integrar.`);
          cx.notify(); return;
        }
      } catch (e) { sheet.error = explain(e); }
      sheet.loading = false; cx.notify();
    });
    cx.notify();
  }

  confirmMerge(cx) {
    const sheet = this.sheet;
    if (!sheet?.preview || sheet.running) return;
    sheet.running = true; sheet.changed = false; cx.notify();
    cx.spawn(async (cx) => {
      await this.act(cx, `Merge ${sheet.source} → ${sheet.target}`, async () => {
        try {
          // Re-check right before: an agent may have moved something.
          const f = await this.fresh(sheet);
          const rv = await F.revalidate(f.git, { ...f, source: sheet.source, target: sheet.target }, sheet.preview);
          if (!rv.same) { sheet.preview = rv.fresh; sheet.mode = F.modeFor(rv.fresh, sheet.mode); sheet.changed = true; return; }
          const before = sheet.preview.targetSha;
          const r = await O.merge(f.git, f.repo, sheet.source, sheet.mode);
          const after = await Q.revParse(f.git, f.repo.root, "HEAD");
          if (r.conflicts) {
            const st = await Q.status(f.git, f.repo.root);
            this.sheet = { kind: "result", ok: false, conflicts: st.files.filter((x) => x.kind === "unmerged").map((x) => x.path), source: sheet.source, target: sheet.target };
            this.setTab("changes");
          } else {
            const ff = (await Q.leftRight(f.git, f.repo.root, before, after)).left === 0 && sheet.preview.ff && sheet.mode !== "no-ff";
            if (F.shouldRemember(sheet.entry, sheet.preview)) this.store(F.modeKey(f.repo, f.on), sheet.mode);
            this.sheet = { kind: "result", ok: true, ff, count: sheet.preview.incomingCount, source: sheet.source, target: sheet.target, head: after };
          }
        } catch (e) { sheet.error = explain(e); }
        finally { sheet.running = false; }
      });
    });
  }

  // ---------- merge, entry B: "Integrar mi rama en T" ----------
  integrateInto(target, cx) {
    const source = this.data?.status.head;
    if (!source) return;
    this.askCheckout(target, { source }, cx);
  }

  askCheckout(target, then, cx) {
    this.sheet = { kind: "checkout", target, then, loading: true, from: this.data?.status.head, ctx: this.bound() };
    const sheet = this.sheet;
    cx.spawn(async (cx) => {
      try {
        const f = await this.fresh(sheet);
        sheet.from = f.status.head;
        sheet.check = F.checkoutCheck({ ...f, target });
        if (then && f.status.head === target) { this.preview(then.source, cx, "B", sheet.ctx); return; }
      } catch (e) { sheet.error = explain(e); }
      sheet.loading = false; cx.notify();
    });
    cx.notify();
  }

  confirmCheckout(cx) {
    const sheet = this.sheet;
    if (!sheet || sheet.running) return;
    sheet.running = true; cx.notify();
    cx.spawn(async (cx) => {
      let switched = false;
      await this.act(cx, `Cambiar a ${sheet.target}`, async () => {
        try {
          const f = await this.fresh(sheet);
          const check = F.checkoutCheck({ ...f, target: sheet.target });
          if (check.blocks.length) { sheet.check = check; sheet.changed = true; return; }
          await O.switchBranch(f.git, f.repo, sheet.target);
          const now = await Q.status(f.git, f.repo.root);
          if (now.head !== sheet.target) { sheet.error = `Git terminó pero la rama activa es ${now.head ?? "HEAD desacoplado"}, no ${sheet.target}.`; return; }
          switched = true;
        } catch (e) { sheet.error = explain(e); }
        finally { sheet.running = false; }
      });
      if (!switched) { cx.notify(); return; }
      if (sheet.then) this.preview(sheet.then.source, cx, "B", sheet.ctx);
      else { this.sheet = null; this.say("ok", `Ahora estás en ${sheet.target}.`); }
      cx.notify();
    });
  }

  /** The target is open in another worktree: do the merge there, no checkout. */
  continueInWorktree(cx) {
    const sheet = this.sheet;
    const path = sheet?.check?.otherWorktree;
    if (!path) return;
    const ctx = { cwd: path, on: sheet.ctx?.on ?? null };
    this.pinned = ctx;
    this.refresh(cx);
    this.preview(sheet.then.source, cx, "B", ctx);
  }

  // ---------- abort ----------
  /** Whatever is in progress: merge, cherry-pick, revert, rebase (--abort) or bisect (reset). Always confirmed. */
  askAbort(cx) {
    if (!this.data) return;
    const c = F.inProgressCheck(this.data, "abort"), kind = c.op;
    if (c.blocks.length) { this.say("block", c.blocks.map((b) => b.text).join(" ")); cx.notify(); return; }
    const label = kind === "bisect" ? "Terminar bisect" : `Abortar ${kind}`;
    this.sheet = { ctx: this.bound(), kind: "confirm", title: c.title, detail: c.detail, command: c.command,
      action: label, danger: kind !== "bisect", run: (cx) => this.run(cx, label, async (f) => {
        const again = F.inProgressCheck(f, "abort");
        if (again.op !== kind || again.blocks.length) throw Object.assign(new Error(again.blocks[0]?.text ?? "La operación en curso cambió. Vuelve a intentarlo."), { plain: true });
        return O.abortOp(f.git, f.repo, kind);
      }, kind === "bisect" ? "Bisect terminado." : `${kind} abortado.`) };
    cx.notify();
  }

  /** After resolving a cherry-pick/revert: commit with Git's message and go on. */
  continueOp(cx) {
    const d = this.data;
    if (!d) return;
    const c = F.inProgressCheck(d, "continue"), kind = c.op;
    if (c.blocks.length) { this.say("block", c.blocks.map((b) => b.text).join(" ")); cx.notify(); return; }
    cx.spawn(async (cx) => {
      await this.act(cx, `Continuar ${kind}`, async () => {
        try {
          const f = await this.fresh();
          const again = F.inProgressCheck(f, "continue");
          if (again.op !== kind || again.blocks.length) { this.say("block", again.blocks[0]?.text ?? "La operación en curso cambió."); return; }
          const r = await O.continueOp(f.git, f.repo, kind);
          if (r.conflicts) { this.say("warn", `El ${kind} avanzó y se detuvo en otro commit con conflictos. Resuélvelos y vuelve a pulsar Continuar.`); this.setTab("changes"); }
          else if ((await Q.inProgress(f.git, f.repo.root, this.exists(f.on))).includes(kind)) this.say("info", `El ${kind} sigue en curso.`);
          else this.say("ok", `${kind} completado.`);
        }
        catch (e) { this.say("block", explain(e)); }
      });
    });
  }

  // ---------- cherry-pick / revert ----------
  askPick(commit, revert, cx) {
    const head = this.data?.status.head ?? "HEAD";
    this.sheet = { ctx: this.bound(), kind: "pick-commit", commit, revert, head, loading: true };
    const sheet = this.sheet;
    cx.spawn(async (cx) => {
      try { const f = await this.fresh(sheet); sheet.head = f.status.head ?? "HEAD"; sheet.preview = await F.pickPreview(f.git, { ...f, commit, revert }); }
      catch (e) { sheet.error = explain(e); }
      sheet.loading = false; cx.notify();
    });
    cx.notify();
  }

  confirmPick(cx) {
    const sheet = this.sheet;
    if (!sheet?.preview || sheet.running) return;
    sheet.running = true; cx.notify();
    const verb = sheet.revert ? "Revert" : "Cherry-pick";
    cx.spawn(async (cx) => {
      await this.act(cx, `${verb} ${sheet.commit.short}`, async () => {
        try {
          const f = await this.fresh(sheet);
          const fresh = await F.pickPreview(f.git, { ...f, commit: sheet.commit, revert: sheet.revert });
          if (fresh.snapshot !== sheet.preview.snapshot || fresh.blocks.length) { sheet.preview = fresh; sheet.changed = true; return; }
          const r = sheet.revert ? await O.revert(f.git, f.repo, sheet.commit.hash, fresh.mainline) : await O.cherryPick(f.git, f.repo, sheet.commit.hash, fresh.mainline);
          if (r.conflicts) {
            this.sheet = null; this.setTab("changes");
            this.say("warn", `${verb} detenido por conflictos. Resuélvelos, márcalos con ✓ y pulsa Continuar en la cabecera (o Abortar).`);
          } else { this.sheet = null; this.say("ok", `${verb} de ${sheet.commit.short} aplicado en ${f.status.head ?? "HEAD"}.`); }
        } catch (e) { sheet.error = explain(e); }
        finally { sheet.running = false; }
      });
    });
  }

  commitMenu(commit, cx) {
    const d = this.data, busy = Boolean(this.op), head = d?.status.head ?? "HEAD";
    this.openMenu(`${commit.short} · ${commit.subject}`, [
      { id: "diff", label: "Ver archivos y diferencias", run: (cx) => { this.history.selected = null; this.selectCommit(commit.hash, cx); } },
      { sep: true, id: "s0" },
      { id: "pick", label: `Cherry-pick en ${head}…`, disabled: busy, run: (cx) => this.askPick(commit, false, cx) },
      { id: "revert", label: `Revertir en ${head}…`, disabled: busy, hint: "Crea un commit nuevo que deshace este", run: (cx) => this.askPick(commit, true, cx) },
      { sep: true, id: "s1" },
      { id: "branch", label: "Nueva rama desde aquí…", disabled: busy, run: (cx) => this.askCreate(commit.hash, cx) },
      { id: "wt", label: "Nuevo worktree desde aquí…", disabled: busy, run: (cx) => this.askWorktreeNew(commit.hash, cx) },
    ], cx);
  }

  // ---------- conflicts ----------
  openConflict(path, cx) {
    const d = this.data;
    const kind = d.ops[0] ?? "merge";
    this.sheet = { ctx: this.bound(), kind: "conflict", path, op: kind, loading: true };
    const sheet = this.sheet;
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(`${d.repo.root}/${path}`, { on: d.on });
        if (text === null) { sheet.markers = 0; sheet.diff = { rows: [], error: "El archivo no existe en el working tree (uno de los lados lo borró). Usa una de las dos versiones." }; }
        else if (text.includes("\0")) { sheet.markers = null; sheet.diff = { rows: [], binary: true }; }
        else { sheet.markers = (text.match(/^<{7}( |$)/gm) ?? []).length; sheet.diff = conflictRows(text); }
      } catch (e) { sheet.error = explain(e); }
      sheet.loading = false; cx.notify();
    });
    cx.notify();
  }

  /** side "ours" (HEAD) / "theirs" (incoming). Confirmed in the sheet: it drops the other side's edits in that file. */
  resolveSide(side, cx) {
    const s = this.sheet;
    if (!s || s.kind !== "conflict") return;
    const back = s, head = this.data?.status.head ?? "HEAD";
    const L = F.sideLabels(s.op, head, this.data?.rebase), mine = L.oursLong, theirs = L.theirsLong;
    this.sheet = { ctx: s.ctx, kind: "confirm", title: `Resolver ${s.path} con ${side === "ours" ? mine : theirs}`,
      detail: `El archivo queda exactamente como ${side === "ours" ? mine : theirs} y se marca como resuelto. Los cambios del otro lado en este archivo se descartan (siguen en su commit, nada se pierde del historial).`,
      action: "Resolver así", danger: true, back,
      run: (cx) => this.run(cx, `Resolver ${s.path}`, (f) => O.resolveWith(f.git, f.repo, s.path, side), `${s.path} resuelto.`) };
    cx.notify();
  }

  // ---------- worktrees ----------
  worktreeMenu(wt, cx) {
    const d = this.data, busy = Boolean(this.op);
    const current = wt.path === d.repo.root, main = wt === d.worktrees[0];
    this.openMenu(wt.branch ?? wt.path, [
      { id: "view", label: current ? "Es el worktree que estás viendo" : "Ver este worktree en el panel", disabled: current, run: (cx) => this.pinWorktree(wt.path, cx) },
      { id: "space", label: "Abrir en un espacio nuevo de Herdr", disabled: Boolean(wt.prunable), run: (cx) => { runCommand("space.new", { folder: wt.path, machine: d.on ?? "" }); this.say("ok", `Espacio abierto en ${wt.path}.`); cx.notify(); } },
      { sep: true, id: "s0" },
      { id: "remove", label: "Eliminar worktree…", danger: true, disabled: busy || main || current, hint: main ? "Es el principal" : current ? "Es el actual" : null, run: (cx) => this.askWorktreeRemove(wt.path, cx) },
      ...(d.worktrees.some((w) => w.prunable) ? [{ id: "prune", label: "Podar worktrees cuya carpeta ya no existe", disabled: busy, run: (cx) => this.askPrune(cx) }] : []),
    ], cx);
  }

  /** An existing branch in its own worktree (Herdr's folder convention). */
  askWorktreeFor(branch, cx) {
    const d = this.data;
    const path = F.worktreePath(home(), d.repo.commonDir, branch);
    this.sheet = { ctx: this.bound(), kind: "confirm", title: `Abrir ${branch} en un worktree nuevo`,
      detail: `Se crea una carpeta en ${path} con ${branch}, para trabajar en ella (o con un agente) sin cambiar la rama de este worktree. Después puedes abrirla en un espacio de Herdr.`,
      action: "Crear worktree", run: (cx) => this.run(cx, `Worktree ${branch}`, (f) => O.worktreeAdd(f.git, f.repo, path, branch, false), `Worktree creado en ${path}. Menú del worktree → Abrir en un espacio.`) };
    cx.notify();
  }

  /** A new branch from `start` in its own worktree. */
  askWorktreeNew(start, cx) {
    this.nameInput.set_value(""); this.nameInput.focus();
    this.sheet = { ctx: this.bound(), kind: "input", title: `Nuevo worktree desde ${start.length === 40 ? start.slice(0, 7) : start}`, value: "", start, purpose: "worktree",
      hint: "Se crea la rama y su carpeta en ~/.herdr/worktrees/<repo>/<rama>." };
    cx.notify();
  }

  askWorktreeRemove(path, cx) {
    const d = this.data;
    const check = F.worktreeRemoveCheck({ repo: d.repo, worktrees: d.worktrees, target: path });
    if (check.blocks.length) { this.say("block", check.blocks[0].text); cx.notify(); return; }
    this.sheet = { ctx: this.bound(), kind: "confirm", title: "¿Eliminar este worktree?",
      detail: `Se borra la carpeta ${path} (git worktree remove, sin --force). Git se niega si tiene cambios sin commit o archivos sin seguimiento: en ese caso no se borra nada. ${check.warnings.map((w) => w.text).join(" ")}`,
      action: "Eliminar worktree", danger: true, run: (cx) => this.run(cx, "Eliminar worktree", (f) => O.worktreeRemove(f.git, f.repo, path), "Worktree eliminado.") };
    cx.notify();
  }

  askPrune(cx) {
    const gone = this.data.worktrees.filter((w) => w.prunable);
    this.sheet = { ctx: this.bound(), kind: "confirm", title: "Podar worktrees huérfanos",
      detail: `Git olvida ${gone.length} worktree(s) cuya carpeta ya no existe (${gone.map((w) => w.branch ?? w.path).join(", ")}). No se borra ninguna rama ni archivo.`,
      action: "Podar", run: (cx) => this.run(cx, "Podar worktrees", (f) => O.worktreePrune(f.git, f.repo), "Worktrees huérfanos olvidados.") };
    cx.notify();
  }

  // ---------- keyboard ----------
  /** Keys while the panel has focus and no text field does. */
  key(e, cx) {
    if (this.typing.size) {
      if (e.key === "escape") { this.handle.focus(); this.typing.clear(); cx.notify(); return true; }
      return false;
    }
    if (e.key === "escape") {
      if (this.sheet) { this.closeSheet(cx); return true; }
      if (this.history.selected) { this.history.selected = null; this.history.detail = null; cx.notify(); return true; }
      return false;
    }
    if (this.sheet || !this.data || e.modifiers?.platform || e.modifiers?.control || e.modifiers?.alt) return false;
    const k = e.key;
    if (k === "1" || k === "2" || k === "3") { this.setTab(["changes", "branches", "history"][+k - 1]); cx.notify(); return true; }
    if (k === "/" && this.tab === "branches") { this.filter.focus(); return true; }
    if (k === "f") { this.fetch(cx); return true; }
    if (k === "m") { this.startMerge(cx); return true; }
    if (k === "g" && this.tab === "history") { this.graphOn = !this.graphOn; this.store("graph", this.graphOn ? "1" : "0"); cx.notify(); return true; }
    if (k === "up" || k === "down" || k === "k" || k === "j") {
      const step = k === "up" || k === "k" ? -1 : 1;
      if (this.tab === "branches") {
        const keys = (this.branchKeys ?? []).filter((x) => !x.startsWith("g:"));
        if (!keys.length) return true;
        const i = Math.max(-1, keys.indexOf(this.selectedRef));
        const next = keys[Math.min(keys.length - 1, Math.max(0, i + step))];
        this.selectedRef = next;
        const at = (this.branchKeys ?? []).indexOf(next);
        if (at >= 0) this.branchScroll.scroll_to_item(at);
      } else if (this.tab === "history") {
        const list = this.history.commits;
        if (!list.length) return true;
        const i = Math.max(-1, list.findIndex((c) => c.hash === this.history.cursor));
        const n = Math.min(list.length - 1, Math.max(0, i + step));
        this.history.cursor = list[n].hash;
        this.historyScroll.scroll_to_item(n);
      }
      cx.notify(); return true;
    }
    if (k === "enter") {
      if (this.tab === "branches") { const ref = this.data.refs.find((r) => r.ref === this.selectedRef); if (ref) this.branchMenu(ref, cx); return true; }
      if (this.tab === "history" && this.history.cursor) { this.selectCommit(this.history.cursor, cx); return true; }
    }
    if (k === "space" && this.tab === "history" && this.history.cursor) {
      const c = this.history.commits.find((x) => x.hash === this.history.cursor);
      if (c) this.commitMenu(c, cx);
      return true;
    }
    return false;
  }

  // ---------- branches ----------
  askCreate(start, cx) {
    this.nameInput.set_value(""); this.nameInput.focus();
    this.sheet = { ctx: this.bound(), kind: "input", title: `Nueva rama desde ${start}`, value: "", checkout: true, start, purpose: "create" };
    cx.notify();
  }
  askRename(name, cx) {
    this.nameInput.set_value(name); this.nameInput.focus();
    this.sheet = { ctx: this.bound(), kind: "input", title: `Renombrar ${name}`, value: name, from: name, purpose: "rename" };
    cx.notify();
  }
  askTrack(remoteName, local, cx) {
    this.sheet = { ctx: this.bound(), kind: "confirm", title: `Crear ${local} desde ${remoteName}`, detail: `Se crea la rama local ${local}, que sigue a ${remoteName}, y se cambia a ella. Los cambios sin commit se conservan; Git se detiene si alguno chocara.`,
      action: `Crear y cambiar a ${local}`, run: (cx) => this.run(cx, `Crear ${local}`, (f) => O.trackRemote(f.git, f.repo, remoteName, local), `Ahora estás en ${local}.`) };
    cx.notify();
  }
  askDelete(name, cx) {
    this.sheet = { ctx: this.bound(), kind: "confirm", title: `¿Eliminar la rama ${name}?`, detail: "Solo se elimina si sus commits ya están integrados en otra rama (git branch -d). Los remotos no se tocan.",
      action: "Eliminar rama", danger: true, run: (cx) => this.deleteBranch(name, false, cx) };
    cx.notify();
  }
  deleteBranch(name, force, cx) {
    const s = this.sheet;
    cx.spawn(async (cx) => {
      await this.act(cx, `Eliminar ${name}`, async () => {
        try { const f = await this.fresh(s); await O.deleteBranch(f.git, f.repo, name, force); this.sheet = null; this.say("ok", `Rama ${name} eliminada.`); }
        catch (e) {
          if (!force && /not fully merged/i.test(e.stderr ?? "")) {
            this.sheet = { ctx: this.bound(), kind: "confirm", title: `${name} tiene commits sin integrar`, detail: `Si la eliminas, esos commits quedarán sin ninguna rama que los apunte (se podrían recuperar con git reflog durante un tiempo). Esta acción usa git branch -D.`,
              action: "Eliminar de todos modos", danger: true, ctx: s?.ctx, run: (cx) => this.deleteBranch(name, true, cx) };
          } else { this.sheet = null; this.say("block", explain(e)); }
        }
      });
    });
  }

  submitInput(cx) {
    const s = this.sheet;
    const name = (s.value ?? "").trim();
    if (!name || s.running) return;
    s.running = true; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const f = await this.fresh(s);
        if (!(await Q.checkBranchName(f.git, f.repo.root, name))) { s.error = "Ese nombre no es válido para una rama de Git."; return; }
        if (f.refs.some((r) => r.type === "local" && r.name === name) && name !== s.from) { s.error = "Ya existe una rama con ese nombre."; return; }
        if (s.purpose === "rename" && name === s.from) { this.sheet = null; return; }
        await this.act(cx, s.purpose === "rename" ? `Renombrar ${s.from}` : s.purpose === "worktree" ? `Worktree ${name}` : `Crear ${name}`, async () => {
          try {
            if (s.purpose === "rename") { await O.renameBranch(f.git, f.repo, s.from, name); this.say("ok", `${s.from} ahora se llama ${name}.`); }
            else if (s.purpose === "worktree") {
              const path = F.worktreePath(home(), f.repo.commonDir, name);
              await O.worktreeAdd(f.git, f.repo, path, name, true, s.start);
              this.say("ok", `Rama ${name} creada en el worktree ${path}. Menú del worktree → Abrir en un espacio.`);
            }
            else { await O.createBranch(f.git, f.repo, name, s.start, s.checkout); this.say("ok", s.checkout ? `Creada ${name}; ahora estás en ella.` : `Creada ${name}.`); }
            this.sheet = null;
          } catch (e) { s.error = explain(e); }
        });
      } catch (e) { s.error = explain(e); }
      finally { s.running = false; cx.notify(); }
    });
  }

  /** A confirmed change: runs, then closes the sheet or shows why not. */
  run(cx, label, fn, success) {
    const s = this.sheet;
    if (s) s.running = true;
    cx.spawn(async (cx) => {
      await this.act(cx, label, async () => {
        try { const f = await this.fresh(s); await fn(f); if (this.sheet === s) this.sheet = null; if (success) this.say("ok", success); }
        catch (e) { if (s && this.sheet === s) { s.error = explain(e); s.running = false; } else this.say("block", explain(e)); }
      });
    });
    cx.notify();
  }

  // ---------- compare ----------
  compare(other, cx) {
    const head = this.data?.status.head ?? "HEAD";
    this.sheet = { ctx: this.bound(), kind: "compare", a: head, b: other, loading: true };
    const sheet = this.sheet;
    cx.spawn(async (cx) => {
      try {
        const f = await this.fresh(sheet), root = f.repo.root;
        const lr = await Q.leftRight(f.git, root, "HEAD", other);
        const base = await Q.mergeBase(f.git, root, "HEAD", other);
        const [onlyA, onlyB, files] = await Promise.all([Q.between(f.git, root, other, "HEAD", 30), Q.between(f.git, root, "HEAD", other, 30), base ? Q.changedFiles(f.git, root, "HEAD", other) : []]);
        Object.assign(sheet, { lr, base, onlyA, onlyB, files });
      } catch (e) { sheet.error = explain(e); }
      sheet.loading = false; cx.notify();
    });
    cx.notify();
  }

  /** Esc / ×: back to the sheet this one came from (a confirm over the conflict view), else closed. */
  closeSheet(cx) { if (this.sheet?.running) return; this.sheet = this.sheet?.back && this.sheet.kind === "confirm" ? this.sheet.back : null; this.handle.focus(); cx.notify(); }

  // ---------- Changes: stage, unstage, commit, diff ----------
  /** After a refresh: keep the selected file's diff current, drop it if the file left that group. */
  syncChangeSelection(cx) {
    const sel = this.changeSel, d = this.data;
    if (!sel || !d) return;
    const still = d.status.files.some((f) => f.path === sel.path && whichOf(f).includes(sel.which));
    if (!still) { this.changeSel = null; this.diff = null; return; }
    this.loadChangeDiff(cx, true);
  }

  selectChange(path, which, cx) {
    if (this.changeSel?.path === path && this.changeSel.which === which) { this.changeSel = null; this.diff = null; cx.notify(); return; }
    this.changeSel = { path, which };
    this.loadChangeDiff(cx, false);
    cx.notify();
  }

  loadChangeDiff(cx, quiet) {
    const sel = this.changeSel, d = this.data;
    if (!sel || !d) return;
    const key = JSON.stringify([d.repo.root, sel.path, sel.which]);
    if (!quiet || this.diff?.key !== key) this.diff = { key, loading: true, rows: [] };
    cx.spawn(async (cx) => {
      try {
        const text = await Q.fileDiff(this.git(d.on), d.repo.root, sel.path, sel.which);
        if (this.changeSel === sel) this.diff = { key, ...diffRows(text) };
      } catch (e) { if (this.changeSel === sel) this.diff = { key, rows: [], error: explain(e) }; }
      cx.notify();
    });
  }

  stagePaths(paths, cx) {
    if (!paths.length) return;
    cx.spawn(async (cx) => {
      await this.act(cx, paths.length === 1 ? `Stage ${paths[0]}` : `Stage ${paths.length} archivos`, async () => {
        try { const f = await this.fresh(); await O.stage(f.git, f.repo, paths); }
        catch (e) { this.say("block", explain(e)); }
      });
    });
  }

  unstagePaths(paths, cx) {
    if (!paths.length) return;
    cx.spawn(async (cx) => {
      await this.act(cx, paths.length === 1 ? `Unstage ${paths[0]}` : `Unstage ${paths.length} archivos`, async () => {
        try { const f = await this.fresh(); await O.unstage(f.git, f.repo, paths, Boolean(f.status.oid)); }
        catch (e) { this.say("block", explain(e)); }
      });
    });
  }

  /** A conflicted file: staging it tells Git it's resolved. Markers left in it ask first. */
  markResolved(path, cx) {
    const d = this.data;
    cx.spawn(async (cx) => {
      let text = null;
      try { text = await readTextFile(`${d.repo.root}/${path}`, { on: d.on }); } catch {}
      if (hasConflictMarkers(text)) {
        this.sheet = { ctx: this.bound(), kind: "confirm", title: `${path} todavía tiene marcadores de conflicto`,
          detail: "El archivo aún contiene líneas <<<<<<< / >>>>>>>. Si lo marcas como resuelto, esas líneas entrarán en el commit tal cual. Normalmente conviene editarlo primero.",
          action: "Marcar resuelto igualmente", danger: true, run: (cx) => this.run(cx, `Resolver ${path}`, (f) => O.stage(f.git, f.repo, [path]), `${path} marcado como resuelto.`) };
      } else this.stagePaths([path], cx);
      cx.notify();
    });
  }

  doCommit(cx) {
    const d = this.data;
    if (!d || this.op) return;
    const message = this.commitText.trim();
    const merging = d.ops.includes("merge");
    if (!message && !merging) { this.say("warn", "Escribe un mensaje para el commit."); cx.notify(); return; }
    if (d.status.summary.conflicts) { this.say("block", "Quedan archivos en conflicto: resuélvelos y márcalos como resueltos antes del commit."); cx.notify(); return; }
    if (!d.status.summary.staged && !merging) { this.say("warn", "No hay nada en stage. Añade archivos con + antes del commit."); cx.notify(); return; }
    cx.spawn(async (cx) => {
      await this.act(cx, merging ? "Concluir merge" : "Commit", async () => {
        try {
          const f = await this.fresh();
          await O.commit(f.git, f.repo, message || null);
          this.commitInput.set_value(""); this.commitText = "";
          const sha = await Q.revParse(f.git, f.repo.root, "HEAD");
          this.say("ok", merging ? `Merge concluido (${sha?.slice(0, 7)}).` : `Commit ${sha?.slice(0, 7)} creado en ${f.status.head ?? "HEAD"}.`);
        } catch (e) { this.say("block", explain(e)); }
      });
    });
  }

  // ---------- pull / push ----------
  /** Pull = fetch the upstream, then the merge preview with the upstream as source. */
  startPull(cx) {
    const d = this.data;
    if (!d || this.op) return;
    const pc = F.pullCheck(d);
    if (pc.blocks.length) { this.say("block", pc.blocks[0].text); cx.notify(); return; }
    const ctx = this.bound();
    cx.spawn(async (cx) => {
      let fetched = false;
      await this.act(cx, `Fetch ${pc.remote}`, async () => {
        try { await O.fetch(this.git(ctx.on), d.repo, pc.remote); fetched = true; }
        catch (e) { this.say("block", explain(e)); }
      });
      if (!fetched) { cx.notify(); return; }
      // Like Fork: nothing to bring → just say so; a clean fast-forward → do it; anything else → preview.
      try {
        const f = await this.fresh({ ctx });
        const p = await F.preview(f.git, { ...f, source: pc.upstream, target: f.status.head });
        const decision = F.pullDecision(p);
        if (decision === "up-to-date") this.say("info", `${f.status.head} ya está al día con ${pc.upstream}.`);
        else if (decision === "fast") {
          await this.act(cx, `Pull ${f.status.head}`, async () => {
            try {
              const g = await this.fresh({ ctx });
              const again = await F.preview(g.git, { ...g, source: pc.upstream, target: g.status.head });
              if (F.pullDecision(again) !== "fast") { this.preview(pc.upstream, cx, "pull", ctx); return; }
              await O.merge(g.git, g.repo, pc.upstream, "ff-only");
              this.say("ok", `${g.status.head} actualizada: ↓${again.incomingCount} commit(s) de ${pc.upstream}.`);
            } catch (e) { this.say("block", explain(e)); }
          });
        } else this.preview(pc.upstream, cx, "pull", ctx);
      } catch (e) { this.say("block", explain(e)); }
      cx.notify();
    });
  }

  startPush(cx, branch = null) {
    const d = this.data;
    if (!d) return;
    const quick = F.pushCheck({ ...d, branch: branch ?? undefined });
    if (quick.blocks.length === 1 && quick.blocks[0].id === "nothing") { this.say("info", quick.blocks[0].text); cx.notify(); return; }
    this.sheet = { ctx: this.bound(), kind: "push", loading: true, branch, account: d.account };
    const sheet = this.sheet;
    cx.spawn(async (cx) => {
      try {
        const f = await this.fresh(sheet);
        const remotes = await Q.remotes(f.git, f.repo.root);
        sheet.check = F.pushCheck({ ...f, remotes, branch: sheet.branch ?? undefined });
        if (sheet.check.blocks.length === 1 && sheet.check.blocks[0].id === "nothing") {
          if (this.sheet === sheet) this.sheet = null;
          this.say("info", sheet.check.blocks[0].text); cx.notify(); return;
        }
        const tip = `refs/heads/${sheet.check.branch}`;
        sheet.commits = sheet.check.upstream && !sheet.check.blocks.length ? await Q.between(f.git, f.repo.root, sheet.check.upstream, tip, 30) : [];
      } catch (e) { sheet.error = explain(e); }
      sheet.loading = false; cx.notify();
    });
    cx.notify();
  }

  confirmPush(cx) {
    const sheet = this.sheet;
    if (!sheet?.check || sheet.running) return;
    sheet.running = true; cx.notify();
    cx.spawn(async (cx) => {
      await this.act(cx, `Push ${sheet.check.branch}`, async () => {
        try {
          const f = await this.fresh(sheet);
          const check = F.pushCheck({ ...f, remotes: await Q.remotes(f.git, f.repo.root), branch: sheet.branch ?? undefined });
          if (check.blocks.length) { sheet.check = check; sheet.changed = true; return; }
          await O.push(f.git, f.repo, check.remote, check.branch, check.setUpstream);
          this.sheet = null;
          this.say("ok", check.setUpstream ? `${check.branch} publicada en ${check.remote}.` : `Push de ${check.branch} a ${check.upstream} completado.`);
        } catch (e) { sheet.rejected = /rejected|non-fast-forward|fetch first/i.test(e.stderr ?? ""); sheet.error = sheet.rejected ? "El remoto rechazó el push porque tiene commits que tú no tienes. Haz Pull primero. Este panel nunca hace force push." : explain(e); }
        finally { sheet.running = false; }
      });
    });
  }

  /** A branch behind its upstream, not checked out: fetch, then fast-forward only. */
  askFastForward(branch, cx) {
    const d = this.data;
    if (!d) return;
    // No sheet while fetching: the header shows the work. A sheet only appears if there's something to read.
    const sheet = { ctx: this.bound(), kind: "ff", branch, loading: true };
    cx.spawn(async (cx) => {
      try {
        const f = await this.fresh(sheet);
        const pre = F.fastForwardCheck({ ...f, branch });
        // Fresh remote refs first, so "behind" is real (the counts shown came from the last fetch).
        if (pre.remote) {
          await this.act(cx, `Fetch ${pre.remote}`, async () => {
            try { await O.fetch(f.git, f.repo, pre.remote); } catch (e) { sheet.fetchError = explain(e); }
          });
        }
        const g = await this.fresh(sheet);
        sheet.check = F.fastForwardCheck({ ...g, branch });
        const only = sheet.check.blocks.length === 1 ? sheet.check.blocks[0].id : null;
        if (only === "up-to-date") {
          this.say("info", sheet.check.blocks[0].text); cx.notify(); return;
        }
        // A clean fast-forward of another branch touches neither HEAD nor files: just do it.
        if (!sheet.check.blocks.length && !sheet.fetchError) {
          await this.act(cx, `Actualizar ${branch}`, async () => {
            try {
              const h = await this.fresh(sheet);
              const again = F.fastForwardCheck({ ...h, branch });
              if (again.blocks.length) { this.sheet = { ...sheet, check: again, loading: false, changed: true }; return; }
              await O.fastForwardBranch(h.git, h.repo, branch, again.upstream);
              this.say("ok", `${branch} actualizada: ↓${again.behind} commit(s) de ${again.upstream}. Tu rama actual no cambió.`);
            } catch (e) { this.say("block", explain(e)); }
          });
          cx.notify(); return;
        }
        sheet.commits = sheet.check.upstream && !sheet.check.blocks.length ? await Q.between(g.git, g.repo.root, `refs/heads/${branch}`, sheet.check.upstream, 30) : [];
      } catch (e) { sheet.error = explain(e); }
      sheet.loading = false;
      this.sheet = sheet; // diverged, other worktree, failed fetch or an error: worth reading
      cx.notify();
    });
    cx.notify();
  }

  confirmFastForward(cx) {
    const sheet = this.sheet;
    if (!sheet?.check || sheet.running) return;
    sheet.running = true; cx.notify();
    cx.spawn(async (cx) => {
      await this.act(cx, `Actualizar ${sheet.branch}`, async () => {
        try {
          const f = await this.fresh(sheet);
          const check = F.fastForwardCheck({ ...f, branch: sheet.branch });
          if (check.blocks.length) { sheet.check = check; sheet.changed = true; return; }
          await O.fastForwardBranch(f.git, f.repo, sheet.branch, check.upstream);
          this.sheet = null;
          this.say("ok", `${sheet.branch} avanzó ${check.behind} commit(s) hasta ${check.upstream}. Tu rama actual y tus archivos no cambiaron.`);
        } catch (e) { sheet.error = explain(e); }
        finally { sheet.running = false; }
      });
    });
  }

  // ---------- diffs in a sheet (History, Compare) ----------
  showDiff(title, path, which, cx) {
    const back = this.sheet, d = this.data;
    this.sheet = { ctx: this.bound(), kind: "diff", title, path, back, diff: { loading: true, rows: [] } };
    const sheet = this.sheet;
    cx.spawn(async (cx) => {
      try { sheet.diff = diffRows(await Q.fileDiff(this.git(d.on), d.repo.root, path, which)); }
      catch (e) { sheet.diff = { rows: [], error: explain(e) }; }
      cx.notify();
    });
    cx.notify();
  }

  // ---------- Files (code-files) ----------
  /** Opens a file in the editor: shows Files, then asks code-files through shared state. */
  openInFiles(path, cx) {
    const d = this.data;
    if (!d) return;
    const abs = `${d.repo.root}/${path}`;
    runCommand("layout.select", { stack: "panel-body", child: "files" });
    runCommand("layout.show", { id: "panel" });
    setShared("code-files.open", { path: abs, on: d.on ?? null, nonce: Math.random().toString(36).slice(2), at: Date.now() });
    cx.notify();
  }

  // ---------- render ----------
  render(cx) {
    if (this.kind === "menu") return renderMenu(this, cx);
    if (this.contextKey() !== this.ctxKey) this.refresh(cx);
    this.takePick(cx);
    return renderPanel(this, cx);
  }
}
