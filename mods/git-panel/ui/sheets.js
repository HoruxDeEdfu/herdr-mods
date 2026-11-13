// Sheets replace the panel body (no window-wide modal): every risky change is
// confirmed here, with what will happen, what blocks it and the exact command.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { settings } from "herdr";
import { button, pill, notice, spinner, relTime, sectionTitle, ICON, stop } from "./kit.js";
import { displayArgv } from "../git/runner.js";
import { ffPreviewLine, ffResultLine, sideLabels } from "../git/merge-flow.js";
import { diffView } from "./diffview.js";

const mono = () => settings().font_family ?? "JetBrains Mono";

function frame(v, t, title, content, footer, subtitle) {
  return v_flex().size_full().min_h(0)
    .child(h_flex().flex_none().h(38).px(12).gap(8).items_center().border_b(1).border_color(t.border)
      .child(v_flex().flex_1().min_w(0).child(div().font_semibold().truncate().child(title)).when(Boolean(subtitle), (e) => e.child(div().text_size(11).text_color(t.dim).truncate().child(subtitle))))
      .child(div().id("sheet-x").px(6).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground)).tooltip("Cerrar (Esc)").on_click((_e, cx) => v.closeSheet(cx)).child("×")))
    .child(div().id("sheet-body").flex_1().min_h(0).overflow_y_scrollbar().child(v_flex().p(12).gap(10).child(content)))
    .when(Boolean(footer), (e) => e.child(h_flex().flex_none().p(10).gap(8).justify_end().flex_wrap().border_t(1).border_color(t.border).child(footer.flex_wrap().justify_end())));
}

const loadingRow = (t, text) => h_flex().gap(8).items_center().text_color(t.dim).child(spinner(t)).child(text);
const flow = (t, from, to) => h_flex().gap(8).items_center().flex_wrap()
  .child(pill(t, from, t.ansi4)).child(div().text_color(t.dim).child("→")).child(pill(t, to, t.accent));

export function renderSheet(v, t, cx) {
  const s = v.sheet;
  switch (s.kind) {
    case "pick": return pickSheet(v, t, s);
    case "preview": return previewSheet(v, t, s);
    case "checkout": return checkoutSheet(v, t, s);
    case "result": return resultSheet(v, t, s);
    case "confirm": return confirmSheet(v, t, s);
    case "input": return inputSheet(v, t, s);
    case "compare": return compareSheet(v, t, s);
    case "log": return logSheet(v, t);
    case "push": return pushSheet(v, t, s);
    case "diff": return diffSheet(v, t, s);
    case "pick-commit": return pickCommitSheet(v, t, s);
    case "ff": return ffSheet(v, t, s);
    case "remote-delete": return remoteDeleteSheet(v, t, s);
    case "delete-branch": return deleteBranchSheet(v, t, s);
    case "batch-delete": return batchDeleteSheet(v, t, s);
    case "batch-result": return batchResultSheet(v, t, s);
    case "conflict": return conflictSheet(v, t, s);
    case "account": return accountSheet(v, t, s);
  }
  return div();
}

// ---------- branch picker (Merge… / Compare) ----------
function pickSheet(v, t, s) {
  const d = v.data, q = v.pickText.trim().toLowerCase(), head = d.status.head;
  const list = d.refs.filter((r) => r.type !== "tag" || s.purpose === "compare").filter((r) => !(r.type === "local" && r.name === head))
    .filter((r) => !q || r.name.toLowerCase().includes(q))
    .sort((a, b) => (a.type === b.type ? b.date - a.date : a.type === "local" ? -1 : b.type === "local" ? 1 : 0)).slice(0, 200);
  const content = v_flex().gap(6)
    .child(h_flex().id("pick-q").h(30).px(8).gap(6).items_center().rounded(7).border_1().border_color(t.input).on_mouse_down("left", stop)
      .child(svg(ICON("search")).size(12).text_color(t.dim)).child(Input.new(v.pickInput).h_full().text_size(12)))
    .child(div().text_size(11).text_color(t.dim).child(s.purpose === "merge" ? `Elige el origen. Destino: ${head} (la rama actual, sin checkout).` : "Recientes primero."))
    .children(list.map((r) => h_flex().id(`pk-${r.ref}`).h(30).px(8).gap(8).items_center().rounded(6).cursor_pointer().hover((st) => st.bg(t.hover))
      .on_click((_e, cx) => v.picked(r.name, cx))
      .child(pill(t, r.type === "local" ? "local" : r.type === "tag" ? "tag" : r.remote, r.type === "local" ? t.ansi4 : r.type === "tag" ? t.ansi3 : t.ansi5))
      .child(div().min_w(0).truncate().child(r.name)).child(div().flex_1())
      .child(div().text_size(10.5).text_color(t.dim).child(relTime(r.date)))))
    .when(!list.length, (e) => e.child(div().text_color(t.dim).child("Ninguna rama coincide.")));
  return frame(v, t, s.title, content, null);
}

// ---------- merge preview ----------
function previewSheet(v, t, s) {
  const p = s.preview;
  const title = `Fusionar ${s.source} en ${s.target ?? "…"}`;
  const sub = s.entry === "B" ? `Ahora estás en ${s.target}. Origen: tu rama anterior.` : s.entry === "pull" ? `Pull: fetch hecho; integra ${s.source} en tu rama.` : "Sin cambiar de rama: el destino es la rama actual.";
  if (s.loading) return frame(v, t, title, loadingRow(t, "Analizando el merge (sin tocar tus archivos)…"), null, sub);
  if (!p) return frame(v, t, title, notice(t, "block", s.error ?? "No se pudo preparar la vista previa."), button(t, "pv-close", "Cerrar", (_e, cx) => v.closeSheet(cx)), sub);
  const blocked = p.blocks.length > 0;
  const modes = [
    ["ff", "Fast-forward (sin commit de merge)", "git merge --ff"],
    ["no-ff", "Siempre crear commit de merge", "git merge --no-ff"],
    ...(p.ff ? [["ff-only", "Solo fast-forward", "git merge --ff-only"]] : []),
  ];
  const what = p.upToDate ? "Nada que integrar." : p.ff
    ? `${p.target} avanzará ${p.incomingCount} commit(s) en línea recta (fast-forward posible).`
    : `Las ramas divergieron: ${p.target} tiene ${p.targetOnly} commit(s) propios y ${p.source} aporta ${p.incomingCount}. Se creará un commit de merge.`;
  const simLine = p.ff || p.upToDate ? null
    : !p.sim ? notice(t, "warn", "No se simuló el merge.")
    : !p.sim.ok ? null
    : p.sim.clean ? notice(t, "ok", "La simulación (git merge-tree) no encontró conflictos con el estado actual de ambas ramas.")
    : v_flex().gap(4).child(notice(t, "warn", `La simulación encontró conflictos en ${p.sim.conflicts.length} archivo(s):`))
      .children(p.sim.conflicts.slice(0, 20).map((f) => div().pl(26).font_family(mono()).text_size(11.5).text_color(t.blocked).child(f)));
  const color = { A: t.ansi2, D: t.ansi1, M: t.ansi3, R: t.ansi5, T: t.ansi3 };
  const content = v_flex().gap(10)
    .child(flow(t, `origen · ${p.source}`, `destino · ${p.target}`))
    .when(Boolean(s.changed), (e) => e.child(notice(t, "warn", "El repositorio cambió desde la vista previa (¿un agente?). Revisa la información actualizada antes de confirmar.")))
    .when(Boolean(s.error), (e) => e.child(notice(t, "block", s.error)))
    .children(p.blocks.map((b) => notice(t, "block", b.text, `b-${b.id}`)))
    .child(div().text_color(t.foreground).child(what))
    .when(Boolean(simLine), (e) => e.child(simLine))
    .children(p.warnings.filter((w) => w.id !== "conflicts-expected").map((w) => notice(t, "warn", w.text, `w-${w.id}`)))
    .when(p.sync.length > 0, (e) => e.child(sectionTitle(t, "Sincronización")).children(p.sync.map((x) => h_flex().gap(8).px(4).text_size(11.5)
      .child(div().w(120).flex_none().truncate().text_color(t.muted).child(x.branch)).child(div().text_color(x.warn || x.behind ? t.ansi3 : t.dim).child(x.text)))))
    .when(p.incoming.length > 0, (e) => e.child(sectionTitle(t, `Commits que se integran · ${p.incomingCount}`)).children(p.incoming.slice(0, 25).map((c) => h_flex().gap(8).px(4).text_size(11.5)
      .child(div().flex_none().font_family(mono()).text_color(t.dim).child(c.short)).child(div().min_w(0).truncate().child(c.subject)).child(div().flex_1())
      .child(div().flex_none().text_color(t.dim).child(`${c.author} · ${relTime(c.at)}`))))
      .when(p.incomingCount > 25, (e) => e.child(div().px(4).text_size(11).text_color(t.dim).child(`… y ${p.incomingCount - 25} más`))))
    .when(p.files.length > 0, (e) => e.child(sectionTitle(t, `Archivos afectados · ${p.files.length}`)).children(p.files.slice(0, 40).map((f) => h_flex().gap(8).px(4).text_size(11.5)
      .child(div().w(12).flex_none().text_color(color[f.status] ?? t.muted).child(f.status)).child(div().min_w(0).truncate().font_family(mono()).child(f.path))))
      .when(p.files.length > 40, (e) => e.child(div().px(4).text_size(11).text_color(t.dim).child(`… y ${p.files.length - 40} más`))))
    .when(!blocked && !p.ff, (e) => e.child(div().font_family(mono()).text_size(11).text_color(t.dim).child(`git merge --no-edit ${p.source}`)))
    .when(!blocked && p.ff, (e) => e.child(sectionTitle(t, "Modo")).children(modes.map(([id, label, cmd]) => h_flex().id(`mode-${id}`).h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .when(s.mode === id, (el) => el.bg(t.selected)).hover((st) => st.bg(t.hover)).on_click((_e, cx) => { s.mode = id; cx.notify(); })
      .child(div().w(12).text_color(t.accent).child(s.mode === id ? "●" : "○")).child(div().flex_1().child(label)).child(div().font_family(mono()).text_size(10.5).text_color(t.dim).child(cmd))))
      .child(notice(t, "info", ffPreviewLine(p, s.mode), "ff-explain"))
      .when(Boolean(s.modeRemembered), (e) => e.child(div().px(4).text_size(11).text_color(t.dim).child("Modo recordado de tu último merge en este repositorio."))))
    .when(!blocked, (e) => e.child(div().text_size(11).text_color(t.dim).child("Antes de ejecutar se vuelve a comprobar el repositorio; si algo cambió, verás la vista previa actualizada.")));
  const footer = h_flex().gap(8)
    .child(button(t, "pv-cancel", "Cancelar", (_e, cx) => v.closeSheet(cx), { disabled: s.running }))
    .child(button(t, "pv-go", s.running ? "Fusionando…" : `Fusionar ${p.source} en ${p.target}`, (_e, cx) => v.confirmMerge(cx), { kind: "primary", disabled: blocked || s.running || Boolean(v.op) }));
  return frame(v, t, title, content, footer, sub);
}

// ---------- checkout (plain, or step 1 of "Integrar mi rama en T") ----------
function checkoutSheet(v, t, s) {
  const merging = Boolean(s.then);
  const title = merging ? `Integrar ${s.then.source} en ${s.target}` : `Cambiar a ${s.target}`;
  if (s.loading) return frame(v, t, title, loadingRow(t, "Comprobando si se puede cambiar de rama…"), null);
  const c = s.check ?? { blocks: [], warnings: [] };
  const blocked = c.blocks.length > 0 || Boolean(s.error && !s.check);
  const steps = merging ? v_flex().gap(4).text_size(12)
    .child(div().text_color(t.muted).child("Pasos:"))
    .child(div().child(`1. Cambiar de ${s.from} a ${s.target} (checkout). Necesita tu confirmación.`))
    .child(div().child(`2. Comprobar que ${s.target} es la rama activa.`))
    .child(div().child(`3. Mostrar la vista previa de ${s.then.source} → ${s.target}. El merge pide otra confirmación.`)) : null;
  const content = v_flex().gap(10)
    .child(flow(t, s.from ?? "HEAD", s.target))
    .when(Boolean(steps), (e) => e.child(steps))
    .when(Boolean(s.changed), (e) => e.child(notice(t, "warn", "El estado cambió mientras confirmabas. Revisa los avisos.")))
    .when(Boolean(s.error), (e) => e.child(notice(t, "block", s.error)))
    .children(c.blocks.map((b) => notice(t, "block", b.text, `cb-${b.id}`)))
    .children(c.warnings.map((w) => notice(t, "warn", w.text, `cw-${w.id}`)))
    .when(!blocked, (e) => e.child(div().font_family(mono()).text_size(11).text_color(t.dim).child(`git switch --no-guess ${s.target}`)));
  const footer = h_flex().gap(8)
    .child(button(t, "co-cancel", "Cancelar", (_e, cx) => v.closeSheet(cx), { disabled: s.running }))
    .when(Boolean(c.otherWorktree && merging), (e) => e.child(button(t, "co-wt", "Merge en ese worktree", (_e, cx) => v.continueInWorktree(cx), { tooltip: `Sin checkout: el panel se fija a ${c.otherWorktree} y abre allí la vista previa` })))
    .child(button(t, "co-go", s.running ? "Cambiando…" : `Cambiar a ${s.target}`, (_e, cx) => v.confirmCheckout(cx), { kind: "primary", disabled: blocked || s.running || Boolean(v.op) }));
  return frame(v, t, title, content, footer, merging ? `Tu rama ${s.then.source} será el origen` : null);
}

// ---------- after the merge ----------
function resultSheet(v, t, s) {
  if (s.ok) {
    const content = v_flex().gap(10).child(notice(t, "ok", s.ff ? `${s.target} avanzó ${s.count} commit(s) (fast-forward).` : `${s.source} se fusionó en ${s.target} con un commit de merge.`))
      .when(Boolean(s.ff), (e) => e.child(notice(t, "info", ffResultLine(s.target, s.head), "ff-result")))
      .child(div().font_family(mono()).text_size(11).text_color(t.dim).child(`HEAD ${s.head?.slice(0, 12) ?? ""}`));
    return frame(v, t, "Merge completado", content, h_flex().gap(8)
      .child(button(t, "rs-hist", "Ver en History", (_e, cx) => { v.sheet = null; v.showInHistory(s.head, cx); }))
      .child(button(t, "rs-ok", "Listo", (_e, cx) => v.closeSheet(cx), { kind: "primary" })));
  }
  const content = v_flex().gap(10)
    .child(notice(t, "warn", `El merge de ${s.source} en ${s.target} se detuvo con conflictos. Git dejó marcadores en los archivos; nada se ha descartado.`))
    .child(sectionTitle(t, `En conflicto · ${s.conflicts.length}`)).children(s.conflicts.map((f) => div().px(4).font_family(mono()).text_size(11.5).text_color(t.blocked).child(f)))
    .child(div().text_size(11.5).text_color(t.dim).child("Resuélvelos en el editor o en la terminal y haz commit, o aborta para volver al estado anterior. La cabecera muestra el merge en curso hasta que termine."));
  return frame(v, t, "Conflictos", content, h_flex().gap(8)
    .child(button(t, "rs-abort", "Abortar merge…", (_e, cx) => v.askAbort(cx), { kind: "danger" }))
    .child(button(t, "rs-close", "Resolver después", (_e, cx) => v.closeSheet(cx), { kind: "primary" })));
}

function confirmSheet(v, t, s) {
  const content = v_flex().gap(10).child(div().text_color(t.foreground).child(s.detail))
    .when(Boolean(s.command), (e) => e.child(div().font_family(mono()).text_size(11).text_color(t.dim).child(s.command)))
    .when(Boolean(s.error), (e) => e.child(notice(t, "block", s.error)));
  return frame(v, t, s.title, content, h_flex().gap(8)
    .child(button(t, "cf-cancel", "Cancelar", (_e, cx) => v.closeSheet(cx), { disabled: s.running }))
    .child(button(t, "cf-go", s.running ? "Ejecutando…" : s.action, (_e, cx) => s.run(cx), { kind: s.danger ? "danger" : "primary", disabled: s.running || Boolean(v.op) })));
}

function inputSheet(v, t, s) {
  const content = v_flex().gap(8)
    .child(div().text_size(11.5).text_color(t.dim).child("Nombre"))
    .child(h_flex().id("in-name").h(32).px(10).items_center().rounded(8).border_1().border_color(t.accent).on_mouse_down("left", stop).child(Input.new(v.nameInput).h_full().text_size(12.5)))
    .when(Boolean(s.hint), (e) => e.child(div().text_size(11).text_color(t.dim).child(s.hint)))
    .when(Boolean(s.error), (e) => e.child(notice(t, "block", s.error)))
    .when(s.purpose === "create", (e) => e.child(h_flex().id("in-co").gap(8).items_center().cursor_pointer().on_click((_e, cx) => { s.checkout = !s.checkout; cx.notify(); })
      .child(div().text_color(t.accent).child(s.checkout ? "☑" : "☐")).child(div().child("Cambiar a la nueva rama"))));
  return frame(v, t, s.title, content, h_flex().gap(8)
    .child(button(t, "in-cancel", "Cancelar", (_e, cx) => v.closeSheet(cx), { disabled: s.running }))
    .child(button(t, "in-go", s.purpose === "rename" ? "Renombrar" : s.purpose === "worktree" ? "Crear worktree" : "Crear rama", (_e, cx) => v.submitInput(cx), { kind: "primary", disabled: s.running || !(s.value ?? "").trim() || Boolean(v.op) })));
}

function compareSheet(v, t, s) {
  const title = `${s.a} ⇄ ${s.b}`;
  if (s.loading) return frame(v, t, title, loadingRow(t, "Comparando…"), null);
  if (s.error) return frame(v, t, title, notice(t, "block", s.error), null);
  const list = (items) => items.map((c) => h_flex().gap(8).px(4).text_size(11.5).child(div().flex_none().font_family(mono()).text_color(t.dim).child(c.short)).child(div().min_w(0).truncate().child(c.subject)));
  const content = v_flex().gap(8)
    .child(h_flex().gap(14).child(div().child(`Solo en ${s.a}: `).child(div().text_color(t.ansi2).child(String(s.lr.left)))).child(div().child(`Solo en ${s.b}: `).child(div().text_color(t.ansi3).child(String(s.lr.right)))))
    .when(!s.base, (e) => e.child(notice(t, "warn", "No comparten historia.")))
    .when(s.onlyB.length > 0, (e) => e.child(sectionTitle(t, `En ${s.b}, no en ${s.a}`)).children(list(s.onlyB)))
    .when(s.onlyA.length > 0, (e) => e.child(sectionTitle(t, `En ${s.a}, no en ${s.b}`)).children(list(s.onlyA)))
    .when(s.files.length > 0, (e) => e.child(sectionTitle(t, `Archivos distintos · ${s.files.length}`)).children(s.files.slice(0, 60).map((f) => h_flex().id(`cmpf-${f.path}`).gap(8).px(4).h(22).items_center().rounded(5).text_size(11.5).cursor_pointer().hover((st) => st.bg(t.hover))
      .on_click((_e, cx) => v.showDiff(`${s.a} ⇄ ${s.b} · ${f.path}`, f.path, { from: "HEAD", to: s.b }, cx))
      .child(div().w(12).child(f.status)).child(div().min_w(0).truncate().font_family(mono()).child(f.path)))));
  const canMerge = v.data && !v.data.status.detached && s.lr.right > 0;
  return frame(v, t, title, content, h_flex().gap(8)
    .child(button(t, "cmp-close", "Cerrar", (_e, cx) => v.closeSheet(cx)))
    .when(canMerge, (e) => e.child(button(t, "cmp-merge", `Fusionar ${s.b} en ${s.a}…`, (_e, cx) => v.preview(s.b, cx), { kind: "primary", disabled: Boolean(v.op) }))));
}

function logSheet(v, t) {
  const rows = v.oplog.slice(0, 200).map((e) => v_flex().id(`log-${e.id}-${e.at}`).px(4).py(5).gap(2).border_b(1).border_color(t.border)
    .child(h_flex().gap(8).text_size(11).text_color(t.dim)
      .child(div().text_color(e.code === 0 ? t.ansi2 : t.blocked).child(e.code === 0 ? "✓" : `✗ ${e.code}`))
      .child(div().child(new Date(e.at).toLocaleTimeString())).child(div().child(`${e.ms} ms`))
      .when(Boolean(e.label), (el) => el.child(div().text_color(t.muted).child(e.label))).child(div().flex_1()).child(div().truncate().max_w(200).child(e.cwd)))
    .child(div().font_family(mono()).text_size(11).text_color(t.foreground).child(displayArgv(e.argv)))
    .when(Boolean(e.stderr?.trim()), (el) => el.child(div().font_family(mono()).text_size(10.5).text_color(e.code === 0 ? t.dim : t.ansi1).child(e.stderr.trim().slice(0, 1200)))));
  const content = v_flex().gap(0)
    .child(div().pb(6).text_size(11).text_color(t.dim).child("Cada cambio (y cada lectura que falló) que el panel pidió a Git, el más reciente primero."))
    .children(rows).when(!rows.length, (e) => e.child(div().text_color(t.dim).child("Todavía no se ha ejecutado nada.")));
  return frame(v, t, "Registro de operaciones", content, button(t, "log-clear", "Vaciar", (_e, cx) => { v.oplog = []; v.store("oplog", "[]"); cx.notify(); }, { small: true }));
}

function pushSheet(v, t, s) {
  const c = s.check;
  const title = c?.setUpstream ? `Publicar ${c.branch ?? ""}` : `Push ${c?.branch ?? ""}`;
  if (s.loading) return frame(v, t, "Push", loadingRow(t, "Comprobando qué se publicaría…"), null);
  if (!c) return frame(v, t, "Push", notice(t, "block", s.error ?? "No se pudo preparar el push."), null);
  const cmd = `git push ${c.setUpstream ? "--set-upstream " : ""}${c.remote} refs/heads/${c.branch}:refs/heads/${c.branch}`;
  const blocked = c.blocks.length > 0;
  const content = v_flex().gap(10)
    .child(flow(t, c.branch ?? "HEAD", c.upstream ?? `${c.remote}/${c.branch}`))
    .when(Boolean(s.account), (e) => e.child(accountLine(t, s.account)))
    .when(Boolean(s.changed), (e) => e.child(notice(t, "warn", "El estado cambió mientras confirmabas. Revisa los avisos.")))
    .when(Boolean(s.error), (e) => e.child(notice(t, "block", s.error)))
    .children(c.blocks.map((b) => notice(t, "block", b.text, `pb-${b.id}`)))
    .children(c.warnings.map((w) => notice(t, "warn", w.text, `pw-${w.id}`)))
    .when((s.commits ?? []).length > 0, (e) => e.child(sectionTitle(t, `Commits que se publican · ${c.ahead}`)).children(s.commits.map((x) => h_flex().gap(8).px(4).text_size(11.5)
      .child(div().flex_none().font_family(mono()).text_color(t.dim).child(x.short)).child(div().min_w(0).truncate().child(x.subject)))))
    .when(!blocked, (e) => e.child(div().font_family(mono()).text_size(11).text_color(t.dim).child(cmd)));
  return frame(v, t, title, content, h_flex().gap(8)
    .child(button(t, "ps-cancel", "Cancelar", (_e, cx) => v.closeSheet(cx), { disabled: s.running }))
    .when(c.blocks.some((b) => b.id === "behind") || Boolean(s.rejected), (e) => e.child(button(t, "ps-pull", "Pull…", (_e, cx) => { v.sheet = null; v.startPull(cx); })))
    .child(button(t, "ps-go", s.running ? "Publicando…" : c.setUpstream ? "Publicar rama" : "Push", (_e, cx) => v.confirmPush(cx), { kind: "primary", disabled: blocked || s.running || Boolean(v.op) })));
}

function diffSheet(v, t, s) {
  const d = s.diff ?? {};
  return v_flex().size_full().min_h(0)
    .child(h_flex().flex_none().h(38).px(10).gap(8).items_center().border_b(1).border_color(t.border)
      .when(Boolean(s.back), (e) => e.child(button(t, "df-back", "← Volver", (_e, cx) => { v.sheet = s.back; cx.notify(); }, { small: true, kind: "ghost" })))
      .child(div().flex_1().min_w(0).truncate().font_semibold().child(s.title))
      .when(!d.loading && !d.error, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${d.adds ?? 0}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${d.dels ?? 0}`)))
      .child(div().id("df-x").px(6).text_color(t.dim).cursor_pointer().on_click((_e, cx) => v.closeSheet(cx)).child("×")))
    .child(div().flex_1().min_h(0).child(diffView(t, "sheet-diff", d)));
}

function pickCommitSheet(v, t, s) {
  const c = s.commit, verb = s.revert ? "Revertir" : "Cherry-pick de";
  const title = `${verb} ${c.short} en ${s.head}`;
  const sub = s.revert ? "Crea un commit nuevo que deshace ese commit. El historial no se reescribe." : "Copia los cambios de ese commit como un commit nuevo en la rama actual.";
  if (s.loading) return frame(v, t, title, loadingRow(t, "Simulando (sin tocar tus archivos)…"), null, sub);
  const p = s.preview;
  if (!p) return frame(v, t, title, notice(t, "block", s.error ?? "No se pudo preparar."), null, sub);
  const blocked = p.blocks.length > 0;
  const simLine = !p.sim ? null : !p.sim.ok ? null : p.sim.clean ? notice(t, "ok", "La simulación (git merge-tree) no encontró conflictos.")
    : v_flex().gap(4).child(notice(t, "warn", `La simulación encontró conflictos en ${p.sim.conflicts.length} archivo(s):`)).children(p.sim.conflicts.slice(0, 20).map((f) => div().pl(26).font_family(mono()).text_size(11.5).text_color(t.blocked).child(f)));
  const color = { A: t.ansi2, D: t.ansi1, M: t.ansi3, R: t.ansi5 };
  const cmd = `git ${s.revert ? "revert --no-edit" : "cherry-pick"}${p.mainline ? ` -m ${p.mainline}` : ""} ${c.short}`;
  const content = v_flex().gap(10)
    .child(h_flex().gap(8).child(div().font_family(mono()).text_color(t.dim).child(c.short)).child(div().min_w(0).truncate().child(c.subject)))
    .child(div().text_size(11).text_color(t.dim).child(`${c.author} · ${relTime(c.at)}`))
    .when(Boolean(s.changed), (e) => e.child(notice(t, "warn", "El repositorio cambió mientras confirmabas (¿un agente?). Revisa la información actualizada.")))
    .when(Boolean(s.error), (e) => e.child(notice(t, "block", s.error)))
    .children(p.blocks.map((b) => notice(t, "block", b.text, `pk-b-${b.id}`)))
    .when(Boolean(simLine), (e) => e.child(simLine))
    .children(p.warnings.filter((w) => w.id !== "conflicts-expected").map((w) => notice(t, "warn", w.text, `pk-w-${w.id}`)))
    .when(p.files.length > 0, (e) => e.child(sectionTitle(t, `Archivos · ${p.files.length}`)).children(p.files.slice(0, 40).map((f) => h_flex().gap(8).px(4).text_size(11.5)
      .child(div().w(12).flex_none().text_color(color[f.status] ?? t.muted).child(f.status)).child(div().min_w(0).truncate().font_family(mono()).child(f.path)))))
    .when(!blocked, (e) => e.child(div().font_family(mono()).text_size(11).text_color(t.dim).child(cmd)));
  return frame(v, t, title, content, h_flex().gap(8)
    .child(button(t, "pk-cancel", "Cancelar", (_e, cx) => v.closeSheet(cx), { disabled: s.running }))
    .child(button(t, "pk-go", s.running ? "Aplicando…" : s.revert ? "Revertir" : "Cherry-pick", (_e, cx) => v.confirmPick(cx), { kind: "primary", disabled: blocked || s.running || Boolean(v.op) })), sub);
}

function conflictSheet(v, t, s) {
  const head = v.data?.status.head ?? "HEAD";
  const L = sideLabels(s.op, head, v.data?.rebase), mine = L.ours, theirs = L.theirs;
  return v_flex().size_full().min_h(0)
    .child(h_flex().flex_none().h(38).px(10).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().font_semibold().child(`Conflicto · ${s.path}`))
      .when(s.markers != null, (e) => e.child(pill(t, s.markers ? `${s.markers} bloque(s) en conflicto` : "sin marcadores", s.markers ? t.blocked : t.ansi2)))
      .child(div().id("cs-x").px(6).text_color(t.dim).cursor_pointer().on_click((_e, cx) => v.closeSheet(cx)).child("×")))
    .child(div().px(12).py(8).text_size(11.5).text_color(t.muted).child("Edítalo en Files y márcalo como resuelto, o quédate entera con una de las dos versiones. Nada se descarta sin confirmarlo."))
    .child(h_flex().px(12).pb(8).gap(12).text_size(11).child(h_flex().gap(5).items_center().child(div().size(9).rounded(2).bg(t.ansi4)).child(div().text_color(t.muted).child(`${mine} (ours)`)))
      .child(h_flex().gap(5).items_center().child(div().size(9).rounded(2).bg(t.ansi5)).child(div().text_color(t.muted).child(`${theirs} (theirs)`))))
    .when(Boolean(s.error), (e) => e.child(div().px(10).child(notice(t, "block", s.error))))
    .child(div().flex_1().min_h(0).border_t(1).border_color(t.border).child(diffView(t, "conflict-diff", s.loading ? { loading: true } : s.diff)))
    .child(h_flex().flex_none().p(10).gap(6).flex_wrap().justify_end().border_t(1).border_color(t.border)
      .child(button(t, "cs-open", "Abrir en Files", (_e, cx) => v.openInFiles(s.path, cx), { small: true }))
      .child(button(t, "cs-ours", `Usar ${mine}`, (_e, cx) => v.resolveSide("ours", cx), { small: true, disabled: Boolean(v.op) }))
      .child(button(t, "cs-theirs", `Usar ${theirs}`, (_e, cx) => v.resolveSide("theirs", cx), { small: true, disabled: Boolean(v.op) }))
      .child(button(t, "cs-done", "Marcar resuelto ✓", (_e, cx) => { v.sheet = null; v.markResolved(s.path, cx); }, { small: true, kind: "primary", disabled: Boolean(v.op) })));
}

function ffSheet(v, t, s) {
  const title = `Actualizar ${s.branch}`;
  const sub = "Sin cambiar de rama: solo avanza la rama si no ha divergido (fast-forward).";
  if (s.loading) return frame(v, t, title, loadingRow(t, "Haciendo fetch y comprobando…"), null, sub);
  const c = s.check;
  if (!c) return frame(v, t, title, notice(t, "block", s.error ?? "No se pudo preparar."), null, sub);
  const blocked = c.blocks.length > 0;
  const content = v_flex().gap(10)
    .child(flow(t, c.upstream ?? "upstream", s.branch))
    .when(Boolean(s.fetchError), (e) => e.child(notice(t, "warn", `El fetch falló (${s.fetchError}). Los datos pueden no estar al día.`)))
    .when(Boolean(s.changed), (e) => e.child(notice(t, "warn", "El estado cambió mientras confirmabas. Revisa los avisos.")))
    .when(Boolean(s.error), (e) => e.child(notice(t, "block", s.error)))
    .children(c.blocks.map((b) => notice(t, "block", b.text, `ff-${b.id}`)))
    .when(c.blocks.some((b) => b.id === "diverged"), (e) => e.child(button(t, "ff-switch", `Cambiar a ${s.branch}…`, (_e, cx) => v.askCheckout(s.branch, null, cx), { small: true })))
    .when(!blocked, (e) => e.child(div().text_color(t.foreground).child(`${s.branch} avanzará ${c.behind} commit(s) hasta ${c.upstream}. Tu rama actual, tu working tree y tu stage no cambian.`)))
    .when((s.commits ?? []).length > 0, (e) => e.child(sectionTitle(t, `Commits que llegan · ${c.behind}`)).children(s.commits.map((x) => h_flex().gap(8).px(4).text_size(11.5)
      .child(div().flex_none().font_family(mono()).text_color(t.dim).child(x.short)).child(div().min_w(0).truncate().child(x.subject)).child(div().flex_1())
      .child(div().flex_none().text_color(t.dim).child(`${x.author} · ${relTime(x.at)}`)))))
    .when(!blocked, (e) => e.child(div().font_family(mono()).text_size(11).text_color(t.dim).child(`git fetch . refs/remotes/${c.upstream}:refs/heads/${s.branch}`)));
  return frame(v, t, title, content, h_flex().gap(8)
    .child(button(t, "ff-cancel", "Cancelar", (_e, cx) => v.closeSheet(cx), { disabled: s.running }))
    .child(button(t, "ff-go", s.running ? "Actualizando…" : `Actualizar ${s.branch}`, (_e, cx) => v.confirmFastForward(cx), { kind: "primary", disabled: blocked || s.running || Boolean(v.op) })), sub);
}

// ---------- accounts ----------
const SOURCE = { pinned: "fijada a este proyecto", global: "cuenta global de gh", ssh: "por SSH: la decide tu llave", "own-helper": "helper propio del repositorio" };

/** "Se publica como X · autor Y", for the push sheet. */
function accountLine(t, a) {
  return v_flex().gap(4).px(10).py(8).rounded(8).bg(t.raised).text_size(11.5)
    .child(h_flex().gap(6).child(div().text_color(t.dim).w(64).flex_none().child("Push con")).child(div().font_semibold().child(a.pushLogin ?? "—")).child(div().text_color(t.dim).truncate().child(SOURCE[a.pushSource] ?? "")))
    .child(h_flex().gap(6).child(div().text_color(t.dim).w(64).flex_none().child("Autor")).child(div().truncate().child(`${a.name ?? "?"} <${a.email ?? "sin correo"}>`)))
    .children((a.warnings ?? []).map((w, i) => notice(t, "warn", w, `acw-${i}`)));
}

function accountSheet(v, t, s) {
  const a = s.account;
  const field = (id, label, input) => v_flex().gap(4)
    .child(div().text_size(11.5).text_color(t.dim).child(label))
    .child(h_flex().id(id).h(32).px(10).items_center().rounded(8).border_1().border_color(t.input).on_mouse_down("left", stop).child(Input.new(input).h_full().text_size(12.5)));
  const changes = [
    "Solo en este repositorio (.git/config). Tu ~/.gitconfig y los demás proyectos no cambian.",
    "Los commits nuevos se firman con este nombre y correo. Los commits que ya existen no se modifican.",
    s.login && a.https ? `Fetch, pull y push salen con ${s.login}, aunque la cuenta activa de gh sea otra.` : !a.https && a.remote ? "El remoto usa SSH: la cuenta de push la decide tu llave SSH, no cambia." : null,
  ].filter(Boolean);
  const content = v_flex().gap(10)
    .child(field("acc-name", "Nombre del autor", v.idName))
    .child(field("acc-email", "Correo del autor", v.idEmail))
    .when(Boolean(s.login), (e) => e.child(div().text_size(11).text_color(t.dim).child(`Se recuerdan para ${s.login}: la próxima vez que fijes esta cuenta en otro proyecto ya estarán puestos. Si no quieres exponer tu correo, GitHub te da uno privado (Settings → Emails).`)))
    .when(Boolean(s.error), (e) => e.child(notice(t, "block", s.error)))
    .child(sectionTitle(t, "Qué cambia"))
    .children(changes.map((c, i) => h_flex().id(`acc-c${i}`).gap(6).text_size(11.5).child(div().text_color(t.dim).child("•")).child(div().flex_1().min_w(0).child(c))));
  return frame(v, t, s.title, content, h_flex().gap(8)
    .child(button(t, "acc-cancel", "Cancelar", (_e, cx) => v.closeSheet(cx), { disabled: s.running }))
    .child(button(t, "acc-go", s.running ? "Fijando…" : "Fijar", (_e, cx) => v.confirmPin(cx), { kind: "primary", disabled: s.running || Boolean(v.op) })), a.remote ? `${a.remote} · ${a.host ?? ""}` : null);
}

// ---------- delete a branch on its remote ----------
function remoteDeleteSheet(v, t, s) {
  const title = `Eliminar ${s.name} del remoto`;
  const sub = "Borra la rama en el servidor para todo el equipo. Tus ramas locales y sus commits no cambian.";
  if (s.loading) return frame(v, t, title, loadingRow(t, `Actualizando ${s.remote} (fetch) y comprobando la rama…`), null, sub);
  const c = s.check ?? { blocks: [], warnings: [] };
  const blocked = c.blocks.length > 0 || !s.check;
  const content = v_flex().gap(10)
    .when(Boolean(s.ref), (e) => e.child(h_flex().gap(8).items_center().text_size(12)
      .child(pill(t, s.name, t.ansi5)).child(div().font_family(mono()).text_size(11).text_color(t.dim).child(s.ref.short))
      .child(div().min_w(0).truncate().text_color(t.muted).child(s.ref.subject))))
    .when(Boolean(s.error), (e) => e.child(notice(t, "block", s.error)))
    .children(c.blocks.map((b) => notice(t, "block", b.text, `rd-b-${b.id}`)))
    .children(c.warnings.map((w) => notice(t, "warn", w.text, `rd-w-${w.id}`)))
    .when(Boolean(c.needsSecond) && !blocked, (e) => e.child(h_flex().id("rd-ack").gap(8).px(8).h(30).items_center().rounded(6).cursor_pointer()
      .border_1().border_color(s.ack ? t.blocked + "88" : t.border).hover((st) => st.bg(t.hover))
      .on_click((_e, cx) => { s.ack = !s.ack; cx.notify(); })
      .child(div().text_color(s.ack ? t.blocked : t.dim).child(s.ack ? "☑" : "☐"))
      .child(div().text_size(12).child("Entiendo que esos commits dejarán de estar en el remoto"))))
    .when(!blocked, (e) => e.child(div().font_family(mono()).text_size(11).text_color(t.dim).child(c.command))
      .child(div().text_size(11).text_color(t.dim).child("Justo antes se pregunta al remoto dónde está la rama: si alguien la actualizó, no se elimina. Nunca es un force push.")));
  const footer = h_flex().gap(8)
    .child(button(t, "rd-cancel", "Cancelar", (_e, cx) => v.closeSheet(cx), { disabled: s.running }))
    .child(button(t, "rd-go", s.running ? "Eliminando…" : "Eliminar del remoto", (_e, cx) => v.confirmDeleteRemote(cx),
      { kind: "danger", disabled: blocked || s.running || Boolean(v.op) || (c.needsSecond && !s.ack) }));
  return frame(v, t, title, content, footer, sub);
}

// ---------- delete a local branch (and, if ticked, its upstream) ----------
function deleteBranchSheet(v, t, s) {
  const p = s.pair;
  const box = (on, enabled) => div().text_color(!enabled ? t.dim : on ? t.blocked : t.muted).child(on ? "☑" : "☐");
  const content = v_flex().gap(10)
    .child(div().text_color(t.foreground).child("Solo se elimina si sus commits ya están integrados en otra rama (git branch -d)."))
    .when(Boolean(s.loading), (e) => e.child(loadingRow(t, "Comprobando su rama en el remoto (fetch)…")))
    .when(Boolean(s.pairError), (e) => e.child(notice(t, "warn", `No se pudo comprobar el remoto: ${s.pairError} Solo se eliminará la rama local.`)))
    .when(Boolean(p), (e) => e.child(v_flex().gap(4)
      .child(h_flex().id("db-remote").gap(8).px(8).py(6).items_center().rounded(6).border_1()
        .border_color(s.withRemote ? t.blocked + "88" : t.border)
        .when(p.enabled, (el) => el.cursor_pointer().hover((st) => st.bg(t.hover)).on_click((_e, cx) => { s.withRemote = !s.withRemote; cx.notify(); }))
        .child(box(s.withRemote, p.enabled))
        .child(div().flex_1().text_size(12).text_color(p.enabled ? t.foreground : t.dim).child(`Eliminar también ${p.remote}/${p.branch} del remoto`)))
      .when(Boolean(p.reason), (el) => el.child(div().px(8).text_size(11).text_color(t.dim).child(p.reason)))
      .when(Boolean(s.withRemote), (el) => el.child(div().px(8).text_size(11).text_color(t.dim).child(`Afecta a todos los que usan ${p.remote}. Se borra después de la local y solo si nadie la actualizó entretanto. Nunca es un force push.`)))))
    .child(div().font_family(mono()).text_size(11).text_color(t.dim).child(`git branch -d ${s.name}`))
    .when(Boolean(s.withRemote && p?.enabled), (e) => e.child(div().font_family(mono()).text_size(11).text_color(t.dim).child(p.command)))
    .when(Boolean(s.error), (e) => e.child(notice(t, "block", s.error)));
  const footer = h_flex().gap(8)
    .child(button(t, "db-cancel", "Cancelar", (_e, cx) => v.closeSheet(cx), { disabled: s.running }))
    .child(button(t, "db-go", s.running ? "Eliminando…" : s.withRemote ? "Eliminar local y remota" : "Eliminar rama", (_e, cx) => v.deleteBranch(s.name, false, cx),
      { kind: "danger", disabled: s.loading || s.running || Boolean(v.op) }));
  return frame(v, t, `¿Eliminar la rama ${s.name}?`, content, footer, p ? `Sigue a ${p.remote}/${p.branch}` : null);
}

// ---------- several local branches (and, where ticked, their upstreams) ----------
function batchDeleteSheet(v, t, s) {
  const title = `Eliminar ${s.names.length} ramas`;
  const sub = "Cada una con git branch -d (nunca -D en lote). Las que no se pueden se saltan.";
  if (s.loading) return frame(v, t, title, loadingRow(t, "Comprobando las ramas y sus remotos (fetch)…"), null, sub);
  const ok = s.rows.filter((r) => r.ok), skip = s.rows.filter((r) => !r.ok);
  const eligible = ok.filter((r) => r.pair?.enabled);
  const allOn = eligible.length > 0 && eligible.every((r) => s.withRemote[r.name]);
  const nRemote = eligible.filter((r) => s.withRemote[r.name]).length;
  const box = (on, enabled) => div().w(14).flex_none().text_color(!enabled ? t.dim : on ? t.blocked : t.muted).child(on ? "☑" : "☐");
  const row = (r) => v_flex().gap(2).py(4).border_b(1).border_color(t.border)
    .child(h_flex().gap(8).items_center().text_size(12)
      .child(div().w(14).flex_none().text_color(r.ok ? t.ansi2 : t.dim).child(r.ok ? "✓" : "–"))
      .child(div().min_w(0).flex_1().truncate().text_color(r.ok ? t.foreground : t.dim).child(r.name)))
    .when(!r.ok, (e) => e.child(div().pl(22).text_size(11).text_color(t.dim).child(r.reason)))
    .when(Boolean(r.pair), (e) => e.child(h_flex().id(`bd-r-${r.name}`).pl(22).gap(6).items_center().text_size(11.5)
      .when(r.pair.enabled, (el) => el.cursor_pointer().on_click((_e, cx) => { s.withRemote[r.name] = !s.withRemote[r.name]; cx.notify(); }))
      .child(box(Boolean(s.withRemote[r.name]), r.pair.enabled))
      .child(div().text_color(r.pair.enabled ? t.muted : t.dim).child(`también ${r.pair.remote}/${r.pair.branch}`))))
    .when(Boolean(r.pair && !r.pair.enabled), (e) => e.child(div().pl(42).text_size(10.5).text_color(t.dim).child(r.pair.reason)));
  const content = v_flex().gap(8)
    .when(Boolean(s.error), (e) => e.child(notice(t, "block", s.error)))
    .when(eligible.length > 0, (e) => e.child(h_flex().id("bd-all").gap(8).px(8).py(6).items_center().rounded(6).cursor_pointer()
      .border_1().border_color(allOn ? t.blocked + "88" : t.border).hover((st) => st.bg(t.hover))
      .on_click((_e, cx) => { for (const r of eligible) s.withRemote[r.name] = !allOn; cx.notify(); })
      .child(box(allOn, true)).child(div().text_size(12).child(`También en el remoto cuando sea seguro (${eligible.length})`))))
    .when(nRemote > 0, (e) => e.child(div().text_size(11).text_color(t.dim).child("Afecta a todos los que usan el remoto. Cada una se borra después de su rama local y solo si nadie la actualizó y ningún commit queda sin rama. Nunca es un force push.")))
    .child(sectionTitle(t, `Se eliminarán · ${ok.length}`)).children(ok.map(row))
    .when(skip.length > 0, (e) => e.child(sectionTitle(t, `Se saltan · ${skip.length}`)).children(skip.map(row)));
  const footer = h_flex().gap(8)
    .child(button(t, "bd-cancel", "Cancelar", (_e, cx) => v.closeSheet(cx), { disabled: s.running }))
    .child(button(t, "bd-go", s.running ? "Eliminando…" : nRemote ? `Eliminar ${ok.length} (y ${nRemote} remotas)` : `Eliminar ${ok.length}`, (_e, cx) => v.runDeleteBatch(cx),
      { kind: "danger", disabled: !ok.length || s.running || Boolean(v.op) }));
  return frame(v, t, title, content, footer, sub);
}

function batchResultSheet(v, t, s) {
  const mark = (x) => !x ? null : x.ok ? "✓" : "✕";
  const content = v_flex().gap(6).children(s.results.map((r) => v_flex().gap(2).py(4).border_b(1).border_color(t.border)
    .child(h_flex().gap(8).items_center().text_size(12)
      .child(div().w(14).flex_none().text_color(r.local?.ok ? t.ansi2 : t.blocked).child(mark(r.local)))
      .child(div().flex_1().min_w(0).truncate().child(r.name))
      .when(Boolean(r.remote), (e) => e.child(div().text_size(11).text_color(r.remote.ok ? t.ansi2 : t.ansi3).child(r.remote.ok ? "✓ remoto" : "remoto no"))))
    .when(Boolean(r.local && !r.local.ok && r.local.text), (e) => e.child(div().pl(22).text_size(11).text_color(t.dim).child(r.local.text)))
    .when(Boolean(r.remote), (e) => e.child(div().pl(22).text_size(11).text_color(t.dim).child(r.remote.text)))));
  const done = s.results.filter((r) => r.local?.ok).length;
  return frame(v, t, `${done} de ${s.results.length} ramas eliminadas`, content, h_flex().gap(8).child(button(t, "br-ok", "Listo", (_e, cx) => v.closeSheet(cx), { kind: "primary" })));
}
