// Line diff (Myers O(ND)), bounded so a huge rewrite never freezes the panel.
// Returns rows { kind: " " | "+" | "-" | "@", a?, b?, text } where a is the
// line number in `before` and b in `after`, both from 1.
const MAX_LINES = 20000, MAX_EDITS = 4000, CONTEXT = 3;

export function lineDiff(before, after) {
  const a = before.split("\n"), b = after.split("\n");
  if (a.length > MAX_LINES || b.length > MAX_LINES) return null;
  // Trim the common head and tail first: most agent edits are local.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const A = a.slice(head, a.length - tail), B = b.slice(head, b.length - tail);
  const ops = myers(A, B);
  if (!ops) return null;
  const all = [];
  for (let i = 0; i < head; i++) all.push({ kind: " ", a: i + 1, b: i + 1, text: a[i] });
  let ai = head, bi = head;
  for (const op of ops) {
    if (op === " ") { all.push({ kind: " ", a: ai + 1, b: bi + 1, text: a[ai] }); ai++; bi++; }
    else if (op === "-") { all.push({ kind: "-", a: ai + 1, text: a[ai] }); ai++; }
    else { all.push({ kind: "+", b: bi + 1, text: b[bi] }); bi++; }
  }
  for (let i = 0; i < tail; i++) { all.push({ kind: " ", a: ai + 1, b: bi + 1, text: a[ai] }); ai++; bi++; }
  return hunks(all);
}

function myers(a, b) {
  const n = a.length, m = b.length, max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1, v = new Int32Array(2 * max + 3), trace = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m, offset);
    }
  }
  return null;
}

function backtrack(trace, n, m, offset) {
  const ops = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d], k = x - y;
    const prevK = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = v[offset + prevK], prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push(" "); x--; y--; }
    if (d > 0) ops.push(x === prevX ? "+" : "-");
    x = prevX; y = prevY;
  }
  return ops.reverse();
}

// Keeps changed lines with a few lines of context, separated by "@" rows.
function hunks(rows) {
  const keep = new Uint8Array(rows.length);
  rows.forEach((r, i) => { if (r.kind !== " ") for (let j = Math.max(0, i - CONTEXT); j <= Math.min(rows.length - 1, i + CONTEXT); j++) keep[j] = 1; });
  const out = [];
  let gap = false;
  rows.forEach((r, i) => {
    if (!keep[i]) { gap = true; return; }
    if (gap || out.length === 0) out.push({ kind: "@", text: `@@ line ${r.a ?? r.b}` });
    gap = false;
    out.push(r);
  });
  return out;
}
