// git-tabs: the badge next to the "Git" button, from the Git panel's shared
// summary ("git-panel.summary"). Pure, so Node can test it.

const OPS = { merge: "Merge", rebase: "Rebase", "cherry-pick": "Cherry-pick", revert: "Revert", bisect: "Bisect" };

/** null (nothing to say), or { text, tone: "blocked" | "changes", tip }. */
export function gitBadge(sum) {
  if (!sum) return null;
  const where = sum.head ? ` en ${sum.head}` : "";
  if (sum.op || sum.conflicts) {
    const parts = [sum.op ? `${OPS[sum.op] ?? sum.op} en curso` : null, sum.conflicts ? `${sum.conflicts} archivo(s) en conflicto` : null].filter(Boolean);
    return { text: sum.conflicts ? `⚠${sum.conflicts}` : "⚠", tone: "blocked", tip: `${parts.join(" · ")}${where}` };
  }
  if (sum.total > 0) return { text: sum.total > 999 ? "999+" : String(sum.total), tone: "changes", tip: `${sum.total} archivo(s) con cambios sin commit${where}` };
  return null;
}
