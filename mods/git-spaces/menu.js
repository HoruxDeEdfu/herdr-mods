// git-spaces: a space's right-click menu, drawn by a popup copy of this mod.
// Herdr's own items (from mods/menu: rename, worktrees, close) plus "Reveal in
// Finder", which opens the space's folder in the system's file manager.
// Opened with props { spaceMenu: { id } }.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, keys, spaces, panes, exec, window } from "herdr";

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

// A space's checkout: "main" (a repo's own), "linked" (a worktree), or null.
async function checkout(folder, on) {
  const [top, common] = await Promise.all([
    exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on }),
    exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder, on }),
  ]);
  if (top.code !== 0 || common.code !== 0) return null;
  return common.stdout.trim() === `${top.stdout.trim()}/.git` ? "main" : "linked";
}

const revealLabel = () => { const p = window()?.platform; return p === "macos" ? "Reveal in Finder" : p === "windows" ? "Show in Explorer" : "Open folder"; };

// Opens the folder itself (not its parent with it selected): the space *is* the folder.
function reveal(path) {
  const p = window()?.platform;
  const [cmd, args] = p === "macos" ? ["open", [path]] : p === "windows" ? ["explorer", [path.replace(/\//g, "\\")]] : ["xdg-open", [path]];
  exec(cmd, args).catch(() => {});
}

// [label, command, args, icon, { disabled, hint }]; "worktree" opens its dialog, "reveal" the folder.
function items(view) {
  const id = props()?.spaceMenu?.id;
  const s = spaces().find((x) => x.id === id);
  const folder = s && place(s);
  const remote = Boolean(s?.machine);
  return [
    ["Rename", "space.rename", { id }, "square-pen"],
    ["Reveal", "reveal", { folder }, "folder", { label: revealLabel(), disabled: !folder || remote, hint: remote ? "Only for spaces on this computer" : undefined }],
    ...(view.git ? [["New worktree", "worktree", { space: id, action: "new" }, "git-branch"], ["Open worktree", "worktree", { space: id, action: "open" }, "git-branch"]] : []),
    ...(view.git === "linked" ? [["Remove worktree", "worktree", { space: id, action: "remove" }, "git-branch"]] : []),
    ["Close", "space.close", { id }, "x"],
  ];
}

// The key bound to a command, for the hint on the right.
function shortcut(name, args) {
  const value = args && Object.values(args)[0];
  const k = keys().find((b) => b.section === "global" && (b.action === name || b.action === `${name}:${value}`));
  return k ? k.keys : "";
}

export function initSpaceMenu(view, cx) {
  view.kind = "space-menu";
  view.at = 0;
  view.git = null;
  view.handle = cx.focus_handle();
  view.handle.focus();
  const s = spaces().find((x) => x.id === props()?.spaceMenu?.id);
  const folder = s && place(s);
  if (folder) cx.spawn(async (cx) => { view.git = await checkout(folder, s.machine).catch(() => null); cx.notify(); });
}

function choose(view, i) {
  const it = items(view)[i];
  if (!it || it[4]?.disabled) return;
  closeOverlay(props()?.overlay);
  if (it[1] === "reveal") reveal(it[2].folder);
  else if (it[1] === "worktree") openOverlay({ mod: "worktree", kind: "dialog", ...(it[2].action === "open" ? { width: 560, height: 480 } : { width: 440, height: 260 }), props: it[2] });
  else run(it[1], it[2]);
}

export function renderSpaceMenu(view) {
  const t = theme();
  const list = items(view);
  const step = (d) => {
    for (let k = 1; k <= list.length; k++) {
      const i = (view.at + d * k + list.length * 2) % list.length;
      if (!list[i][4]?.disabled) { view.at = i; return; }
    }
  };
  return v_flex().id("space-menu").track_focus(view.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
    .on_key_down((e, cx) => {
      if (e.key === "down") step(1);
      else if (e.key === "up") step(-1);
      else if (e.key === "enter") choose(view, view.at);
      else if (e.key === "escape") closeOverlay(props().overlay);
      else return;
      cx.notify();
    })
    .children(list.map((it, i) => {
      const off = Boolean(it[4]?.disabled);
      return v_flex()
        .when(i > 0 && it[1] === "space.close", (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
        .child(h_flex().id(`smi-${i}`).h(31).px(8).gap(9).rounded(7).items_center().justify_between()
          .text_color(off ? t.dim : t.foreground)
          .when(Boolean(it[4]?.hint), (el) => el.tooltip(it[4].hint))
          .when(!off && i === view.at, (el) => el.bg(t.selected))
          .when(!off, (el) => el.hover((s) => s.bg(t.hover)).on_click((_e, cx) => choose(view, i)))
          .child(svg(`mods/workspace-chrome/${it[3]}.svg`).size(14).flex_none().text_color(off ? t.dim : t.muted))
          .child(div().flex_1().child(it[4]?.label ?? it[0]))
          .child(div().text_size(11).text_color(t.dim).child(it[1] === "reveal" ? "" : shortcut(it[1], it[2]))));
    }));
}
