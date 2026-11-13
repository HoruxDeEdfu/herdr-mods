// git-spaces: change and conflict counts, and the in-progress badge, on real repos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODS, sh, exec, makeRepo, commit } from "./helpers/repo.mjs";

const S = await import(join(MODS, "git-spaces/gitstate.js"));
const status = async (d) => (await exec("git", ["status", "--porcelain", "-z", "--untracked-files=all"], { cwd: d })).stdout;
const op = async (d) => {
  const r = await exec("git", S.markerArgs(), { cwd: d });
  return S.opFrom(r.stdout.split("\n").filter(Boolean).map((p) => existsSync(p)));
};

test("counts: modified, new files one by one, a rename once; no conflicts", async () => {
  const d = await makeRepo();
  await commit(d, "con espacio.txt", "x\n", "second file");
  writeFileSync(join(d, "a.txt"), "changed\n");
  writeFileSync(join(d, "n1.txt"), "1\n"); writeFileSync(join(d, "n2.txt"), "2\n");
  await sh(d, "mv", "con espacio.txt", "renombrado.txt");
  assert.deepEqual(S.readStatus(await status(d)), { changes: 4, conflicts: 0 });
  assert.equal(S.countChanges(await status(d)), 4);
  assert.equal(await op(d), null);
  assert.equal(S.opBadge(null, 0), null);
});

test("a merge stopped on a conflict: badge '⚠ merge·1'", async () => {
  const d = await makeRepo();
  await sh(d, "switch", "-qc", "dev"); await commit(d, "a.txt", "dev\n", "dev");
  await sh(d, "switch", "-q", "main"); await commit(d, "a.txt", "main\n", "main");
  await exec("git", ["merge", "dev"], { cwd: d });
  const st = S.readStatus(await status(d));
  assert.equal(st.conflicts, 1);
  assert.equal(await op(d), "merge");
  const b = S.opBadge("merge", st.conflicts);
  assert.equal(b.text, "⚠ merge·1");
  assert.match(b.tip, /^Merge en curso · 1 archivo\(s\) en conflicto\. Ábrelo en el panel Git/);
});

test("rebase and bisect are detected; conflicts with nothing in progress show the count", async () => {
  const d = await makeRepo();
  await sh(d, "switch", "-qc", "f"); await commit(d, "a.txt", "f\n", "f");
  await sh(d, "switch", "-q", "main"); await commit(d, "a.txt", "m\n", "m");
  await sh(d, "switch", "-q", "f");
  await exec("git", ["rebase", "main"], { cwd: d });
  assert.equal(await op(d), "rebase");
  await sh(d, "rebase", "--abort");
  await sh(d, "bisect", "start");
  assert.equal(await op(d), "bisect");
  assert.equal(S.opBadge("bisect", 0).text, "⚠ bisect");
  assert.equal(S.opBadge(null, 3).text, "⚠ 3");
});
