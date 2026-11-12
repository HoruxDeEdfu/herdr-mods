// The context menu, drawn by a popup copy of this mod. It runs nothing itself:
// the pick goes back to the panel copy that opened it (owner + nonce) through
// shared state, and the panel runs the action with its fresh data.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, setShared, closeOverlay, theme } from "herdr";

export const PICK = "git-panel.pick";

function choose(view, item) {
  if (!item || item.disabled || item.sep) return;
  const m = props().menu;
  setShared(PICK, { owner: m.owner, nonce: m.nonce, id: item.id });
  closeOverlay(props().overlay);
}

export function renderMenu(view, _cx) {
  const t = theme(), m = props()?.menu ?? { items: [] }, items = m.items;
  const step = (d) => {
    const n = items.length;
    for (let k = 1; k <= n; k++) {
      const i = (view.sel + d * k + n * 2) % n;
      if (!items[i].sep && !items[i].disabled) { view.sel = i; return; }
    }
  };
  return v_flex().id("gp-menu").track_focus(view.handle).size_full().p(4).bg(t.popover).text_size(12.5).text_color(t.foreground)
    .on_key_down((e, cx) => {
      if (e.key === "down") step(1);
      else if (e.key === "up") step(-1);
      else if (e.key === "enter") choose(view, items[view.sel]);
      else if (e.key === "escape") closeOverlay(props().overlay);
      else return;
      cx.stop_propagation(); cx.notify();
    })
    .when(Boolean(m.title), (e) => e.child(div().px(10).h(30).flex().items_center().text_size(11).text_color(t.dim).truncate().child(m.title)))
    .children(items.map((it, i) => it.sep
      ? div().id(`sep-${it.id}`).my(4).h(1).bg(t.border)
      : h_flex().id(`mi-${it.id}`).h(30).px(10).gap(8).items_center().rounded(6)
        .when(!it.disabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => choose(view, it)))
        .when(i === view.sel && !it.disabled, (e) => e.bg(t.selected))
        .when(Boolean(it.hint), (e) => e.tooltip(it.hint))
        .child(div().flex_1().min_w(0).truncate().text_color(it.disabled ? t.dim : it.danger ? t.blocked : t.foreground).child(it.label))));
}
