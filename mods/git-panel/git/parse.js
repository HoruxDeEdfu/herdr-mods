// Parsers for Git's machine-readable output. Pure: no Herdr imports, so they
// run under Node in the tests (~/herdr-git-panel-dev/test).

const US = "\x1f", RS = "\x1e";

// `git status --porcelain=v2 --branch -z --untracked-files=all`
export function parseStatus(out) {
  const st = { oid: null, head: null, detached: false, upstream: null, ahead: null, behind: null, files: [] };
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith("# ")) {
      const [, key, ...rest] = line.split(" "), value = rest.join(" ");
      if (key === "branch.oid") st.oid = value === "(initial)" ? null : value;
      else if (key === "branch.head") { st.detached = value === "(detached)"; st.head = st.detached ? null : value; }
      else if (key === "branch.upstream") st.upstream = value;
      else if (key === "branch.ab") { const m = /^\+(\d+) -(\d+)$/.exec(value); if (m) { st.ahead = +m[1]; st.behind = +m[2]; } }
      continue;
    }
    const kind = line[0];
    if (kind === "1") {
      const f = split(line, 8);
      st.files.push({ kind: "changed", x: f[1][0], y: f[1][1], path: f[8] });
    } else if (kind === "2") {
      const f = split(line, 9);
      st.files.push({ kind: "renamed", x: f[1][0], y: f[1][1], path: f[9], orig: parts[++i] });
    } else if (kind === "u") {
      const f = split(line, 10);
      st.files.push({ kind: "unmerged", x: f[1][0], y: f[1][1], path: f[10] });
    } else if (kind === "?") st.files.push({ kind: "untracked", x: "?", y: "?", path: line.slice(2) });
  }
  return st;
}

// Splits off `n` space-separated fields; the rest (a path with spaces) is field n.
function split(line, n) {
  const out = [];
  let at = 0;
  for (let k = 0; k < n; k++) {
    const sp = line.indexOf(" ", at);
    out.push(line.slice(at, sp));
    at = sp + 1;
  }
  out.push(line.slice(at));
  return out;
}

export function summarize(files) {
  const s = { staged: 0, unstaged: 0, untracked: 0, conflicts: 0, total: files.length };
  for (const f of files) {
    if (f.kind === "unmerged") s.conflicts++;
    else if (f.kind === "untracked") s.untracked++;
    else { if (f.x !== ".") s.staged++; if (f.y !== ".") s.unstaged++; }
  }
  s.trackedDirty = s.staged + s.unstaged + s.conflicts;
  return s;
}

export const REF_FORMAT = ["%(refname)", "%(objectname)", "%(objectname:short)", "%(upstream:short)", "%(upstream:track,nobracket)",
  "%(worktreepath)", "%(HEAD)", "%(committerdate:unix)", "%(subject)", "%(symref)", "%(*objectname)"].join("%1f") + "%1e";

// `git for-each-ref --format=REF_FORMAT refs/heads refs/remotes refs/tags`
export function parseRefs(out) {
  const refs = [];
  for (const rec of out.split(RS)) {
    const r = rec.replace(/^\n/, "");
    if (!r) continue;
    const [ref, oid, short, upstream, track, worktree, head, date, subject, symref, peeled] = r.split(US);
    let type, name, remote = null;
    if (ref.startsWith("refs/heads/")) { type = "local"; name = ref.slice(11); }
    else if (ref.startsWith("refs/remotes/")) { type = "remote"; name = ref.slice(13); remote = name.split("/")[0]; }
    else if (ref.startsWith("refs/tags/")) { type = "tag"; name = ref.slice(10); }
    else continue;
    if (symref) continue; // origin/HEAD
    const ahead = /ahead (\d+)/.exec(track ?? ""), behind = /behind (\d+)/.exec(track ?? "");
    refs.push({
      ref, type, name, remote, oid: peeled || oid, short, upstream: upstream || null,
      gone: (track ?? "").includes("gone"), ahead: ahead ? +ahead[1] : 0, behind: behind ? +behind[1] : 0,
      worktree: worktree || null, current: head === "*", date: +date || 0, subject: subject ?? "",
    });
  }
  return refs;
}

// `git worktree list --porcelain -z`
export function parseWorktrees(out) {
  const list = [];
  let cur = null;
  for (const field of out.split("\0")) {
    if (!field) { if (cur) list.push(cur); cur = null; continue; }
    if (!cur) cur = { path: null, head: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
    const sp = field.indexOf(" "), key = sp < 0 ? field : field.slice(0, sp), value = sp < 0 ? "" : field.slice(sp + 1);
    if (key === "worktree") cur.path = value;
    else if (key === "HEAD") cur.head = value;
    else if (key === "branch") cur.branch = value.replace(/^refs\/heads\//, "");
    else if (key === "detached") cur.detached = true;
    else if (key === "bare") cur.bare = true;
    else if (key === "locked") cur.locked = value || true;
    else if (key === "prunable") cur.prunable = value || true;
  }
  if (cur) list.push(cur);
  return list;
}

export const LOG_FORMAT = "%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s";

// `git log -z --format=LOG_FORMAT`
export function parseLog(out) {
  const commits = [];
  for (const rec of out.split("\0")) {
    if (!rec) continue;
    const [hash, parents, author, email, at, decor, subject] = rec.split(US);
    commits.push({ hash, short: hash.slice(0, 7), parents: parents ? parents.split(" ") : [], author, email, at: +at, refs: parseDecor(decor ?? ""), subject: subject ?? "" });
  }
  return commits;
}

export function parseDecor(d) {
  if (!d.trim()) return [];
  return d.split(", ").map((s) => {
    if (s.startsWith("HEAD -> ")) return { kind: "head", name: s.slice(8) };
    if (s === "HEAD") return { kind: "detached", name: "HEAD" };
    if (s.startsWith("tag: ")) return { kind: "tag", name: s.slice(5) };
    return { kind: s.includes("/") ? "remote-or-local" : "local", name: s };
  });
}

// `git diff --name-status -z` / `git show --name-status -z --format=`
export function parseNameStatus(out) {
  const files = [], f = out.split("\0");
  for (let i = 0; i < f.length; i++) {
    const code = f[i].replace(/^\n+/, "");
    if (!code) continue;
    if (code[0] === "R" || code[0] === "C") files.push({ status: code[0], orig: f[++i], path: f[++i] });
    else files.push({ status: code[0], path: f[++i] });
  }
  return files;
}

// `git merge-tree --write-tree --name-only --messages A B` (core.quotePath=false)
// Exit 0: clean, 1: conflicts. Output: tree, conflicted names, blank, messages.
export function parseMergeTree(out) {
  const lines = out.split("\n");
  const tree = lines[0] ?? null, conflicts = [];
  let i = 1;
  for (; i < lines.length && lines[i] !== ""; i++) conflicts.push(lines[i]);
  const messages = lines.slice(i + 1).join("\n").trim();
  return { tree, conflicts, messages };
}

// `git rev-list --left-right --count A...B` → "left\tright"
export function parseLeftRight(out) {
  const [l, r] = out.trim().split(/\s+/).map(Number);
  return { left: l || 0, right: r || 0 };
}
