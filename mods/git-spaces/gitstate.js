// git-spaces: what a worktree's `git status` and in-progress markers say, as
// plain data. Pure (no Herdr imports) so it can be tested with Node.

/** `status --porcelain -z` → { changes, conflicts }: files with changes (a rename counts once), and unmerged ones. */
export function readStatus(out) {
  const parts = out.split("\0");
  let changes = 0, conflicts = 0;
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    changes++;
    const xy = e.slice(0, 2);
    if (xy.includes("U") || xy === "AA" || xy === "DD") conflicts++;
    if (e[0] === "R" || e[0] === "C") i++; // the original path follows
  }
  return { changes, conflicts };
}
/** Kept for callers that only want the count. */
export const countChanges = (out) => readStatus(out).changes;

/** The markers Git leaves while an operation is stopped, in the order the Git panel checks them. */
export const MARKERS = [
  ["merge", "MERGE_HEAD"], ["cherry-pick", "CHERRY_PICK_HEAD"], ["revert", "REVERT_HEAD"],
  ["rebase", "rebase-merge/head-name"], ["rebase", "rebase-apply/head-name"], ["bisect", "BISECT_LOG"],
];
/** `rev-parse --git-path` arguments for every marker. */
export const markerArgs = () => ["rev-parse", "--path-format=absolute", ...MARKERS.flatMap(([, p]) => ["--git-path", p])];
/** Which operation is in progress, given whether each marker path exists. null: none. */
export function opFrom(present) {
  const i = present.findIndex(Boolean);
  return i < 0 ? null : MARKERS[i][0];
}

/**
 * What the row says about it: null, or { text, tip } — "⚠ merge·2" for a merge
 * stopped on 2 conflicted files, "⚠ 3" for conflicts with nothing in progress
 * (a stash pop, say).
 */
export function opBadge(op, conflicts) {
  if (!op && !conflicts) return null;
  const names = { merge: "Merge", rebase: "Rebase", "cherry-pick": "Cherry-pick", revert: "Revert", bisect: "Bisect" };
  const text = `⚠ ${op ?? ""}${op && conflicts ? "·" : ""}${conflicts || ""}`.trim();
  const tip = [op ? `${names[op] ?? op} en curso` : null, conflicts ? `${conflicts} archivo(s) en conflicto` : null].filter(Boolean).join(" · ") + ". Ábrelo en el panel Git para continuar o abortar.";
  return { text, tip };
}
