// Unified diff text → rows the panel draws (one per line, numbered once).
// Pure. Long diffs are cut at MAX_ROWS so a huge file never stalls the panel.
export const MAX_ROWS = 6000;

const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

export function diffRows(text) {
  const rows = [];
  let old = 0, next = 0, inHunk = false, adds = 0, dels = 0, binary = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) { binary = true; continue; }
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (m) { old = +m[1]; next = +m[2]; inHunk = true; rows.push({ kind: "@", text: line }); continue; }
    if (!inHunk) continue; // headers: diff --git, index, ---, +++
    const k = line[0];
    if (k === "-") { dels++; rows.push({ kind: "-", a: old++, text: untab(line.slice(1)) }); }
    else if (k === "+") { adds++; rows.push({ kind: "+", b: next++, text: untab(line.slice(1)) }); }
    else if (k === " ") rows.push({ kind: " ", a: old++, b: next++, text: untab(line.slice(1)) });
    else if (k === "\\") rows.push({ kind: "\\", text: line });
    if (rows.length >= MAX_ROWS) return { rows, adds, dels, binary, cut: true };
  }
  return { rows, adds, dels, binary, cut: false };
}

/** Git's conflict markers still in a file's text. */
export function hasConflictMarkers(text) {
  return /^<{7}( |$)/m.test(text ?? "") && /^>{7}( |$)/m.test(text ?? "");
}

/**
 * A conflicted file as rows: "@" marker lines, "o" ours (HEAD side), "t"
 * theirs (incoming side), "b" base (diff3 style), " " outside conflicts.
 * `b` is the line number in the file.
 */
export function conflictRows(text) {
  const rows = [];
  let side = null, n = 0;
  for (const line of (text ?? "").split("\n")) {
    n++;
    if (/^<{7}( |$)/.test(line)) { side = "o"; rows.push({ kind: "@", b: n, text: line }); continue; }
    if (side && /^\|{7}( |$)/.test(line)) { side = "b"; rows.push({ kind: "@", b: n, text: line }); continue; }
    if (side && /^={7}$/.test(line)) { side = "t"; rows.push({ kind: "@", b: n, text: line }); continue; }
    if (side && /^>{7}( |$)/.test(line)) { side = null; rows.push({ kind: "@", b: n, text: line }); continue; }
    rows.push({ kind: side ?? " ", b: n, text: untab(line) });
    if (rows.length >= MAX_ROWS) return { rows, cut: true };
  }
  if (rows.length && rows[rows.length - 1].text === "" && rows[rows.length - 1].kind === " ") rows.pop();
  return { rows, cut: false };
}
