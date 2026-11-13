// The panel: header (repo, HEAD, upstream, state, Fetch/Compare/Merge), tabs
// (Changes, Branches, History), and a sheet that replaces the body for
// confirmations, the merge preview, pickers and the operations log.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { theme, settings, home } from "herdr";
import { button, pill, notice, spinner, relTime, basename, emptyState, sectionTitle, ICON, stop } from "./kit.js";
import { renderSheet } from "./sheets.js";
import { diffView } from "./diffview.js";
import { ffMarkText } from "../git/queries.js";
import { autoFetchLine } from "../git/merge-flow.js";

const mono = () => settings().font_family ?? "JetBrains Mono";
const tilde = (p) => { const h = home(); return p && h && p.startsWith(h + "/") ? "~" + p.slice(h.length) : p; };

export function renderPanel(v, cx) {
  const t = theme();
  return v_flex().id("git-panel").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
    .text_color(t.foreground).text_size(12.5).track_focus(v.handle)
    .on_size_change((size, cx) => { if (Math.abs(size.width - v.width) > 4 || Math.abs(size.height - (v.height ?? 0)) > 4) { v.width = size.width; v.height = size.height; cx.notify(); } })
    .on_key_down((e, cx) => { if (v.key(e, cx)) cx.stop_propagation(); })
    .on_mouse_down("left", (_e, _cx) => { if (!v.typing.size) v.handle.focus(); })
    .child(header(v, t))
    .child(tabBar(v, t))
    .child(div().flex_1().min_h(0).relative().child(v.sheet ? renderSheet(v, t, cx) : body(v, t)))
    .when(Boolean(v.banner), (e) => e.child(banner(v, t)));
}

// ---------- header ----------
function header(v, t) {
  const d = v.data, narrow = v.width < 460;
  const busy = Boolean(v.op), noRepo = !d;
  // Toolbar like Fork's: Fetch, Pull, Push act on the current branch; counts only when there is something to move.
  const head = d?.refs.find((r) => r.type === "local" && r.current);
  const up = head?.upstream && !head.gone ? head.upstream : null;
  const behind = up ? head.behind : 0, ahead = up ? head.ahead : 0;
  const actions = h_flex().gap(4).flex_none()
    .child(button(t, "h-fetch", narrow ? (v.autoFetchMin ? `↻·${v.autoFetchMin}` : "↻") : v.autoFetchMin ? `Fetch · ${v.autoFetchMin}m` : "Fetch", (_e, cx) => v.fetch(cx), { disabled: noRepo || busy, small: true,
      tooltip: `Fetch: trae lo nuevo del remoto sin tocar tus ramas ni archivos (tecla f)\n${autoFetchLine(v.autoFetchMin, d && v.autoFetchState[v.fetchKey(d)], Date.now())}` })
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); if (!noRepo) v.autoFetchMenu(cx); }))
    .child(button(t, "h-pull", behind ? (narrow ? `↓${behind}` : `Pull ↓${behind}`) : (narrow ? "↓" : "Pull"), (_e, cx) => v.startPull(cx), { kind: behind ? "primary" : undefined, disabled: noRepo || busy || !up, tooltip: up ? `Pull: fetch e integrar ${up} en ${head.name} (con vista previa)` : "La rama actual no sigue a ninguna remota", small: true }))
    .child(button(t, "h-push", ahead ? (narrow ? `↑${ahead}` : `Push ↑${ahead}`) : up ? (narrow ? "↑" : "Push") : (narrow ? "↑" : "Publicar"), (_e, cx) => v.startPush(cx), { kind: ahead && !behind ? "primary" : undefined, disabled: noRepo || busy || !head, tooltip: up ? `Push: publicar ${head.name} en ${up}` : head ? `Publicar ${head.name} en el remoto` : "HEAD desacoplado", small: true }))
    .child(button(t, "h-merge", "Merge…", (_e, cx) => v.startMerge(cx), { disabled: noRepo || busy || d?.status.detached, tooltip: d?.status.head ? `Fusionar otra rama en ${d.status.head} (tecla m)` : "Cambia a una rama para fusionar", small: true }))
    .child(button(t, "h-compare", "⇄", (_e, cx) => v.startCompare(cx), { disabled: noRepo, tooltip: "Comparar la rama actual con otra", small: true }));
  const top = h_flex().h(40).px(12).gap(8).items_center()
    .child(svg(ICON("git-branch")).size(15).flex_none().text_color(t.muted))
    .child(div().min_w(0).truncate().font_semibold().child(d ? basename(d.repo.root) : "Git"))
    .when(Boolean(d?.repo.linked), (e) => e.child(pill(t, "worktree", t.ansi5, { title: d.repo.root })))
    .when(Boolean(v.pinned), (e) => e.child(h_flex().id("unpin").gap(3).items_center().cursor_pointer().on_click((_e, cx) => v.unpin(cx)).tooltip("El panel muestra este worktree fijado. Clic para volver a seguir el pane enfocado.").child(pill(t, "fijado ×", t.accent))))
    .child(div().flex_1())
    .when(v.loading || busy, (e) => e.child(spinner(t)))
    .child(actions);
  if (!d) return v_flex().flex_none().border_b(1).border_color(t.border).child(top);
  const st = d.status, s = st.summary;
  const line = h_flex().h(26).px(12).pb(4).gap(7).items_center().text_size(11.5).text_color(t.muted)
    .child(st.detached ? pill(t, `HEAD desacoplado · ${st.oid?.slice(0, 7) ?? ""}`, t.blocked) : pill(t, st.head ?? "sin rama", t.accent))
    .child(st.upstream
      ? h_flex().gap(4).min_w(0).child(div().text_color(t.dim).child("→")).child(div().truncate().child(st.upstream))
        .when(st.ahead !== null, (e) => e.child(div().text_color(st.ahead ? t.ansi2 : t.dim).child(`↑${st.ahead}`)).child(div().text_color(st.behind ? t.ansi3 : t.dim).child(`↓${st.behind}`)))
      : div().text_color(t.dim).child(st.detached ? "" : "sin upstream"))
    .child(div().flex_1())
    .when(Boolean(d.account), (e) => e.child(accountPill(v, t, d.account, narrow)))
    .child(s.total === 0 ? div().text_color(t.ansi2).child("✓ limpio")
      : h_flex().gap(6).when(s.conflicts > 0, (e) => e.child(div().text_color(t.blocked).child(`${s.conflicts} conflicto${s.conflicts > 1 ? "s" : ""}`)))
        .when(s.staged > 0, (e) => e.child(div().text_color(t.ansi2).child(`${s.staged} en stage`)))
        .when(s.unstaged > 0, (e) => e.child(div().text_color(t.ansi3).child(`${s.unstaged} modif.`)))
        .when(s.untracked > 0, (e) => e.child(div().text_color(t.dim).child(`${s.untracked} nuevos`))));
  const col = v_flex().flex_none().border_b(1).border_color(t.border).child(top).child(line);
  if (d.ops.length) col.child(h_flex().mx(10).mb(8).px(10).py(6).gap(8).items_center().rounded(7).bg(t.blocked + "18").border_1().border_color(t.blocked + "55")
    .child(div().text_color(t.blocked).child("⚠")).child(div().flex_1().min_w(0).child(`${opText(d)}${s.conflicts ? ` · ${s.conflicts} archivo(s) en conflicto` : ""}`))
    .when(["merge", "cherry-pick", "revert", "rebase"].includes(d.ops[0]), (e) => e.child(button(t, "h-conflicts", "Ver", (_e, cx) => { v.setTab("changes"); v.sheet = null; cx.notify(); }, { small: true }))
      .when(d.ops[0] !== "merge", (e) => e.child(button(t, "h-continue", "Continuar", (_e, cx) => v.continueOp(cx), { kind: "primary", small: true, disabled: busy || s.conflicts > 0, tooltip: s.conflicts ? "Quedan conflictos" : `git ${d.ops[0]} --continue` })))
      .child(button(t, "h-abort", `Abortar ${d.ops[0]}`, (_e, cx) => v.askAbort(cx), { kind: "danger", small: true, disabled: busy })))
    .when(d.ops[0] === "bisect", (e) => e.child(button(t, "h-bisect", "Terminar bisect", (_e, cx) => v.askAbort(cx), { small: true, disabled: busy, tooltip: "git bisect reset" }))));
  if (v.op) col.child(h_flex().px(12).pb(6).gap(6).items_center().text_size(11.5).text_color(t.working).child(spinner(t, 11)).child(`${v.op}…`));
  return col;
}

// Above a work-tree or staged diff: which hunk, ‹ ›, and stage/unstage just that one.
function hunkBar(v, t) {
  const dd = v.diff, n = dd.hunks.length, i = v.hunkSel, staged = dd.which === "staged";
  return h_flex().flex_none().h(30).px(10).gap(6).items_center().border_b(1).border_color(t.border).text_size(11.5)
    .child(button(t, "hunk-prev", "‹", (_e, cx) => v.pickHunk(i - 1, cx), { small: true, kind: "ghost", disabled: i <= 0, tooltip: "Fragmento anterior" }))
    .child(div().text_color(t.muted).child(`Fragmento ${i + 1} de ${n}`))
    .child(button(t, "hunk-next", "›", (_e, cx) => v.pickHunk(i + 1, cx), { small: true, kind: "ghost", disabled: i >= n - 1, tooltip: "Fragmento siguiente" }))
    .child(div().flex_1())
    .child(button(t, "hunk-apply", staged ? "Unstage fragmento" : "Stage fragmento", (_e, cx) => v.applySelectedHunk(cx), {
      small: true, kind: staged ? undefined : "primary", disabled: Boolean(v.op),
      tooltip: staged ? "Quita solo este fragmento del stage (git apply --cached --reverse). El archivo no cambia." : "Añade solo este fragmento al stage (git apply --cached). El archivo no cambia." }));
}

// "Rebase de feature sobre main · 2/5", or the plain name of what's in progress.
function opText(d) {
  const op = d.ops[0], r = d.rebase;
  const names = { merge: "Merge en curso", rebase: "Rebase en curso", "cherry-pick": "Cherry-pick en curso", revert: "Revert en curso", bisect: "Bisect en curso" };
  if (op === "rebase" && r) return `Rebase de ${r.branch}${r.ontoName || r.onto ? ` sobre ${r.ontoName ?? r.onto.slice(0, 7)}` : ""}${r.total ? ` · ${r.step}/${r.total}` : ""}`;
  return names[op] ?? op;
}

// Who this project commits and pushes as. Click: pin an account to this project.
function accountPill(v, t, a, narrow) {
  const who = a.pushLogin ?? a.pin?.login ?? (a.email ? a.email.split("@")[0] : "sin autor");
  const warn = (a.warnings ?? []).length > 0;
  const pinned = Boolean(a.pin || a.manualPin);
  const color = warn ? t.ansi3 : pinned ? t.ansi2 : t.muted;
  const src = a.pin ? "fijada a este proyecto" : a.manualPin ? "fijada a este proyecto (a mano)" : a.pushSource === "global" ? "cuenta global de gh (no fijada)" : a.pushSource === "ssh" ? "push por SSH" : a.pushSource === "own-helper" ? "helper propio del repo" : "sin cuenta de push";
  const tip = [`Push: ${a.pushLogin ?? "—"} · ${src}`, `Autor: ${a.name ?? "?"} <${a.email ?? "sin correo"}>`, ...(a.warnings ?? []).map((w) => `⚠ ${w}`), "Clic: fijar una cuenta a este proyecto"].join("\n");
  return h_flex().id("acct").flex_none().gap(4).px(6).h(18).items_center().rounded(5).cursor_pointer()
    .border_1().border_color(color + (pinned || warn ? "88" : "44")).bg(pinned || warn ? color + "1a" : t.background)
    .hover((s) => s.bg(t.hover)).tooltip(tip).on_click((_e, cx) => v.accountMenu(cx))
    .child(div().text_size(10.5).text_color(color).child(warn ? "⚠" : pinned ? "◉" : "○"))
    .child(div().text_size(11).text_color(warn ? t.ansi3 : t.foreground).max_w(narrow ? 90 : 150).truncate().child(who));
}

// ---------- tabs ----------
function tabBar(v, t) {
  const n = v.data?.status.summary.total ?? 0;
  const tab = (id, label) => h_flex().id(`tab-${id}`).h(30).px(10).items_center().text_size(12).cursor_pointer()
    .text_color(v.tab === id && !v.sheet ? t.foreground : t.muted).border_b(2).border_color(v.tab === id && !v.sheet ? t.accent : t.background)
    .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { v.setTab(id); v.sheet = v.sheet?.running ? v.sheet : null; cx.notify(); }).child(label);
  return h_flex().h(31).flex_none().px(6).items_end().border_b(1).border_color(t.border)
    .child(tab("changes", n ? `Changes (${n})` : "Changes")).child(tab("branches", "Branches")).child(tab("history", "History"))
    .child(div().flex_1())
    .child(h_flex().id("tab-log").h(30).px(8).items_center().gap(4).text_size(11.5).cursor_pointer().text_color(v.sheet?.kind === "log" ? t.foreground : t.dim)
      .hover((s) => s.text_color(t.foreground)).tooltip("Registro de comandos ejecutados")
      .on_click((_e, cx) => { v.sheet = v.sheet?.kind === "log" ? null : { kind: "log" }; cx.notify(); }).child("Log").child(div().text_color(t.dim).child(String(v.oplog.length))));
}

// ---------- body ----------
function body(v, t) {
  if (v.error === "notrepo") return emptyState(t, "Esta carpeta no es un repositorio Git", `${v.context().cwd ?? ""}`, null);
  if (v.error && !v.data) return emptyState(t, "No se pudo leer el repositorio", v.error, button(t, "retry", "Reintentar", (_e, cx) => v.refresh(cx)));
  if (!v.data) return emptyState(t, v.loading ? "Leyendo el repositorio…" : "Sin repositorio", v.loading ? null : "Enfoca un pane cuya carpeta esté dentro de un repositorio.");
  if (v.tab === "branches") return branches(v, t);
  if (v.tab === "history") return history(v, t);
  return changes(v, t);
}

function banner(v, t) {
  const b = v.banner;
  return h_flex().flex_none().p(8).gap(6).border_t(1).border_color(t.border)
    .child(div().flex_1().min_w(0).child(notice(t, b.level, b.text, "banner")))
    .child(div().id("banner-x").px(6).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { v.banner = null; cx.notify(); }).child("×"));
}

// ---------- Branches ----------
function branchRows(v) {
  const d = v.data, q = v.filterText.trim().toLowerCase(), rows = [];
  const match = (r) => !q || r.name.toLowerCase().includes(q) || r.subject.toLowerCase().includes(q);
  const group = (id, label, list, always) => {
    const shown = list.filter(match);
    if (!shown.length && !always) return;
    const open = q ? true : !v.collapsed.has(id);
    rows.push({ kind: "group", id, label, count: shown.length, open });
    if (open) for (const r of shown) rows.push({ kind: "ref", ref: r });
  };
  const byName = (a, b) => a.name.localeCompare(b.name);
  // Worktrees first when there's more than the main one: where agents usually work.
  const wts = (d.worktrees ?? []).filter((w) => !q || `${w.branch ?? ""} ${w.path}`.toLowerCase().includes(q));
  if ((d.worktrees ?? []).length > 1 && wts.length) {
    const open = q ? true : !v.collapsed.has("worktrees");
    rows.push({ kind: "group", id: "worktrees", label: "Worktrees", count: wts.length, open });
    if (open) for (const w of wts) rows.push({ kind: "wt", wt: w });
  }
  group("local", "Locales", d.refs.filter((r) => r.type === "local").sort(byName), true);
  const remotes = [...new Set(d.refs.filter((r) => r.type === "remote").map((r) => r.remote))].sort();
  for (const name of remotes) group(`remote:${name}`, name, d.refs.filter((r) => r.type === "remote" && r.remote === name).sort(byName));
  group("tags", "Tags", d.refs.filter((r) => r.type === "tag").sort((a, b) => b.date - a.date));
  return rows;
}

function branches(v, t) {
  const rows = branchRows(v), d = v.data, wide = v.width >= 470;
  const keyOf = (r) => r.kind === "group" ? `g:${r.id}` : r.kind === "wt" ? `wt:${r.wt.path}` : r.ref.ref;
  const byKey = new Map(rows.map((r) => [keyOf(r), r]));
  v.branchKeys = rows.map(keyOf);
  const filter = h_flex().flex_none().p(8).gap(6).items_center()
    .child(h_flex().id("br-filter").flex_1().h(28).px(8).gap(6).items_center().rounded(7).border_1().border_color(t.input).bg(t.background).on_mouse_down("left", stop)
      .child(svg(ICON("search")).size(12).text_color(t.dim)).child(Input.new(v.filter).h_full().text_size(12).text_color(t.foreground)))
    .child(button(t, "br-new", "Nueva", (_e, cx) => v.askCreate(d.status.head ?? "HEAD", cx), { icon: "plus", small: true, disabled: Boolean(v.op), tooltip: "Nueva rama desde HEAD" }));
  // Rows carry no handlers: a virtual list's renderer may not register any.
  // Clicks come through on_item_click / on_item_secondary_click by key.
  const row = (r) => {
    if (r.kind === "group") return h_flex().h(28).px(10).gap(5).items_center().text_size(11).font_semibold().text_color(t.dim)
      .child(svg(ICON(r.open ? "chevron-down" : "chevron-right")).size(11)).child(r.label.toUpperCase()).child(div().font_normal().child(`${r.count}`));
    if (r.kind === "wt") {
      const w = r.wt, sel = v.selectedRef === `wt:${w.path}`, here = w.path === d.repo.root;
      return h_flex().h(28).mx(4).px(8).gap(7).items_center().rounded(6).when(sel, (e) => e.bg(t.selected))
        .child(div().w(10).flex_none().text_color(here ? t.accent : t.ansi5).child(here ? "●" : "◆"))
        .child(div().flex_none().max_w(170).truncate().when(here, (e) => e.font_semibold().text_color(t.accent)).child(w.branch ?? (w.detached ? `HEAD ${w.head?.slice(0, 7)}` : "—")))
        .child(div().flex_1().min_w(0).truncate().text_ellipsis_start().text_size(11).text_color(t.dim).child(tilde(w.path)))
        .when(w === d.worktrees[0], (e) => e.child(pill(t, "principal", t.muted)))
        .when(Boolean(w.locked), (e) => e.child(pill(t, "bloqueado", t.ansi3)))
        .when(Boolean(w.prunable), (e) => e.child(pill(t, "carpeta borrada", t.blocked)));
    }
    const ref = r.ref, sel = v.selectedRef === ref.ref;
    const elsewhere = ref.type === "local" && ref.worktree && ref.worktree !== d.repo.root;
    return h_flex().h(28).mx(4).px(8).gap(7).items_center().rounded(6).when(sel, (e) => e.bg(t.selected))
      .child(div().w(10).flex_none().text_color(ref.current ? t.accent : t.ansi5).child(ref.current ? "●" : elsewhere ? "◆" : ""))
      .child(div().min_w(0).flex_shrink(1).truncate().when(ref.current, (e) => e.font_semibold().text_color(t.accent)).child(ref.name))
      .when(elsewhere, (e) => e.child(pill(t, "worktree", t.ansi5)))
      .when(ref.gone, (e) => e.child(pill(t, "upstream borrado", t.ansi3)))
      .child(div().flex_1())
      .when(ref.ahead > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`↑${ref.ahead}`)))
      .when(ref.behind > 0, (e) => e.child(div().text_size(11).text_color(t.ansi3).child(`↓${ref.behind}`)))
      .when(wide, (e) => e.child(div().max_w(180).min_w(0).truncate().text_size(11).text_color(t.dim).child(ref.subject)))
      .child(div().flex_none().font_family(mono()).text_size(10.5).text_color(t.dim).child(ref.short ?? ref.oid.slice(0, 7)));
  };
  const selected = d.refs.find((r) => r.ref === v.selectedRef);
  const selWt = v.selectedRef?.startsWith("wt:") ? (d.worktrees ?? []).find((w) => `wt:${w.path}` === v.selectedRef) : null;
  const selElsewhere = selected?.type === "local" && selected.worktree && selected.worktree !== d.repo.root;
  const bar = selWt
    ? h_flex().flex_none().h(38).px(10).gap(6).items_center().border_t(1).border_color(t.border).bg(t.chrome)
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(selWt.path))
      .when(selWt.path !== d.repo.root && !selWt.prunable, (e) => e.child(button(t, "sb-wt-view", "Ver", (_e, cx) => v.pinWorktree(selWt.path, cx), { small: true })))
      .child(button(t, "sb-wt-more", "Acciones ⋯", (_e, cx) => v.worktreeMenu(selWt, cx), { small: true }))
    : selected
    ? h_flex().flex_none().h(38).px(10).gap(6).items_center().border_t(1).border_color(t.border).bg(t.chrome)
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(selElsewhere ? `${selected.name} · en ${selected.worktree}` : selected.name))
      .when(selected.type === "local" && !selected.current && !selElsewhere, (e) => e.child(button(t, "sb-co", "Cambiar", (_e, cx) => v.askCheckout(selected.name, null, cx), { small: true, disabled: Boolean(v.op) })))
      .child(button(t, "sb-more", "Acciones ⋯", (_e, cx) => v.branchMenu(selected, cx), { small: true }))
    : h_flex().flex_none().px(12).h(26).items_center().text_size(10.5).text_color(t.dim).border_t(1).border_color(t.border)
      .child("Clic: seleccionar · doble clic: cambiar · clic derecho o Enter: acciones · ↑↓ · /");
  return v_flex().size_full().min_h(0).child(filter)
    .child(div().flex_1().min_h(0).relative()
      .child(v_virtual_list("branches", rows.length, 28, (i) => keyOf(rows[i]),
        (range) => rows.slice(range.start, range.end).map(row)).track_scroll(v.branchScroll).size_full()
        .on_item_click((key, cx) => {
          const r = byKey.get(key);
          if (!r) return;
          if (r.kind === "group") { v.toggleGroup(r.id, cx); return; }
          const now = Date.now(), again = v.lastClick?.key === key && now - v.lastClick.at < 450;
          v.lastClick = { key, at: now };
          v.selectedRef = key;
          v.handle.focus();
          if (r.kind === "wt") { if (again && r.wt.path !== d.repo.root && !r.wt.prunable) v.pinWorktree(r.wt.path, cx); cx.notify(); return; }
          const ref = r.ref, elsewhere = ref.type === "local" && ref.worktree && ref.worktree !== d.repo.root;
          if (again && ref.type === "local" && !ref.current && !elsewhere && !v.op) v.askCheckout(ref.name, null, cx);
          cx.notify();
        })
        .on_item_secondary_click((key, _e, cx) => {
          const r = byKey.get(key);
          if (r?.kind === "wt") { v.selectedRef = key; v.worktreeMenu(r.wt, cx); return; }
          if (r?.kind !== "ref") return;
          v.selectedRef = key; v.branchMenu(r.ref, cx);
        }))
      .child(Scrollbar.vertical("branches").viewport_from_layout().absolute().inset_0()))
    .child(bar);
}

// ---------- History ----------
function history(v, t) {
  const h = v.history, d = v.data, list = h.commits;
  const graphFits = v.width >= 380;
  const refKind = (r) => r.kind === "head" ? "head" : r.kind === "tag" ? "tag" : d.refs.some((x) => x.type === "local" && x.name === r.name) ? "local" : "remote";
  const colors = { head: t.accent, local: t.ansi4, remote: t.ansi5, tag: t.ansi3, detached: t.blocked };
  const top = h_flex().flex_none().h(34).px(10).gap(6).items_center().border_b(1).border_color(t.border).text_size(11.5)
    .child(div().text_color(t.dim).child(h.all ? "Todas las ramas" : `Desde ${d.status.head ?? "HEAD"}`))
    .child(div().flex_1())
    .when(graphFits, (e) => e.child(button(t, "h-graph", v.graphOn ? "Ocultar grafo" : "Grafo", (_e, cx) => { v.graphOn = !v.graphOn; v.store("graph", v.graphOn ? "1" : "0"); cx.notify(); }, { small: true, kind: "ghost", tooltip: "Tecla g" })))
    .child(button(t, "h-scope", h.all ? "Solo HEAD" : "Todas las ramas", (_e, cx) => v.setHistoryAll(!h.all, cx), { small: true }));
  const LW = 11, MAXL = 6, laneColors = [t.accent, t.ansi5, t.ansi2, t.ansi3, t.ansi6, t.ansi1];
  const graphOn = v.graphOn && graphFits && (h.graph?.length === list.length);
  const graphW = graphOn ? Math.min(MAXL, Math.max(1, ...h.graph.map((g) => g.lanes))) * LW + 8 : 0;
  // The graph: right-angled lanes drawn with divs (top half, bottom half, a joint at the middle).
  const graphCell = (i) => {
    const g = h.graph[i], c = list[i];
    const x = (l) => 4 + Math.min(l, MAXL - 1) * LW + LW / 2 - 1;
    const color = (l) => l >= MAXL ? t.dim : laneColors[l % laneColors.length];
    const parts = [];
    for (const l of g.top) parts.push(div().absolute().left(x(l)).top(0).w(2).h(22).bg(color(l)));
    for (const l of g.bottom) parts.push(div().absolute().left(x(l)).top(22).w(2).h(22).bg(color(l)));
    for (const l of g.links) { const a = Math.min(x(l), x(g.col)), b = Math.max(x(l), x(g.col)); parts.push(div().absolute().left(a).top(21).w(b - a + 2).h(2).bg(color(Math.max(l, g.col)))); }
    const merge = c.parents.length > 1;
    parts.push(div().absolute().left(x(g.col) - 3).top(18).size(8).rounded(4).border_2().border_color(color(g.col)).bg(merge ? t.background : color(g.col)));
    return div().relative().flex_none().w(graphW).h(44).children(parts);
  };
  const row = (c, i) => {
    const sel = h.selected === c.hash, cur = h.cursor === c.hash;
    const labels = c.refs.slice(0, 4).map((r) => { const k = r.kind === "detached" ? "detached" : refKind(r); return pill(t, r.kind === "tag" ? `🏷 ${r.name}` : r.name, colors[k]); });
    return h_flex().h(44).mx(4).pr(8).pl(graphOn ? 0 : 8).rounded(6).when(sel, (e) => e.bg(t.selected)).when(cur && !sel, (e) => e.bg(t.hover))
      .when(graphOn, (e) => e.child(graphCell(i)))
      .child(v_flex().flex_1().min_w(0).py(4).gap(2).justify_center()
      .child(h_flex().gap(5).min_w(0).items_center().children(labels).when(c.refs.length > 4, (e) => e.child(div().text_size(10).text_color(t.dim).child(`+${c.refs.length - 4}`)))
        .children((h.ffAt?.[c.hash] ?? []).slice(0, 2).map((m) => pill(t, `← ${m.branch} antes del ff`, t.ansi6)))
        .when(c.parents.length > 1, (e) => e.child(div().text_size(10.5).text_color(t.ansi5).child("⑂")))
        .child(div().min_w(0).truncate().child(c.subject)))
      .child(h_flex().gap(8).text_size(10.5).text_color(t.dim)
        .child(div().font_family(mono()).child(c.short)).child(div().min_w(0).truncate().child(c.author)).child(div().flex_none().child(relTime(c.at)))));
  };
  const more = () => h_flex().h(44).px(14).gap(6).items_center().text_size(11.5).text_color(t.dim).child(spinner(t, 11)).child("Cargando más…");
  const listEl = list.length === 0
    ? emptyState(t, h.loading ? "Cargando historial…" : "Sin commits todavía", null)
    : div().flex_1().min_h(0).relative()
      // Near the end: the tick (or a scroll) loads the next page; the renderer only records.
      .on_scroll_wheel((_e, cx) => { if (v.historyEnd >= list.length - 20) v.moreHistory(cx); })
      .child(v_virtual_list("history", list.length + (h.done ? 0 : 1), 44, (i) => list[i]?.hash ?? "more",
        (range) => {
          v.historyEnd = range.end;
          return Array.from({ length: range.end - range.start }, (_, k) => { const c = list[range.start + k]; return c ? row(c, range.start + k) : more(); });
        }).track_scroll(v.historyScroll).size_full()
        .on_item_click((key, cx) => { v.handle.focus(); if (key !== "more") { h.cursor = key; v.selectCommit(key, cx); } else v.moreHistory(cx); })
        .on_item_secondary_click((key, _e, cx) => { const c = list.find((x) => x.hash === key); if (c) { h.cursor = key; v.commitMenu(c, cx); } }))
      .child(Scrollbar.vertical("history").viewport_from_layout().absolute().inset_0());
  return v_flex().size_full().min_h(0).child(top).child(listEl).when(Boolean(h.selected), (e) => e.child(commitDetail(v, t)));
}

function commitDetail(v, t) {
  const h = v.history, c = h.commits.find((x) => x.hash === h.selected), det = h.detail ?? {};
  if (!c) return div();
  const color = { A: t.ansi2, D: t.ansi1, M: t.ansi3, R: t.ansi5, C: t.ansi5, T: t.ansi3 };
  return v_flex().id("commit-detail").flex_none().max_h(260).border_t(1).border_color(t.border).bg(t.chrome).overflow_y_scrollbar().p(10).gap(6).text_size(12)
    .child(h_flex().gap(8).items_center()
      .child(div().font_family(mono()).text_size(11).text_color(t.muted).child(c.hash))
      .child(div().flex_1())
      .child(div().id("cd-x").px(4).text_color(t.dim).cursor_pointer().on_click((_e, cx) => { h.selected = null; h.detail = null; cx.notify(); }).child("×")))
    .child(div().text_size(11.5).text_color(t.dim).child(`${c.author} <${c.email}> · ${new Date(c.at * 1000).toLocaleString()}${c.parents.length > 1 ? ` · merge de ${c.parents.length} padres` : ""}`))
    .child(div().text_color(t.foreground).child(det.body || c.subject))
    .children((h.ffAt?.[c.hash] ?? []).map((m, i) => notice(t, "info", `${ffMarkText(m)} (${relTime(m.at / 1000)})`, `cd-ff-${i}`)))
    .child(h_flex().gap(6).flex_wrap()
      .child(button(t, "cd-pick", `Cherry-pick en ${v.data.status.head ?? "HEAD"}…`, (_e, cx) => v.askPick(c, false, cx), { small: true, disabled: Boolean(v.op) }))
      .child(button(t, "cd-revert", "Revertir…", (_e, cx) => v.askPick(c, true, cx), { small: true, disabled: Boolean(v.op) }))
      .child(button(t, "cd-more", "⋯", (_e, cx) => v.commitMenu(c, cx), { small: true })))
    .when(Boolean(det.loading), (e) => e.child(h_flex().gap(6).text_color(t.dim).child(spinner(t, 11)).child("Cargando archivos…")))
    .when(Boolean(det.error), (e) => e.child(notice(t, "block", det.error)))
    .when(Boolean(det.files), (e) => e.child(sectionTitle(t, `${det.files.length} archivo(s)`)).children(det.files.slice(0, 300).map((f) =>
      h_flex().id(`cf-${f.path}`).gap(8).px(4).h(22).items_center().rounded(5).text_size(11.5).cursor_pointer().hover((st) => st.bg(t.hover))
        .on_click((_e, cx) => v.showDiff(`${c.short} · ${f.path}`, f.path, { to: c.hash }, cx))
        .child(div().w(12).flex_none().text_color(color[f.status] ?? t.muted).child(f.status))
        .child(div().min_w(0).truncate().font_family(mono()).child(f.orig ? `${f.orig} → ${f.path}` : f.path)))));
}

// ---------- Changes ----------
function changes(v, t) {
  const d = v.data, files = d.status.files, st = d.status, s = st.summary;
  const merging = d.ops.includes("merge");
  const roots = [d.repo.root, ...(d.repo.aliases ?? [])];
  const drafts = d.drafts ?? {};
  const unsavedOf = (p) => roots.map((r) => drafts[`${r}/${p}`]).find(Boolean);
  const color = { A: t.ansi2, D: t.ansi1, M: t.ansi3, R: t.ansi5, T: t.ansi3, U: t.blocked, "?": t.dim };
  const groups = [
    { id: "conflicts", label: "Conflictos", which: "unstaged", list: files.filter((f) => f.kind === "unmerged"), code: () => "U" },
    { id: "staged", label: "En stage", which: "staged", list: files.filter((f) => f.kind !== "unmerged" && f.kind !== "untracked" && f.x !== "."), code: (f) => f.x },
    { id: "unstaged", label: "Modificados", which: "unstaged", list: files.filter((f) => f.kind !== "unmerged" && f.kind !== "untracked" && f.y !== "."), code: (f) => f.y },
    { id: "untracked", label: "Sin seguimiento", which: "untracked", list: files.filter((f) => f.kind === "untracked"), code: () => "?" },
  ];
  const busy = Boolean(v.op);
  const icon = (id, label, tip, onClick, danger) => div().id(id).w(22).h(20).flex_none().flex().items_center().justify_center().rounded(5).text_size(13)
    .text_color(danger ? t.blocked : t.muted).cursor_pointer().hover((st) => st.bg(t.raised).text_color(t.foreground)).tooltip(tip)
    .on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); if (!busy) onClick(cx); }).child(label);
  const rows = [];
  for (const g of groups) {
    if (!g.list.length) continue;
    const all = g.list.map((f) => f.path);
    const groupAction = g.id === "staged" ? button(t, `ga-${g.id}`, "Unstage todo", (_e, cx) => v.unstagePaths(all, cx), { small: true, kind: "ghost", disabled: busy })
      : g.id === "conflicts" ? null
      : button(t, `ga-${g.id}`, "Stage todo", (_e, cx) => v.stagePaths(all, cx), { small: true, kind: "ghost", disabled: busy });
    rows.push(sectionTitle(t, `${g.label} · ${g.list.length}`, groupAction));
    for (const f of g.list.slice(0, 1000)) {
      const parts = f.path.split("/"), name = parts.pop();
      const sel = v.changeSel?.path === f.path && v.changeSel.which === g.which && (g.id !== "conflicts" || f.kind === "unmerged");
      const ns = (g.id === "staged" ? d.numstat?.staged : d.numstat?.unstaged)?.[f.path];
      const draft = unsavedOf(f.path);
      rows.push(h_flex().id(`ch-${g.id}-${f.path}`).h(26).mx(4).px(6).gap(6).items_center().rounded(6).cursor_pointer()
        .when(sel, (e) => e.bg(t.selected)).hover((st) => st.bg(sel ? t.selected : t.hover))
        .on_click((e, cx) => { if (e.click_count === 2) v.openInFiles(f.path, cx); else if (g.id === "conflicts") v.openConflict(f.path, cx); else v.selectChange(f.path, g.which, cx); })
        .child(div().w(12).flex_none().text_size(11).text_color(color[g.code(f)] ?? t.muted).child(g.code(f)))
        .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().flex_none().max_w(260).truncate().child(name)))
        .when(Boolean(f.orig), (e) => e.child(div().text_size(10.5).text_color(t.dim).truncate().max_w(120).child(`← ${f.orig}`)))
        .when(Boolean(draft), (e) => e.child(pill(t, draft.stale ? "otra versión en editor" : "sin guardar", draft.stale ? t.ansi3 : t.accent)))
        .when(Boolean(ns) && !ns.binary, (e) => e.child(div().flex_none().text_size(10.5).text_color(t.ansi2).child(ns.add ? `+${ns.add}` : "")).child(div().flex_none().text_size(10.5).text_color(t.ansi1).child(ns.del ? `−${ns.del}` : "")))
        .child(icon(`open-${g.id}-${f.path}`, "↗", "Abrir en Files", (cx) => v.openInFiles(f.path, cx)))
        .child(g.id === "staged" ? icon(`un-${f.path}`, "−", "Unstage (quitar del stage; el archivo no cambia)", (cx) => v.unstagePaths([f.path], cx))
          : g.id === "conflicts" ? icon(`res-${f.path}`, "✓", "Marcar como resuelto (git add)", (cx) => v.markResolved(f.path, cx))
          : icon(`st-${g.id}-${f.path}`, "+", "Stage", (cx) => v.stagePaths([f.path], cx))));
    }
  }
  const list = files.length
    ? div().id("changes-scroll").flex_1().min_h(80).when(Boolean(v.changeSel), (e) => e.max_h(Math.max(120, (v.height ?? 700) * 0.38))).overflow_y_scrollbar().py(4).children(rows)
    : div().flex_1().min_h(80).child(emptyState(t, "Sin cambios", "El working tree coincide con HEAD."));
  const diffPane = v.changeSel
    ? v_flex().flex_1().min_h(120).border_t(1).border_color(t.border)
      .child(h_flex().flex_none().h(28).px(10).gap(8).items_center().bg(t.chrome).text_size(11.5)
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(v.changeSel.path))
        .child(div().text_size(10.5).text_color(t.dim).child(v.changeSel.which === "staged" ? "en stage vs HEAD" : v.changeSel.which === "untracked" ? "archivo nuevo" : "working tree vs stage"))
        .child(div().id("diff-x").px(4).text_color(t.dim).cursor_pointer().on_click((_e, cx) => { v.changeSel = null; v.diff = null; cx.notify(); }).child("×")))
      .when(Boolean(v.diff?.split && v.diff.hunks.length), (e) => e.child(hunkBar(v, t)))
      .child(div().flex_1().min_h(0).child(diffView(t, "change-diff", v.diff, {
        scroll: v.diffScroll,
        onRow: (i, cx) => { const k = v.diff?.hunks?.indexOf(i) ?? -1; if (k >= 0) v.pickHunk(k, cx, false); },
      })))
    : null;
  // Commit bar. While a merge is in progress an empty message concludes it with Git's own.
  const canCommit = !busy && !s.conflicts && (s.staged > 0 || merging) && (Boolean(v.commitText.trim()) || merging);
  const stagedUnsaved = files.filter((f) => f.kind !== "untracked" && f.x !== "." && unsavedOf(f.path) && !unsavedOf(f.path).stale).map((f) => f.path);
  const ref = d.refs.find((r) => r.type === "local" && r.name === st.head);
  const commitBar = v_flex().flex_none().p(10).gap(7).border_t(1).border_color(t.border)
    .when(merging, (e) => e.child(div().text_size(11).text_color(t.ansi3).child(s.conflicts ? `Merge en curso: resuelve ${s.conflicts} conflicto(s) y márcalos con ✓.` : "Merge en curso: sin mensaje, el commit usa el de Git y concluye el merge.")))
    .when(stagedUnsaved.length > 0, (e) => e.child(notice(t, "warn", `El commit usará la versión en disco de ${stagedUnsaved.slice(0, 3).join(", ")}: en el editor hay cambios sin guardar.`, "cw-unsaved")))
    .child(h_flex().gap(8)
      .child(h_flex().id("commit-msg").flex_1().min_w(0).h(30).px(9).items_center().rounded(7).border_1().border_color(t.input).bg(t.background).on_mouse_down("left", stop)
        .child(Input.new(v.commitInput).h_full().text_size(12).text_color(t.foreground)))
      .child(button(t, "commit", merging && !v.commitText.trim() ? "Concluir merge" : s.staged ? `Commit (${s.staged})` : "Commit", (_e, cx) => v.doCommit(cx), { kind: "primary", disabled: !canCommit,
        tooltip: s.conflicts ? "Quedan conflictos" : !s.staged && !merging ? "Nada en stage" : !v.commitText.trim() && !merging ? "Escribe un mensaje" : `git commit en ${st.head ?? "HEAD"}` })))
    .child(h_flex().gap(6).text_size(10.5).text_color(t.dim)
      .child(div().flex_none().child("Autor:"))
      .child(h_flex().id("commit-author").min_w(0).cursor_pointer().hover((st) => st.text_color(t.foreground)).tooltip("Clic: fijar una cuenta a este proyecto").on_click((_e, cx) => v.accountMenu(cx))
        .text_color((d.account?.warnings ?? []).length ? t.ansi3 : t.muted).child(div().truncate().child(d.account?.email ? `${d.account.name ?? ""} <${d.account.email}>` : "sin correo configurado")))
      .child(div().flex_1())
      .child(div().flex_none().child("Doble clic: abrir en Files")));
  return v_flex().size_full().min_h(0).child(list).when(Boolean(diffPane), (e) => e.child(diffPane)).child(commitBar);
}
