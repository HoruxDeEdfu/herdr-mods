// The merge model, shared by both entry points:
//   A. HEAD is the target: pick a source, preview, merge.
//   B. From another branch's menu: "Integrar mi rama en T" checks out T first
//      (only after the person confirms), then continues as A with the old HEAD
//      as the source. "Fusionar T en la actual" is A with T as the source.
// Pure: it only asks Git (through the runner) and returns plain data.
import * as Q from "./queries.js";

const under = (root, path) => path === root || path.startsWith(root.endsWith("/") ? root : root + "/");

/** Editor buffers with unsaved changes inside this worktree (absolute paths).
 *  `roots`: the worktree as Git reports it plus any spelling the editor may use
 *  (a symlinked folder such as /tmp → /private/tmp). */
export function unsavedIn(roots, drafts) {
  const list = (Array.isArray(roots) ? roots : [roots]).filter(Boolean);
  return Object.keys(drafts ?? {}).filter((p) => !drafts[p]?.stale && list.some((r) => under(r, p))).sort();
}
export function staleIn(roots, drafts) {
  const list = (Array.isArray(roots) ? roots : [roots]).filter(Boolean);
  return Object.keys(drafts ?? {}).filter((p) => drafts[p]?.stale && list.some((r) => under(r, p))).sort();
}
/**
 * Which editor drafts hold work that exists nowhere else.
 *  - text equal to the file on disk: nothing to lose → dropped;
 *  - text Git already stores (another branch's version, left open in the editor
 *    after a checkout): nothing to lose either → kept with `stale: true`, which
 *    warns instead of blocking (saving it would write that old version back);
 *  - anything else: real unsaved work → blocks.
 * `known(path, text)` answers whether Git has a blob with exactly that text.
 */
export async function realDrafts(drafts, read, known) {
  const out = {};
  for (const [path, d] of Object.entries(drafts ?? {})) {
    let disk;
    try { disk = await read(path); } catch { disk = undefined; }
    if (typeof d?.text === "string" && d.text === disk) continue;
    let inGit = false;
    if (typeof d?.text === "string" && known) { try { inGit = await known(path, d.text); } catch { inGit = false; } }
    out[path] = inGit ? { ...d, stale: true } : d;
  }
  return out;
}

/** Git's blob id for a text: sha1("blob <bytes>\0" + bytes). */
export function blobId(text, createHash, toBytes) {
  const bytes = toBytes(text);
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

const rootsOf = (repo) => [repo.root, ...(repo.aliases ?? [])];
const rel = (repo, p) => { const r = rootsOf(repo).find((x) => under(x, p)); return r ? p.slice(r.length + 1) : p; };

const opName = { merge: "un merge", rebase: "un rebase", "cherry-pick": "un cherry-pick", revert: "un revert", bisect: "un bisect" };

/**
 * Can we switch this worktree to `target`? Returns { blocks, warnings, dirty, otherWorktree }.
 * Nothing here changes the repository.
 */
export function checkoutCheck({ repo, status, refs, ops, drafts, target }) {
  const blocks = [], warnings = [];
  const branch = refs.find((r) => r.type === "local" && r.name === target);
  if (!branch) blocks.push({ id: "missing", text: `La rama ${target} ya no existe localmente.` });
  if (ops.length) blocks.push({ id: "in-progress", text: `Hay ${opName[ops[0]] ?? ops[0]} en curso en este worktree. Termínalo o abórtalo antes de cambiar de rama.` });
  if (status.summary.conflicts) blocks.push({ id: "conflicts", text: `Hay ${status.summary.conflicts} archivo(s) en conflicto.` });
  let otherWorktree = null;
  if (branch?.worktree && branch.worktree !== repo.root) {
    otherWorktree = branch.worktree;
    blocks.push({ id: "worktree", text: `${target} está abierta en otro worktree (${branch.worktree}). Git no permite tenerla en dos sitios a la vez.` });
  }
  const unsaved = unsavedIn(rootsOf(repo), drafts);
  if (unsaved.length) blocks.push({ id: "unsaved", text: `Hay ${unsaved.length} archivo(s) sin guardar en el editor: ${unsaved.map((p) => rel(repo, p)).slice(0, 4).join(", ")}. Guárdalos o descártalos primero.` });
  const stale = staleIn(rootsOf(repo), drafts);
  if (stale.length) warnings.push({ id: "stale-editor", text: `El editor Files tiene abierta una versión de ${stale.map((p) => rel(repo, p)).slice(0, 3).join(", ")} que no coincide con el disco, pero ya está guardada en Git, así que no se pierde nada. Recárgala en Files después para no guardarla encima.` });
  const dirty = status.summary.staged + status.summary.unstaged;
  if (dirty) warnings.push({ id: "dirty", text: `Tienes ${dirty} archivo(s) con cambios sin commit. Git los conservará al cambiar de rama y se detendrá si alguno chocara. No se hará stash.` });
  if (status.summary.untracked) warnings.push({ id: "untracked", text: `${status.summary.untracked} archivo(s) sin seguimiento se quedan como están.` });
  return { blocks, warnings, dirty, otherWorktree };
}

/**
 * Everything the preview shows before "Fusionar S en D". `target` must be the
 * branch checked out here. Never claims "no conflicts" unless the simulation ran.
 */
export async function preview(git, { repo, status, refs, ops, drafts, source, target }) {
  const blocks = [], warnings = [];
  const root = repo.root;
  if (status.detached || status.head !== target) blocks.push({ id: "not-head", text: `La rama activa es ${status.head ?? "HEAD desacoplado"}, no ${target}.` });
  if (ops.length) blocks.push({ id: "in-progress", text: `Hay ${opName[ops[0]] ?? ops[0]} en curso. Termínalo o abórtalo primero.` });
  if (status.summary.conflicts) blocks.push({ id: "conflicts", text: `Hay ${status.summary.conflicts} archivo(s) en conflicto sin resolver.` });
  if (source === target) blocks.push({ id: "same", text: "El origen y el destino son la misma rama." });

  const [sourceSha, targetSha] = await Promise.all([Q.revParse(git, root, source), Q.revParse(git, root, "HEAD")]);
  if (!sourceSha) blocks.push({ id: "missing", text: `No se encuentra ${source}.` });
  if (!targetSha) blocks.push({ id: "empty", text: `${target} todavía no tiene commits.` });

  const out = { source, target, sourceSha, targetSha, base: null, upToDate: false, ff: false, incoming: [], incomingCount: 0, targetOnly: 0,
    files: [], sim: null, sync: [], blocks, warnings, snapshot: null };
  if (!sourceSha || !targetSha) { out.snapshot = snapshot(out, status, ops); return out; }

  out.base = await Q.mergeBase(git, root, targetSha, sourceSha);
  if (!out.base) blocks.push({ id: "unrelated", text: "Las ramas no comparten historia. Este panel no fusiona historias no relacionadas." });
  const lr = await Q.leftRight(git, root, targetSha, sourceSha);
  out.targetOnly = lr.left; out.incomingCount = lr.right;
  out.upToDate = lr.right === 0;
  out.ff = lr.left === 0 && lr.right > 0;
  if (out.upToDate) blocks.push({ id: "up-to-date", text: `${target} ya contiene todos los commits de ${source}. No hay nada que integrar.` });

  if (out.base && !out.upToDate) {
    out.incoming = await Q.between(git, root, targetSha, sourceSha, 50);
    out.files = await Q.changedFiles(git, root, out.base, sourceSha);
    if (!out.ff) {
      out.sim = await Q.simulateMerge(git, root, targetSha, sourceSha);
      if (!out.sim.ok) warnings.push({ id: "sim-failed", text: `No se pudo simular el merge (${out.sim.error || "error desconocido"}). Pueden aparecer conflictos.` });
      else if (!out.sim.clean) warnings.push({ id: "conflicts-expected", text: `La simulación encontró conflictos en ${out.sim.conflicts.length} archivo(s). El merge se detendrá para que los resuelvas.` });
    }
  }

  // Local changes the merge would touch: Git refuses, so say it before.
  const touched = new Set(out.files.map((f) => f.path));
  const dirtyTracked = status.files.filter((f) => f.kind !== "untracked" && f.kind !== "unmerged").map((f) => f.path);
  const overlap = dirtyTracked.filter((p) => touched.has(p));
  const untrackedHit = status.files.filter((f) => f.kind === "untracked" && touched.has(f.path)).map((f) => f.path);
  if (overlap.length) blocks.push({ id: "dirty-overlap", text: `Tienes cambios sin commit en archivos que el merge modifica: ${overlap.slice(0, 5).join(", ")}${overlap.length > 5 ? "…" : ""}. Haz commit o guárdalos tú mismo primero.` });
  else if (status.summary.staged) blocks.push({ id: "staged", text: `Hay ${status.summary.staged} archivo(s) en stage. Haz commit antes de fusionar para no mezclarlos con el merge.` });
  else if (dirtyTracked.length) warnings.push({ id: "dirty", text: `Hay ${dirtyTracked.length} archivo(s) modificados que el merge no toca. Git los conservará.` });
  if (untrackedHit.length) blocks.push({ id: "untracked-overlap", text: `Archivos sin seguimiento que el merge crearía: ${untrackedHit.slice(0, 5).join(", ")}.` });
  const unsaved = unsavedIn(rootsOf(repo), drafts);
  if (unsaved.length) blocks.push({ id: "unsaved", text: `Hay ${unsaved.length} archivo(s) sin guardar en el editor. Guárdalos o descártalos primero.` });
  const stale = staleIn(rootsOf(repo), drafts);
  if (stale.length) warnings.push({ id: "stale-editor", text: `El editor Files tiene abierta una versión de ${stale.map((p) => rel(repo, p)).slice(0, 3).join(", ")} que no coincide con el disco, pero ya está guardada en Git, así que no se pierde nada. Recárgala en Files después para no guardarla encima.` });

  // Sync with upstreams: refs were read before the preview; Fetch refreshes them.
  for (const name of [target, source]) {
    const r = refs.find((x) => x.type === "local" && x.name === name);
    if (!r) continue;
    if (!r.upstream) out.sync.push({ branch: name, text: "sin upstream" });
    else if (r.gone) out.sync.push({ branch: name, text: `su upstream ${r.upstream} ya no existe`, warn: true });
    else out.sync.push({ branch: name, upstream: r.upstream, ahead: r.ahead, behind: r.behind, text: r.ahead || r.behind ? `↑${r.ahead} ↓${r.behind} respecto a ${r.upstream}` : `al día con ${r.upstream}` });
    if (name === target && r.behind && source !== r.upstream) warnings.push({ id: "target-behind", text: `${target} está ${r.behind} commit(s) por detrás de ${r.upstream}. Considera actualizarla antes.` });
  }
  out.snapshot = snapshot(out, status, ops);
  return out;
}

function snapshot(p, status, ops) {
  const files = status.files.map((f) => `${f.x}${f.y}${f.path}`).sort().join("|");
  return JSON.stringify([p.sourceSha, p.targetSha, status.head, ops, files]);
}

/** Has anything moved since the preview? Returns the fresh preview too. */
export async function revalidate(git, ctx, old) {
  const fresh = await preview(git, ctx);
  return { same: fresh.snapshot === old.snapshot && fresh.blocks.length === 0, fresh };
}

/**
 * Before "git push": what blocks it and what to say. Never offers --force.
 * Returns { blocks, warnings, remote, branch, setUpstream, ahead }.
 */
export function pushCheck({ status, refs, ops, remotes, branch: which }) {
  const blocks = [], warnings = [];
  const branch = which ?? status.head;
  const current = branch === status.head && !status.detached;
  if (!which && (status.detached || !branch)) blocks.push({ id: "detached", text: "HEAD está desacoplado: no hay rama que publicar." });
  if (which && !refs.some((r) => r.type === "local" && r.name === which)) blocks.push({ id: "missing", text: `La rama ${which} ya no existe.` });
  if (ops.length && current) blocks.push({ id: "in-progress", text: `Hay ${opName[ops[0]] ?? ops[0]} en curso. Termínalo antes de publicar.` });
  if (!remotes.length) blocks.push({ id: "no-remote", text: "Este repositorio no tiene remotos." });
  const ref = refs.find((r) => r.type === "local" && r.name === branch);
  const upstream = ref?.upstream && !ref.gone ? ref.upstream : null;
  const remote = upstream ? upstream.split("/")[0] : remotes.includes("origin") ? "origin" : remotes[0] ?? null;
  const setUpstream = !upstream;
  const ahead = upstream ? ref.ahead : null;
  if (upstream && ref.behind > 0) blocks.push({ id: "behind", text: `${branch} está ${ref.behind} commit(s) por detrás de ${upstream}. El remoto rechazaría el push: integra primero esos cambios (Pull). Este panel nunca hace force push.` });
  if (upstream && ref.ahead === 0 && !ref.behind) blocks.push({ id: "nothing", text: `${branch} ya está al día con ${upstream}. No hay nada que publicar.` });
  if (setUpstream && remote) warnings.push({ id: "publish", text: `${branch} no tiene upstream: se publicará en ${remote}/${branch} y quedará enlazada a ella.` });
  if (ref?.gone) warnings.push({ id: "gone", text: `El upstream anterior (${ref.upstream}) ya no existe en el remoto.` });
  if (current && status.summary.trackedDirty) warnings.push({ id: "dirty", text: "Tienes cambios sin commit: no se publican, solo los commits." });
  return { blocks, warnings, remote, branch, setUpstream, ahead, upstream };
}

/** Pull = fetch, then integrate the upstream through the same merge preview. */
export function pullCheck({ status, refs }) {
  const blocks = [];
  const ref = refs.find((r) => r.type === "local" && r.name === status.head);
  if (status.detached || !status.head) blocks.push({ id: "detached", text: "HEAD está desacoplado: no hay rama que actualizar." });
  else if (!ref?.upstream) blocks.push({ id: "no-upstream", text: `${status.head} no tiene upstream. Publícala con Push o elige una rama remota con Merge…` });
  else if (ref.gone) blocks.push({ id: "gone", text: `El upstream ${ref.upstream} ya no existe en el remoto.` });
  return { blocks, upstream: ref?.upstream ?? null, remote: ref?.upstream?.split("/")[0] ?? null };
}

/**
 * Before cherry-picking or reverting one commit onto HEAD. Never claims "no
 * conflicts" unless the simulation ran. Returns { blocks, warnings, sim, files, mainline, merge }.
 */
export async function pickPreview(git, { repo, status, ops, drafts, commit, revert }) {
  const blocks = [], warnings = [];
  const root = repo.root;
  if (status.detached && !revert) warnings.push({ id: "detached", text: "HEAD está desacoplado: el commit nuevo no quedará en ninguna rama." });
  if (ops.length) blocks.push({ id: "in-progress", text: `Hay ${opName[ops[0]] ?? ops[0]} en curso. Termínalo o abórtalo primero.` });
  if (status.summary.conflicts) blocks.push({ id: "conflicts", text: `Hay ${status.summary.conflicts} archivo(s) en conflicto.` });
  if (status.summary.staged) blocks.push({ id: "staged", text: `Hay ${status.summary.staged} archivo(s) en stage. Haz commit antes para no mezclarlos.` });
  const merge = commit.parents.length > 1;
  const mainline = merge ? 1 : null;
  if (merge) warnings.push({ id: "merge-commit", text: `Es un commit de merge: se ${revert ? "deshacen" : "aplican"} los cambios que trajo respecto a su primer padre (${commit.parents[0].slice(0, 7)}), es decir, -m 1.` });
  if (!commit.parents.length) blocks.push({ id: "root", text: "Es el primer commit del repositorio: no hay padre con el que comparar." });
  const out = { blocks, warnings, sim: null, files: [], mainline, merge };
  if (!commit.parents.length) return out;
  const parent = commit.parents[0];
  const inHead = await Q.isAncestor(git, root, commit.hash, "HEAD");
  if (!revert && inHead) blocks.push({ id: "already", text: "Ese commit ya está incluido en la rama actual." });
  if (revert && !inHead) blocks.push({ id: "not-in-head", text: "Ese commit no está en la rama actual: no hay nada que revertir aquí." });
  out.files = await Q.changedFiles(git, root, parent, commit.hash);
  if (!blocks.length) {
    out.sim = await Q.simulatePick(git, root, commit.hash, parent, revert);
    if (!out.sim.ok) warnings.push({ id: "sim-failed", text: `No se pudo simular (${out.sim.error || "error"}). Pueden aparecer conflictos.` });
    else if (!out.sim.clean) warnings.push({ id: "conflicts-expected", text: `La simulación encontró conflictos en ${out.sim.conflicts.length} archivo(s). Git se detendrá para que los resuelvas.` });
    else {
      const headTree = (await git.read(root, ["rev-parse", "HEAD^{tree}"])).stdout.trim();
      if (out.sim.tree === headTree) blocks.push({ id: "empty", text: revert ? "Esos cambios ya no están en la rama: el revert no cambiaría nada." : "Esos cambios ya están en la rama (quizá por un cherry-pick anterior): no cambiaría nada." });
    }
  }
  const touched = new Set(out.files.map((f) => f.path));
  const overlap = status.files.filter((f) => f.kind !== "untracked" && touched.has(f.path)).map((f) => f.path);
  if (overlap.length) blocks.push({ id: "dirty-overlap", text: `Tienes cambios sin commit en archivos que toca: ${overlap.slice(0, 5).join(", ")}. Haz commit o guárdalos tú mismo primero.` });
  const unsaved = unsavedIn(rootsOf(repo), drafts).filter((p) => touched.has(rel(repo, p)));
  if (unsaved.length) blocks.push({ id: "unsaved", text: `Hay archivo(s) sin guardar en el editor que esto modificaría: ${unsaved.map((p) => rel(repo, p)).slice(0, 3).join(", ")}.` });
  out.snapshot = JSON.stringify([status.oid, status.files.map((f) => f.x + f.y + f.path).sort(), ops]);
  return out;
}

/** Where Herdr puts worktrees: ~/.herdr/worktrees/<repo>/<branch slug> (same as its worktree dialog). */
export function worktreePath(home, commonDir, branch) {
  const main = commonDir.replace(/[\\/]\.git[\\/]?$/, "");
  const name = main.split(/[\\/]/).filter(Boolean).pop();
  const slug = branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${home}/.herdr/worktrees/${name}/${slug}`;
}

/** Before removing a worktree. Git itself refuses with changes; we say why first. */
export function worktreeRemoveCheck({ repo, worktrees, target }) {
  const blocks = [], warnings = [];
  const wt = worktrees.find((w) => w.path === target);
  if (!wt) blocks.push({ id: "missing", text: "Ese worktree ya no existe." });
  else {
    if (wt === worktrees[0]) blocks.push({ id: "main", text: "Es el worktree principal del repositorio: no se puede eliminar." });
    if (wt.path === repo.root) blocks.push({ id: "current", text: "Es el worktree que estás viendo. Ábrelo desde otro para eliminarlo." });
    if (wt.locked) blocks.push({ id: "locked", text: `Está bloqueado${wt.locked === true ? "" : ` (${wt.locked})`}. Desbloquéalo tú mismo si de verdad quieres borrarlo.` });
    warnings.push({ id: "branch-kept", text: wt.branch ? `La rama ${wt.branch} se conserva; solo se borra la carpeta.` : "Se borra la carpeta del worktree." });
  }
  return { blocks, warnings, wt };
}

/**
 * Updating a branch that is NOT checked out here from its upstream, without
 * switching: only a fast-forward (git fetch . <upstream>:<branch>), never a
 * merge. Returns { blocks, upstream, behind }.
 */
export function fastForwardCheck({ repo, status, refs, branch }) {
  const blocks = [];
  const ref = refs.find((r) => r.type === "local" && r.name === branch);
  if (!ref) return { blocks: [{ id: "missing", text: `La rama ${branch} ya no existe.` }], upstream: null, behind: 0 };
  if (branch === status.head && !status.detached) blocks.push({ id: "current", text: `${branch} es la rama actual: usa Pull.` });
  if (!ref.upstream) blocks.push({ id: "no-upstream", text: `${branch} no sigue a ninguna rama remota.` });
  else if (ref.gone) blocks.push({ id: "gone", text: `El upstream ${ref.upstream} ya no existe en el remoto.` });
  else if (!ref.behind) blocks.push({ id: "up-to-date", text: `${branch} ya está al día con ${ref.upstream}.` });
  else if (ref.ahead) blocks.push({ id: "diverged", text: `${branch} tiene ${ref.ahead} commit(s) propios y ${ref.behind} nuevos en ${ref.upstream}: han divergido. Cámbiate a ${branch} y usa Pull para fusionarlos.` });
  if (ref.worktree && ref.worktree !== repo.root) blocks.push({ id: "worktree", text: `${branch} está abierta en otro worktree (${ref.worktree}): actualízala desde allí.` });
  return { blocks, upstream: ref.upstream, behind: ref.behind, remote: ref.upstream?.split("/")[0] ?? null };
}

/**
 * What a Pull does after its preview, like Fork: "up-to-date" (just say so),
 * "fast" (fast-forward with nothing to decide: run it, no sheet) or "review"
 * (divergent, blocked, or anything worth reading: show the preview).
 */
export function pullDecision(p) {
  if (p.blocks.length === 1 && p.blocks[0].id === "up-to-date") return "up-to-date";
  const harmless = new Set(["dirty", "untracked"]);
  if (p.ff && !p.blocks.length && p.warnings.every((w) => harmless.has(w.id))) return "fast";
  return "review";
}

// ---------- fast-forward: say what happened, remember the mode ----------
// A fast-forward leaves no merge commit, so in a graph (this panel's History,
// Fork, …) it looks as if nothing happened. The preview and the result say it
// in one line, and the mode chosen last is remembered per repository.

export const MERGE_MODES = ["ff", "no-ff", "ff-only"];
const NO_FF_LABEL = "Siempre crear commit de merge";
const short = (sha) => (sha ?? "").slice(0, 7);

/** Storage key for the last mode chosen in a repository (shared by its worktrees, per machine). */
export function modeKey(repo, on) { return `merge-mode:${on ?? ""}:${repo.commonDir ?? repo.root}`; }

/**
 * The mode a preview starts on (or keeps after a refresh). Modes only matter
 * when a fast-forward is possible; otherwise every merge creates a commit and
 * "ff-only" would fail, so it is always "ff". Unknown values fall back to "ff".
 */
export function modeFor(p, wanted) {
  if (!p?.ff) return "ff";
  return MERGE_MODES.includes(wanted) ? wanted : "ff";
}

/** Whether a confirmed merge should update the remembered mode. Pull keeps Git's default. */
export function shouldRemember(entry, p) { return entry !== "pull" && Boolean(p?.ff); }

/** One line under the mode choice: what the graph will show afterwards. null if not a fast-forward. */
export function ffPreviewLine(p, mode) {
  if (!p?.ff) return null;
  if (mode === "no-ff") return `Se creará un commit de merge aunque ${p.target} pueda avanzar en línea recta: quedará visible en el grafo.`;
  return `${p.target} avanzará a ${short(p.sourceSha)}, sin commit de merge: en el grafo (aquí o en Fork) parecerá que no pasó nada. Elige "${NO_FF_LABEL}" si quieres verlo.`;
}

/** One line on the result sheet after a fast-forward. */
export function ffResultLine(target, head) {
  return `${target} avanzó a ${short(head)}, sin commit de merge; elige "${NO_FF_LABEL}" si quieres verlo en el grafo.`;
}

// ---------- operations in progress: continue / abort ----------

/** Who "ours" and "theirs" are for the operation in progress. In a rebase they swap. */
export function sideLabels(op, head, rebase) {
  if (op === "rebase") {
    const base = rebase?.ontoName ?? (rebase?.onto ? rebase.onto.slice(0, 7) : "la base");
    const mine = rebase?.branch ?? "tu rama";
    return { ours: `${base} (base del rebase)`, theirs: `tu commit de ${mine}`, oursLong: `la versión de ${base}, sobre la que se reescribe ${mine}`, theirsLong: `la versión de tu commit de ${mine} que se está aplicando` };
  }
  if (op === "merge") return { ours: head, theirs: "lo que llega", oursLong: `la versión de ${head}`, theirsLong: "la versión que llega en el merge" };
  return { ours: `${head} (antes)`, theirs: `el commit del ${op}`, oursLong: `la versión de ${head} (antes del ${op})`, theirsLong: `la versión del commit del ${op}` };
}

const ABORT_TEXT = {
  merge: "Git devolverá la rama y los archivos al estado anterior al merge. Las resoluciones de conflictos que hayas hecho se perderán. Los cambios que tenías antes de empezar se conservan cuando Git puede reconstruirlos.",
  "cherry-pick": "Git devolverá la rama y los archivos al estado anterior al cherry-pick. Las resoluciones de conflictos que hayas hecho se perderán.",
  revert: "Git devolverá la rama y los archivos al estado anterior al revert. Las resoluciones de conflictos que hayas hecho se perderán.",
  rebase: "Git devolverá la rama al commit donde estaba antes del rebase. Los commits ya reaplicados y las resoluciones de conflictos se descartan; tus commits originales siguen intactos.",
  bisect: "Git terminará el bisect y volverá a la rama o el commit donde lo empezaste. No cambia ningún commit.",
};

/**
 * Before continuing or aborting what's in progress: both rewrite files in the
 * work tree, so unsaved editor work blocks them. Returns { blocks, title, detail, command }.
 */
export function inProgressCheck({ repo, status, ops, drafts }, action) {
  const op = ops[0] ?? null, blocks = [];
  if (!op) blocks.push({ id: "none", text: "No hay ninguna operación en curso." });
  const can = action === "abort" ? ["merge", "cherry-pick", "revert", "rebase", "bisect"] : ["cherry-pick", "revert", "rebase"];
  if (op && !can.includes(op)) blocks.push({ id: "unsupported", text: `El panel no puede ${action === "abort" ? "abortar" : "continuar"} ${opName[op] ?? op}.` });
  if (action === "continue" && status.summary.conflicts) blocks.push({ id: "conflicts", text: `Quedan ${status.summary.conflicts} archivo(s) en conflicto: resuélvelos y márcalos con ✓ primero.` });
  const unsaved = unsavedIn(rootsOf(repo), drafts);
  if (unsaved.length && op !== "bisect") blocks.push({ id: "unsaved", text: `Hay ${unsaved.length} archivo(s) sin guardar en el editor (${unsaved.map((p) => rel(repo, p)).slice(0, 3).join(", ")}). Guárdalos o descártalos antes: Git va a reescribir archivos.` });
  const command = !op ? "" : action === "abort" ? (op === "bisect" ? "git bisect reset" : `git ${op} --abort`) : `git -c core.editor=true ${op} --continue`;
  const title = action === "abort" ? (op === "bisect" ? "¿Terminar el bisect?" : `¿Abortar el ${op} en curso?`) : `Continuar el ${op}`;
  return { blocks, op, command, title, detail: action === "abort" ? ABORT_TEXT[op] ?? "" : "" };
}

// ---------- summary for the tab bar's Git button ----------
/** What git-tabs shows next to "Git": shared as "git-panel.summary". null when there's no repository. */
export function summaryFor(d) {
  if (!d?.status) return null;
  const s = d.status.summary;
  return { root: d.repo.root, on: d.on ?? null, total: s.total, conflicts: s.conflicts, op: d.ops?.[0] ?? null, head: d.status.head ?? null };
}

// ---------- optional automatic fetch ----------
/** Minutes offered in the Fetch button's menu; 0 = off (the default). */
export const AUTO_FETCH_CHOICES = [0, 5, 15, 30];
export const autoFetchMinutes = (stored) => (AUTO_FETCH_CHOICES.includes(Number(stored)) ? Number(stored) : 0);

/**
 * Is an automatic fetch due for the repository the panel shows? Never while
 * another operation runs, without remotes, or after a failure (paused until
 * a manual Fetch works). `state`: { last, paused } for that repository.
 */
export function autoFetchDue({ minutes, state, now, busy, remotes }) {
  if (!minutes || busy || !remotes || !state || state.paused) return false;
  return now - (state.last ?? 0) >= minutes * 60000;
}

/** The Fetch button's tooltip line about it. */
export function autoFetchLine(minutes, state, now) {
  if (!minutes) return "Fetch automático desactivado (clic derecho para activarlo)";
  if (state?.paused) return `Fetch automático pausado en este repo tras un error. Pulsa Fetch para reintentar.`;
  const ago = state?.last ? Math.round((now - state.last) / 60000) : null;
  return `Fetch automático cada ${minutes} min${ago == null ? "" : ` · el último hace ${ago} min`} (clic derecho para cambiarlo)`;
}
