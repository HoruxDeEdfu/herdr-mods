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

// ---------- hunks: stage / unstage part of a file ----------
const HUNK = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

/**
 * A unified diff of ONE file split into its header (diff --git … +++ …) and
 * hunks: [{ header, lines, adds, dels }]. `lines` includes the @@ line and
 * any "\ No newline at end of file" that belongs to it.
 */
export function splitHunks(text) {
  const header = [], hunks = [];
  let cur = null;
  const lines = (text ?? "").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    if (HUNK.test(line)) { cur = { header: line, lines: [line], adds: 0, dels: 0 }; hunks.push(cur); continue; }
    if (!cur) { header.push(line); continue; }
    if (line.startsWith("diff --git ")) break; // a second file: not ours
    cur.lines.push(line);
    if (line[0] === "+") cur.adds++; else if (line[0] === "-") cur.dels++;
  }
  return { header, hunks };
}

/** Which hunks can be staged on their own: text diffs of a file that exists on both sides. */
export function canSplit(text) {
  const { header, hunks } = splitHunks(text);
  if (!hunks.length) return false;
  if (header.some((l) => /^(Binary files|GIT binary patch|new file mode|deleted file mode|rename from|similarity index)/.test(l))) return false;
  return header.some((l) => l.startsWith("--- ")) && header.some((l) => l.startsWith("+++ "));
}

/** A patch with the file's header and only hunk `i`, for `git apply --cached [--reverse]`. */
export function hunkPatch(text, i) {
  const { header, hunks } = splitHunks(text);
  const h = hunks[i];
  if (!h) throw new Error(`No existe el fragmento ${i + 1}.`);
  return [...header, ...h.lines].join("\n") + "\n";
}

/** Row index of each hunk's @@ line in diffRows(text).rows (same order). */
export function hunkRowIndexes(rows) {
  const out = [];
  rows.forEach((r, i) => { if (r.kind === "@" && r.b === undefined) out.push(i); });
  return out;
}
