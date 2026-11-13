// A diff, drawn as a virtual list (only visible rows cost anything). Rows carry
// no handlers: a virtual list's renderer may not register any.
import { div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { settings } from "herdr";
import { spinner } from "./kit.js";

const mono = () => settings().font_family ?? "JetBrains Mono";

/** opts.scroll: a VirtualListScrollHandle; opts.onRow(index, cx): a row was clicked; d.hl: a hunk row to highlight. */
export function diffView(t, id, d, opts = {}) {
  if (!d || d.loading) return h_flex().p(12).gap(8).items_center().text_color(t.dim).child(spinner(t)).child("Cargando diferencias…");
  if (d.error) return div().p(12).text_color(t.blocked).child(d.error);
  if (d.binary && !d.rows.length) return div().p(12).text_color(t.dim).child("Archivo binario: no se muestran diferencias de texto.");
  if (!d.rows.length) return div().p(12).text_color(t.dim).child("Sin diferencias de texto.");
  const rows = d.rows;
  const width = Math.max(320, ...rows.slice(0, 2000).map((r) => (r.text?.length ?? 0) * 6.7 + 96));
  const row = (r) => {
    if (r.kind === "@" && r.b !== undefined) return h_flex().w_full().h(18).flex_none().gap(8).bg(t.raised).text_color(t.dim)
      .child(div().w(34).flex_none()).child(div().w(34).flex_none().text_right().child(String(r.b))).child(div().w(10).flex_none()).child(div().flex_1().whitespace_nowrap().child(r.text));
    if (r.kind === "@") return div().w_full().h(18).px(10).flex_none().truncate().bg(r.i === d.hl ? t.accent + "33" : t.raised).text_color(r.i === d.hl ? t.foreground : t.dim).child(r.text);
    if (r.kind === "\\") return div().w_full().h(18).px(10).flex_none().text_color(t.dim).child(r.text);
    const bg = r.kind === "+" ? t.ansi2 + "1c" : r.kind === "-" ? t.ansi1 + "1c" : r.kind === "o" ? t.ansi4 + "22" : r.kind === "t" ? t.ansi5 + "22" : r.kind === "b" ? t.raised : null;
    return h_flex().w_full().h(18).flex_none().gap(8).when(Boolean(bg), (e) => e.bg(bg))
      .child(div().w(34).flex_none().text_right().text_color(t.dim).child(r.a === undefined ? "" : String(r.a)))
      .child(div().w(34).flex_none().text_right().text_color(t.dim).child(r.b === undefined ? "" : String(r.b)))
      .child(div().w(10).flex_none().text_color(r.kind === "+" ? t.ansi2 : r.kind === "-" ? t.ansi1 : r.kind === "o" ? t.ansi4 : r.kind === "t" ? t.ansi5 : t.dim).child(r.kind === "+" || r.kind === "-" ? r.kind : r.kind === "o" || r.kind === "t" ? "▌" : ""))
      .child(div().flex_1().whitespace_nowrap().child(r.text || " "));
  };
  return v_flex().size_full().min_h(0)
    .child(div().flex_1().min_h(0).relative().font_family(mono()).text_size(11)
      .child(div().id(`${id}-x`).size_full().overflow_x_scrollbar()
        .child(div().w_full().min_w(width).h_full()
          .child(v_virtual_list(id, rows.length, 18, (i) => String(i), (range) => rows.slice(range.start, range.end).map((r, k) => row({ ...r, i: range.start + k })))
            .when(Boolean(opts.scroll), (e) => e.track_scroll(opts.scroll))
            .when(Boolean(opts.onRow), (e) => e.on_item_click((key, cx) => opts.onRow(Number(key), cx)))
            .size_full())))
      .child(Scrollbar.vertical(id).viewport_from_layout().absolute().inset_0()))
    .when(Boolean(d.cut), (e) => e.child(div().px(10).py(4).text_size(10.5).text_color(t.dim).child("Diff recortado: se muestran las primeras 6.000 líneas.")));
}
