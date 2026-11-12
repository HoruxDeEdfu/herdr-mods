// Files with an editor: the project tree, files open in tabs, edits saved with
// Cmd/Ctrl+S. Saves never replace a file an agent changed meanwhile: writeTextFile
// only writes over the text this tab loaded, and a changed file asks first.
// Tabs belong to the space and come back after a restart; unsaved edits are kept
// as drafts in .drafts/ until saved or discarded.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, ScrollHandle, Scrollbar, v_virtual_list, TextView } from "gpui-base";
import { spaces, readTextFile, writeTextFile, watchFolder, nextCommand, theme, settings, shared, setShared, home, exec, window } from "herdr";
import { location, locationKey, languageOf, directory, PER_FOLDER, TOTAL } from "./tree.js";
import { lineDiff } from "./diff.js";
import { loadDrafts, saveDrafts } from "./drafts.js";

const SESSIONS = "code-files.sessions";
const WIDE = 640, TREE_WIDTH = 230, POLL = 3000;
const basename = (path) => path.split(/[\\/]/).pop() || path;
const isMarkdown = (path) => /\.(md|markdown|mdx)$/i.test(path);

export default class CodeFiles extends View {
  init(_props, cx) {
    // Tree (as Herdr's Files): follows the focused pane's folder.
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    // Tabs: one session per space, kept alive while the panel lives.
    this.sessions = new Map(); this.spaceId = undefined;
    this.drafts = {}; this.draftsChanged = false; this.ready = false;
    this.width = 0; this.treeWide = true; this.treeNarrow = false;
    this.view = "editor"; this.diff = null; this.confirm = null; this.flash = null; this.ticks = 0;
    this.tabScroll = ScrollHandle.new();
    this.handle = cx.focus_handle();
    this.dialogHandle = cx.focus_handle();
    // Cmd+W closes the file tab while this panel has the keyboard, not Herdr's tab.
    // Bound here (a key context of our own) so keys.json stays Herdr's and keeps updating.
    try { console.log(`code-files: ${cx.bind_keys([{ keystroke: "cmd-w", action: "code_files_close_tab", context: "CodeFiles" }])} key binding`); }
    catch (e) { console.log(`code-files: cannot bind cmd-w: ${e}`); }
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
    cx.timer.every(POLL, cx => this.tick(cx));
    cx.spawn(async cx => {
      this.drafts = await loadDrafts();
      this.ready = true;
      cx.notify();
    });
    cx.spawn(async cx => {
      for (;;) {
        const c = await nextCommand();
        if (c === "save") this.save(this.activeBuffer(), cx);
        else if (c === "close-tab") this.requestClose(this.activeBuffer(), cx);
        else if (c === "focus") this.handle.focus();
        else if (c === "toggle-mode") { const b = this.activeBuffer(); if (b) this.setMode(b, b.mode === "edit" ? "view" : "edit", cx); }
        cx.notify();
      }
    });
  }

  async close() {
    this.collectDrafts();
    if (this.draftsChanged) await saveDrafts(this.drafts);
  }

  // ---------- sessions ----------

  session() {
    if (!this.sessions.has(this.spaceId)) this.sessions.set(this.spaceId, { tabs: [], active: null });
    return this.sessions.get(this.spaceId);
  }
  activeBuffer() {
    const s = this.session();
    const buf = s.tabs.find(b => b.path === s.active) ?? s.tabs[0] ?? null;
    if (buf) s.active = buf.path;
    return buf;
  }

  switchSpace(space, cx) {
    this.spaceId = space; this.view = "editor"; this.diff = null; this.confirm = null;
    if (this.sessions.has(space)) { for (const b of this.session().tabs) this.check(b, cx); return; }
    const stored = (shared(SESSIONS) ?? {})[space];
    const s = this.session();
    for (const f of stored?.files ?? []) this.open(f.path, f.on ?? null, cx, false);
    s.active = stored?.active && s.tabs.some(b => b.path === stored.active) ? stored.active : s.tabs[0]?.path ?? null;
  }

  persist() {
    const live = new Set(spaces().map(s => s.id)), all = {};
    for (const [id, v] of Object.entries(shared(SESSIONS) ?? {})) if (live.has(id)) all[id] = v;
    const s = this.session();
    all[this.spaceId] = { files: s.tabs.map(b => ({ path: b.path, on: b.on })), active: s.active };
    if (!s.tabs.length) delete all[this.spaceId];
    if (JSON.stringify(all) !== JSON.stringify(shared(SESSIONS) ?? {})) setShared(SESSIONS, all);
  }

  // ---------- buffers ----------

  open(path, on, cx, activate = true) {
    const s = this.session();
    let buf = s.tabs.find(b => b.path === path);
    if (!buf) {
      buf = { path, on, name: basename(path), state: null, baseline: null, dirty: false, readonly: Boolean(on),
              missing: false, error: null, conflict: null, overwrite: false, loading: true, saving: false,
              // Every file opens to read; editing is a deliberate switch (Edit, Cmd+E).
              mode: "view", viewText: "", viewState: null };
      s.tabs.push(buf);
      this.load(buf, cx);
    }
    if (activate) {
      s.active = path; this.view = "editor"; this.diff = null;
      if (this.width < WIDE) this.treeNarrow = false;
      this.tabScroll.scroll_to_item(s.tabs.indexOf(buf));
    }
    this.persist();
    return buf;
  }

  load(buf, cx) {
    cx.spawn(async cx => {
      let text;
      try { text = await readTextFile(buf.path, { on: buf.on }); }
      catch { buf.error = "Too large or unreadable: files up to 1 MiB open here"; buf.loading = false; cx.notify(); return; }
      const draft = this.drafts[buf.path];
      if (text === null && !draft) { buf.error = "This file is no longer available"; buf.loading = false; cx.notify(); return; }
      if (text !== null && text.includes("\0")) { buf.error = "Binary file · no text editing"; buf.loading = false; cx.notify(); return; }
      buf.baseline = draft ? draft.baseline : text;
      buf.missing = buf.baseline === null;
      buf.state = this.editorState(buf, draft ? draft.text : text, buf.readonly);
      buf.state.on("change", (_e, cx) => this.changed(buf, cx));
      buf.dirty = draft ? draft.text !== draft.baseline : false;
      // A restored draft opens where it was left: editing.
      if (buf.dirty && !buf.readonly) buf.mode = "edit";
      this.refreshView(buf);
      // A draft written over a version that has since changed on disk: ask.
      if (draft && draft.baseline !== text) buf.conflict = { disk: text };
      buf.loading = false;
      cx.notify();
    });
  }

  editorState(buf, value, readonly) {
    const t = theme();
    return EditorState.new({
      language: languageOf(buf.path), value, readonly,
      font_family: settings().font_family, font_size: 13,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
  }

  // The read view: rendered Markdown, or a read-only copy of the editor. The
  // editable state stays alive behind it, so undo survives switching modes.
  refreshView(buf) {
    if (!buf.state) return;
    buf.viewText = buf.state.value();
    if (isMarkdown(buf.path)) return;
    if (buf.viewState) buf.viewState.set_value(buf.viewText);
    else buf.viewState = this.editorState(buf, buf.viewText, true);
  }

  setMode(buf, mode, cx) {
    if (!buf?.state || buf.mode === mode || (mode === "edit" && buf.readonly)) return;
    if (mode === "view") this.refreshView(buf);
    buf.mode = mode;
    if (this.view === "diff") { this.view = "editor"; this.diff = null; }
    cx.notify();
  }

  changed(buf, cx) {
    const dirty = buf.missing || buf.state.value() !== buf.baseline;
    this.draftsChanged = true;
    if (dirty !== buf.dirty) { buf.dirty = dirty; cx.notify(); }
  }

  release(buf) {
    buf.state?.release(); buf.viewState?.release();
    buf.state = null; buf.viewState = null;
    if (this.drafts[buf.path]) { delete this.drafts[buf.path]; this.draftsChanged = true; }
  }

  replaceText(buf, text) {
    buf.baseline = text; buf.missing = false; buf.conflict = null; buf.overwrite = false;
    buf.state.set_value(text);
    buf.dirty = false;
    this.refreshView(buf);
    if (this.drafts[buf.path]) { delete this.drafts[buf.path]; this.draftsChanged = true; }
  }

  save(buf, cx) {
    if (!buf?.state || buf.readonly || buf.saving) return;
    if (buf.conflict) { this.notice("Resolve the change on disk before saving", "warning"); cx.notify(); return; }
    if (!buf.dirty) return;
    const text = buf.state.value(), expected = buf.missing ? null : buf.baseline;
    buf.saving = true;
    cx.spawn(async cx => {
      try {
        await writeTextFile(buf.path, text, expected);
        buf.baseline = text; buf.missing = false; buf.overwrite = false;
        buf.dirty = buf.state ? buf.state.value() !== text : false;
        if (!buf.dirty && this.drafts[buf.path]) { delete this.drafts[buf.path]; this.draftsChanged = true; }
        this.notice(`Saved ${buf.name}`, "success");
        if (buf.afterSave) { const next = buf.afterSave; buf.afterSave = null; next(cx); }
      } catch (e) {
        buf.afterSave = null;
        const disk = await readTextFile(buf.path, { on: buf.on }).catch(() => undefined);
        if (disk !== undefined && disk !== expected) buf.conflict = { disk };
        else this.notice(`Cannot save ${buf.name}: ${e}`, "error");
      } finally { buf.saving = false; cx.notify(); }
    });
    cx.notify();
  }

  // Compares an open file with the disk: a clean tab follows the disk, an edited one asks.
  check(buf, cx) {
    if (!buf?.state || buf.saving || buf.checking) return;
    buf.checking = true;
    cx.spawn(async cx => {
      try {
        const disk = await readTextFile(buf.path, { on: buf.on }).catch(() => undefined);
        if (disk === undefined || !buf.state || buf.saving) return;
        if (disk === (buf.missing ? null : buf.baseline)) { if (buf.conflict) { buf.conflict = null; cx.notify(); } return; }
        if (buf.conflict && buf.conflict.disk === disk) return;
        if (!buf.dirty) {
          if (disk === null) { buf.missing = true; buf.dirty = true; this.notice(`${buf.name} was deleted on disk`, "warning"); }
          else { this.replaceText(buf, disk); this.notice(`Reloaded ${buf.name}: changed on disk`, "info"); }
        } else buf.conflict = { disk };
        cx.notify();
      } finally { buf.checking = false; }
    });
  }

  tick(cx) {
    this.ticks++;
    if (this.flash && Date.now() - this.flash.at > 3500) { this.flash = null; cx.notify(); }
    if (!this.ready || this.spaceId === undefined) return;
    // Local files every tick; files on another machine every fourth.
    for (const b of this.session().tabs) if (!b.on || this.ticks % 4 === 0) this.check(b, cx);
    this.collectDrafts();
    if (this.draftsChanged) { this.draftsChanged = false; const copy = { ...this.drafts }; cx.spawn(async () => saveDrafts(copy)); }
  }

  collectDrafts() {
    for (const s of this.sessions.values()) for (const b of s.tabs) {
      if (!b.state || b.readonly) continue;
      if (b.dirty) {
        const text = b.state.value(), baseline = b.missing ? null : b.baseline, d = this.drafts[b.path];
        if (!d || d.text !== text || d.baseline !== baseline) { this.drafts[b.path] = { text, baseline, at: Date.now() }; this.draftsChanged = true; }
      } else if (this.drafts[b.path]) { delete this.drafts[b.path]; this.draftsChanged = true; }
    }
  }

  notice(text, level = "info") { this.flash = { text, level, at: Date.now() }; }

  // ---------- closing and conflicts ----------

  requestClose(buf, cx) {
    if (!buf) return;
    if (buf.dirty && !buf.readonly && buf.state) {
      this.ask({
        title: `Save changes to ${buf.name}?`,
        detail: "Your changes will be lost if you don't save them.",
        actions: [
          { label: "Save", primary: true, run: cx => { buf.afterSave = cx => this.closeTab(buf, cx); this.save(buf, cx); } },
          { label: "Don't save", danger: true, run: cx => this.closeTab(buf, cx) },
          { label: "Cancel" }] }, cx);
    } else this.closeTab(buf, cx);
  }

  closeTab(buf, cx) {
    const s = this.session(), i = s.tabs.indexOf(buf);
    if (i < 0) return;
    this.release(buf);
    s.tabs.splice(i, 1);
    if (s.active === buf.path) s.active = (s.tabs[i] ?? s.tabs[i - 1])?.path ?? null;
    if (this.diff?.path === buf.path) { this.diff = null; this.view = "editor"; }
    this.persist();
    cx.notify();
  }

  reloadFromDisk(buf, cx) {
    const disk = buf.conflict ? buf.conflict.disk : buf.baseline;
    const go = cx => {
      if (disk === null) { this.closeTab(buf, cx); return; }
      this.replaceText(buf, disk); this.view = "editor"; this.diff = null;
      this.notice(`Reloaded ${buf.name} from disk`, "info"); cx.notify();
    };
    if (!buf.dirty) { go(cx); return; }
    this.ask({
      title: `Discard your changes to ${buf.name}?`,
      detail: disk === null ? "The file was deleted on disk. Its tab closes." : "The tab shows the version on disk. Your edits are lost.",
      actions: [{ label: "Discard mine", danger: true, primary: true, run: go }, { label: "Cancel" }] }, cx);
  }

  keepMine(buf, cx) {
    const disk = buf.conflict?.disk ?? null;
    buf.baseline = disk; buf.missing = disk === null; buf.conflict = null; buf.overwrite = true;
    buf.dirty = true; this.draftsChanged = true;
    this.view = "editor"; this.diff = null;
    cx.notify();
  }

  compare(buf, cx) {
    const disk = buf.conflict ? buf.conflict.disk : buf.baseline;
    const rows = lineDiff(disk ?? "", buf.state.value());
    this.diff = { path: buf.path, rows: rows ?? [{ kind: "@", text: "Too many differences to compare here" }] };
    this.diffWidth = Math.max(300, ...this.diff.rows.map(r => (String(r.text ?? "").length + 1) * 7 + 100));
    this.view = "diff";
    cx.notify();
  }

  ask(dialog, cx) {
    this.confirm = dialog;
    this.dialogHandle.focus();
    cx.notify();
  }
  answer(action, cx) {
    this.confirm = null;
    this.handle.focus();
    action?.run?.(cx);
    cx.notify();
  }

  // ---------- tree (from Herdr's Files) ----------

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try {
        while (this.context === context) {
          const changed = await watchFolder(root);
          if (!this.current(context)) continue;
          this.refresh(cx);
          const all = changed.includes(root), set = new Set(changed);
          for (const b of this.session().tabs) if (!b.on && (all || set.has(b.path))) this.check(b, cx);
        }
      } catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) { return this.context === context && locationKey() === context.key; }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = locationKey();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.watched = null; this.error = null; this.limited = false; this.loading = false;
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true; this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) { this.folders.delete(folder); this.entries.delete(folder); }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  // ---------- rendering ----------

  rows(prefix, depth, out, t, active) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, abs = `${this.root}/${path}`, open = this.folders.has(path), mark = this.marks[abs];
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer()
        .when(!entry.dir && abs === active, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
        .on_click((_e, cx) => { if (entry.dir) this.toggle(path, cx); else { this.open(abs, this.on, cx); cx.notify(); } })
        .child(entry.dir ? svg(`mods/code-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/code-files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t, active);
    }
    return out;
  }

  tree(t, active) {
    return v_flex().id("files-tree").size_full().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t, active))
      .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
      .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")));
  }

  tabStrip(t, s) {
    return h_flex().id("cf-tabs").h(34).flex_none().w_full().min_w(0).overflow_x_scrollbar().track_scroll(this.tabScroll).border_b(1).border_color(t.border).bg(t.chrome)
      .children(s.tabs.map(b => {
        const active = b.path === s.active, warn = Boolean(b.conflict) || (b.missing && Boolean(b.state));
        return h_flex().id(`cf-tab-${b.path}`).h_full().flex_none().pl(12).pr(6).gap(6).items_center().cursor_pointer()
          .border_r(1).border_color(t.border).text_size(12)
          .bg(active ? t.background : t.chrome).text_color(active ? t.foreground : t.muted)
          .when(!active, el => el.hover(st => st.bg(t.hover)))
          .tooltip(b.path)
          .on_click((_e, cx) => { this.open(b.path, b.on, cx); cx.notify(); })
          .on_mouse_down("middle", (_e, cx) => { cx.stop_propagation(); this.requestClose(b, cx); })
          .when(warn, el => el.child(div().text_color(t.blocked).font_semibold().child("!")))
          .child(div().max_w(180).truncate().when(active, el => el.font_semibold()).child(b.name))
          .child(div().id(`cf-close-${b.path}`).w(18).h(18).flex_none().flex().items_center().justify_center().rounded(4)
            .text_color(b.dirty ? t.accent : t.dim).hover(st => st.bg(t.raised).text_color(t.foreground))
            .tooltip(b.dirty ? "Unsaved changes · Close" : "Close")
            .on_click((_e, cx) => { cx.stop_propagation(); this.requestClose(b, cx); })
            .child(b.dirty ? "●" : "×"));
      }));
  }

  button(id, label, t, onClick, kind) {
    const bg = kind === "primary" ? t.solid : t.raised, fg = kind === "primary" ? t.solid_foreground : kind === "danger" ? t.ansi1 : t.foreground;
    return div().id(id).h(24).px(10).flex_none().flex().items_center().rounded(6).border_1().border_color(kind === "primary" ? bg : t.input).bg(bg).text_color(fg)
      .text_size(12).cursor_pointer().hover(s => s.opacity(0.88)).on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }).child(label);
  }

  banner(t, buf) {
    if (!buf?.state) return null;
    const bar = (tone, text, actions) => h_flex().flex_none().px(10).py(6).gap(8).items_center().border_b(1).border_color(t.border).bg(t.raised)
      .child(div().w(3).h(18).rounded(2).flex_none().bg(tone))
      .child(div().flex_1().min_w(0).text_size(12).child(text)).children(actions);
    if (buf.conflict) {
      const gone = buf.conflict.disk === null;
      return bar(t.blocked, gone ? "Deleted on disk while you had unsaved changes." : "Changed on disk while you had unsaved changes.", [
        this.button("cf-compare", "Compare", t, cx => this.compare(buf, cx)),
        this.button("cf-reload", gone ? "Close" : "Reload", t, cx => this.reloadFromDisk(buf, cx), "danger"),
        this.button("cf-keep", "Keep mine", t, cx => this.keepMine(buf, cx))]);
    }
    if (buf.overwrite) return bar(t.accent, "Saving replaces the version on disk with yours.", [this.button("cf-save-now", "Save", t, cx => this.save(buf, cx), "primary")]);
    if (buf.missing) return bar(t.blocked, "This file is not on disk. Save to create it again.", [
      this.button("cf-save-missing", "Save", t, cx => this.save(buf, cx), "primary"),
      this.button("cf-close-missing", "Close", t, cx => this.requestClose(buf, cx))]);
    if (buf.readonly) return bar(t.dim, "Read only: files on another machine can't be saved from here.", []);
    return null;
  }

  diffView(t, buf) {
    const rows = this.diff.rows;
    const row = ({ kind, a, b, text }) => kind === "@"
      ? div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text)
      : h_flex().w_full().h(20).flex_none().gap(8).when(kind === "+", e => e.bg(t.ansi2 + "18")).when(kind === "-", e => e.bg(t.ansi1 + "18"))
        .child(div().w(34).flex_none().text_right().text_color(t.dim).child(a === undefined ? "" : String(a)))
        .child(div().w(34).flex_none().text_right().text_color(t.dim).child(b === undefined ? "" : String(b)))
        .child(div().w(10).flex_none().text_color(kind === "+" ? t.ansi2 : kind === "-" ? t.ansi1 : t.dim).child(kind.trim()))
        .child(div().flex_1().min_w(0).whitespace_nowrap().child(text));
    return v_flex().flex_1().min_h(0)
      .child(h_flex().flex_none().px(10).py(6).gap(8).items_center().border_b(1).border_color(t.border).bg(t.raised).text_size(12)
        .child(this.button("cf-diff-back", "← Back", t, cx => { this.view = "editor"; this.diff = null; cx.notify(); }))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(buf?.conflict ? "− on disk   + yours" : "− saved   + yours"))
        .when(Boolean(buf?.conflict), el => el
          .child(this.button("cf-diff-reload", buf.conflict.disk === null ? "Close" : "Reload", t, cx => this.reloadFromDisk(buf, cx), "danger"))
          .child(this.button("cf-diff-keep", "Keep mine", t, cx => this.keepMine(buf, cx)))))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
        .child(div().id("cf-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("cf-diff", rows.length, 20, i => String(i),
            range => rows.slice(range.start, range.end).map(row)).size_full())))
        .child(Scrollbar.vertical("cf-diff").viewport_from_layout().absolute().inset_0()));
  }

  editorArea(t, s, buf) {
    if (!s.tabs.length) return v_flex().flex_1().h_full().min_h(0).items_center().justify_center().gap(4).text_color(t.dim).text_size(12)
      .child(div().child("No open files")).child(div().child("Pick a file in the tree to edit it"));
    return v_flex().flex_1().h_full().min_w(0).min_h(0)
      .child(this.tabStrip(t, s))
      .child((this.view === "diff" ? null : this.banner(t, buf)) ?? div())
      .child(this.view === "diff" && this.diff && buf?.path === this.diff.path ? this.diffView(t, buf)
        : buf?.state ? this.content(t, buf)
        : div().flex_1().p(12).text_color(t.dim).child(buf?.error || (buf ? "Loading file…" : "")));
  }

  content(t, buf) {
    if (buf.mode === "edit") return Editor.new(buf.state).flex_1().min_h(0);
    if (isMarkdown(buf.path)) return div().flex_1().min_h(0).min_w(0).px(18).py(14).text_size(13).text_color(t.foreground)
      .child(TextView.markdown(`cf-md-${buf.path}`, buf.viewText).scrollable(true).selectable(true).size_full());
    return Editor.new(buf.viewState).flex_1().min_h(0);
  }

  modeSwitch(t, buf) {
    const seg = (mode, label, hint) => {
      const on = buf.mode === mode, disabled = mode === "edit" && buf.readonly;
      return div().id(`cf-mode-${mode}`).h(20).px(9).flex().items_center().rounded(5).text_size(12)
        .bg(on ? t.background : t.raised).text_color(disabled ? t.dim : on ? t.foreground : t.muted)
        .when(on, el => el.border_1().border_color(t.border).font_semibold())
        .when(!on && !disabled, el => el.cursor_pointer().hover(s => s.text_color(t.foreground)))
        .tooltip(disabled ? "Files on another machine are read only" : hint)
        .on_click((_e, cx) => { cx.stop_propagation(); this.setMode(buf, mode, cx); })
        .child(label);
    };
    return h_flex().flex_none().h(26).p(2).gap(2).rounded(7).bg(t.raised).border_1().border_color(t.border)
      .child(seg("view", "View", "Read without changing it (Cmd+E)"))
      .child(seg("edit", "Edit", "Edit this file (Cmd+E)"));
  }

  status(t, buf) {
    if (!buf) return null;
    const h = home(), rel = this.root && buf.path.startsWith(this.root + "/") ? buf.path.slice(this.root.length + 1) : h && buf.path.startsWith(h) ? "~" + buf.path.slice(h.length) : buf.path;
    const state = buf.saving ? "Saving…" : buf.conflict ? "Changed on disk" : buf.dirty ? "Unsaved" : buf.state ? "Saved" : "";
    const flash = this.flash, tone = flash?.level === "error" ? t.ansi1 : flash?.level === "warning" ? t.blocked : flash?.level === "success" ? t.ansi2 : t.muted;
    return h_flex().h(24).flex_none().px(10).gap(10).items_center().border_t(1).border_color(t.border).bg(t.chrome).text_size(11).text_color(t.dim)
      .child(div().flex_1().min_w(0).truncate().when(Boolean(flash), el => el.text_color(tone)).child(flash ? flash.text : rel))
      .child(div().flex_none().child(languageOf(buf.path)))
      .child(div().flex_none().text_color(buf.conflict ? t.blocked : buf.dirty ? t.accent : t.dim).child(state));
  }

  dialog(t) {
    const d = this.confirm;
    if (!d) return null;
    const primary = d.actions.find(a => a.primary), cancel = d.actions.find(a => !a.run);
    return div().absolute().inset_0().flex().items_center().justify_center().p(16)
      .child(div().absolute().inset_0().bg(t.canvas).opacity(0.7))
      .child(v_flex().id("cf-dialog").track_focus(this.dialogHandle).max_w(380).w_full().p(16).gap(10).rounded(10).border_1().border_color(t.border).bg(t.popover).shadow_lg()
        .on_key_down((e, cx) => {
          if (e.key === "enter") this.answer(primary, cx);
          else if (e.key === "escape") this.answer(cancel, cx);
          else return;
          cx.stop_propagation();
        })
        .child(div().font_semibold().text_size(13).child(d.title))
        .child(div().text_size(12).text_color(t.muted).child(d.detail))
        .child(h_flex().pt(4).gap(8).justify_end().children(d.actions.map((a, i) =>
          this.button(`cf-dialog-${i}`, a.label, t, cx => this.answer(a, cx), a.primary && !a.danger ? "primary" : a.danger ? "danger" : undefined)))));
  }

  render(cx) {
    if (locationKey() !== this.context?.key) this.refresh(cx);
    const space = location().space;
    if (this.ready && space !== this.spaceId) this.switchSpace(space, cx);
    // git-panel integration (added 2026-11-12; backup in ~/herdr-git-panel-dev/backups):
    // the Git panel asks to open a file with shared "code-files.open" = {path, on, nonce, at}.
    const ask = shared("code-files.open");
    if (this.ready && ask?.path && ask.nonce !== this.openNonce && Date.now() - (ask.at ?? 0) < 15000) {
      this.openNonce = ask.nonce;
      cx.spawn(async (cx) => { setShared("code-files.open", null); this.open(ask.path, ask.on ?? null, cx); this.handle.focus(); cx.notify(); });
    }
    const t = theme(), s = this.session(), buf = this.activeBuffer();
    const wide = this.width >= WIDE, noTabs = !s.tabs.length;
    const showTree = wide ? this.treeWide || noTabs : (this.treeNarrow || noTabs);
    const treeOnly = showTree && (!wide || noTabs);
    const dirty = s.tabs.filter(b => b.dirty).length;
    return v_flex().id("code-files").relative().size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .track_focus(this.handle)
      .key_context("CodeFiles")
      .on_action("code_files_close_tab", (_e, cx) => { if (!this.confirm) this.requestClose(this.activeBuffer(), cx); cx.stop_propagation(); })
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) > 1) { this.width = size.width; cx.notify(); } })
      .on_key_down((e, cx) => {
        if (this.confirm) return;
        if (e.keystroke === "cmd-w") { this.requestClose(this.activeBuffer(), cx); cx.stop_propagation(); return; }
        if (e.keystroke === "cmd-s" || e.keystroke === "ctrl-s") { this.save(this.activeBuffer(), cx); cx.stop_propagation(); }
        // Ctrl+E is end-of-line on macOS: there only Cmd+E switches.
        else if (e.keystroke === "cmd-e" || (e.keystroke === "ctrl-e" && window()?.platform !== "macos")) {
          const b = this.activeBuffer();
          if (b?.state) { this.setMode(b, b.mode === "edit" ? "view" : "edit", cx); cx.stop_propagation(); }
        }
      })
      .child(h_flex().h(42).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().id("cf-tree-toggle").w(26).h(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
          .when(showTree && !noTabs, el => el.bg(t.selected)).hover(st => st.bg(t.hover)).tooltip(showTree ? "Hide files" : "Show files")
          .on_click((_e, cx) => { if (wide) this.treeWide = !this.treeWide; else this.treeNarrow = !this.treeNarrow; cx.notify(); })
          .child(svg("mods/code-files/folder.svg").size(14).text_color(t.muted)))
        .child(div().font_semibold().child("Files"))
        .when(dirty > 0, el => el.child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.accent).child(`${dirty} unsaved`)))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.root?.split(/[\\/]/).pop() ?? ""))
        .when(Boolean(buf?.state), el => el.child(this.modeSwitch(t, buf)))
        .when(Boolean(buf?.state) && !buf?.readonly && (buf?.mode === "edit" || buf?.dirty), el => el.child(this.button("cf-save", buf?.saving ? "Saving…" : "Save", t, cx => this.save(buf, cx), buf?.dirty && !buf?.conflict ? "primary" : undefined))))
      .child(h_flex().flex_1().items_start().min_h(0).min_w(0)
        .when(showTree, el => el.child(div().h_full().min_h(0).when(treeOnly, d => d.flex_1()).when(!treeOnly, d => d.w(TREE_WIDTH).flex_none().border_r(1).border_color(t.border)).child(this.tree(t, buf?.path))))
        .when(!treeOnly, el => el.child(this.editorArea(t, s, buf))))
      .child(this.status(t, buf) ?? div())
      .child(this.dialog(t) ?? div());
  }
}
