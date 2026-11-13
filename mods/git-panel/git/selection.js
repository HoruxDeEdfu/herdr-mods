// Several branches selected at once in Branches (⌘-click toggles, ⇧-click
// takes a range). Pure: keys in, keys out. Only local branches can join a
// multi-selection; any other click is a plain single selection.

const isLocal = (key) => typeof key === "string" && key.startsWith("refs/heads/");

/**
 * `state`: { selected: string[], anchor: string|null }; `key`: the clicked row;
 * `order`: every row key as listed; `mods`: { platform, control, shift } of the press.
 * Returns the new { selected, anchor, multi } (multi: more than one selected).
 */
export function clickSelect(state, key, order, mods = {}) {
  const prev = (state?.selected ?? []).filter(isLocal);
  const toggle = Boolean(mods.platform || mods.control), range = Boolean(mods.shift);
  if (!isLocal(key) || (!toggle && !range)) return { selected: [key], anchor: key, multi: false };
  if (range && isLocal(state?.anchor) && order.includes(state.anchor)) {
    const a = order.indexOf(state.anchor), b = order.indexOf(key);
    const span = order.slice(Math.min(a, b), Math.max(a, b) + 1).filter(isLocal);
    const selected = toggle ? [...new Set([...prev, ...span])] : span;
    return { selected, anchor: state.anchor, multi: selected.length > 1 };
  }
  const selected = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
  return { selected, anchor: key, multi: selected.length > 1 };
}

/** Drops keys that no longer exist (after a refresh); keeps the order. */
export function keepExisting(selected, existing) {
  const set = new Set(existing);
  return (selected ?? []).filter((k) => set.has(k));
}
