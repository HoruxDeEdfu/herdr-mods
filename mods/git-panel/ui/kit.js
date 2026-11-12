// Small building blocks drawn with theme() colors, so the panel follows the
// person's theme like Herdr's own Files and Changes panels.
import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";

export const ICON = (name) => `mods/git-panel/${name}.svg`;
export const stop = (_e, cx) => cx.stop_propagation();

/** kind: "primary" | "danger" | "ghost" | undefined (plain). */
export function button(t, id, label, onClick, { kind, disabled = false, icon, tooltip, small = false } = {}) {
  const bg = disabled ? t.raised : kind === "primary" ? t.solid : kind === "danger" ? t.blocked : kind === "ghost" ? t.chrome + "00" : t.raised;
  const fg = disabled ? t.dim : kind === "primary" ? t.solid_foreground : kind === "danger" ? t.solid_foreground : t.foreground;
  let el = h_flex().id(id).h(small ? 24 : 28).px(small ? 8 : 11).gap(5).flex_none().items_center().rounded(7).text_size(small ? 11.5 : 12)
    .bg(bg).text_color(fg).border_1().border_color(kind === "ghost" || kind === "primary" || kind === "danger" ? bg : t.border)
    .on_mouse_down("left", stop);
  if (!disabled) el = el.cursor_pointer().hover((s) => s.opacity(0.85)).on_click((e, cx) => { cx.stop_propagation(); onClick(e, cx); });
  if (tooltip) el = el.tooltip(tooltip);
  if (icon) el = el.child(svg(ICON(icon)).size(13).flex_none());
  return label ? el.child(label) : el;
}

export function pill(t, text, color, { title } = {}) {
  let el = div().px(5).h(17).flex_none().flex().items_center().rounded(4).border_1().border_color(color + "66").bg(color + "1a").text_size(10.5).text_color(color).child(text);
  return title ? el.id(`pill-${text}`).tooltip(title) : el;
}

export function sectionTitle(t, text, right) {
  return h_flex().h(24).px(12).items_center().gap(6).text_size(10.5).font_semibold().text_color(t.dim)
    .child(div().flex_1().child(text.toUpperCase())).when(Boolean(right), (e) => e.child(right));
}

/** level: "block" | "warn" | "info" | "ok" */
export function notice(t, level, text, id) {
  const color = level === "block" ? t.blocked : level === "warn" ? t.ansi3 : level === "ok" ? t.ansi2 : t.muted;
  const mark = level === "block" ? "⛔" : level === "warn" ? "⚠" : level === "ok" ? "✓" : "ℹ";
  return h_flex().id(id ?? `n-${text.slice(0, 40)}`).w_full().gap(8).px(10).py(6).rounded(7).bg(color + "14").border_1().border_color(color + "40").text_size(12)
    .child(div().flex_none().text_color(color).child(mark)).child(div().flex_1().min_w(0).text_color(t.foreground).child(text));
}

export const spinner = (t, size = 12) => svg(ICON("spinner")).size(size).flex_none().text_color(t.working).spin(900);

export function relTime(at) {
  const s = Math.max(0, Date.now() / 1000 - at);
  if (s < 60) return "ahora";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d`;
  const d = new Date(at * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const basename = (p) => (p ?? "").split(/[\\/]/).filter(Boolean).pop() ?? p;

/** A centered state for empty / loading / error. */
export function emptyState(t, title, detail, action) {
  return v_flex().size_full().items_center().justify_center().gap(6).p(20).text_size(12.5)
    .child(div().text_color(t.muted).font_semibold().child(title))
    .when(Boolean(detail), (e) => e.child(div().text_color(t.dim).text_center().child(detail)))
    .when(Boolean(action), (e) => e.child(div().pt(6).child(action)));
}

export const branchColor = (t, kind) => kind === "head" ? t.accent : kind === "tag" ? t.ansi3 : kind === "remote" ? t.ansi5 : t.ansi4;
