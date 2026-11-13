// The Git button's badge: the panel's shared summary → what git-tabs shows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODS, F, sh, exec, makeRepo, commit, ctx } from "./helpers/repo.mjs";

const { gitBadge } = await import(join(MODS, "git-tabs/badge.js"));

test("clean repository: summary with zeros, no badge", async () => {
  const d = await makeRepo();
  const sum = F.summaryFor(await ctx(d));
  assert.deepEqual(sum, { root: d, on: null, total: 0, conflicts: 0, op: null, head: "main" });
  assert.equal(gitBadge(sum), null);
  assert.equal(F.summaryFor(null), null);
  assert.equal(gitBadge(null), null);
});

test("uncommitted files: the count, in the changes tone", async () => {
  const d = await makeRepo();
  writeFileSync(join(d, "a.txt"), "x\n"); writeFileSync(join(d, "new.txt"), "n\n");
  const b = gitBadge(F.summaryFor(await ctx(d)));
  assert.deepEqual(b, { text: "2", tone: "changes", tip: "2 archivo(s) con cambios sin commit en main" });
  assert.equal(gitBadge({ total: 1500, conflicts: 0, op: null }).text, "999+");
});

test("a merge stopped on a conflict: ⚠1 in the blocked tone", async () => {
  const d = await makeRepo();
  await sh(d, "switch", "-qc", "dev"); await commit(d, "a.txt", "dev\n", "dev");
  await sh(d, "switch", "-q", "main"); await commit(d, "a.txt", "main\n", "main");
  await exec("git", ["merge", "dev"], { cwd: d });
  const b = gitBadge(F.summaryFor(await ctx(d)));
  assert.deepEqual(b, { text: "⚠1", tone: "blocked", tip: "Merge en curso · 1 archivo(s) en conflicto en main" });
  assert.deepEqual(gitBadge({ total: 0, conflicts: 0, op: "bisect", head: null }), { text: "⚠", tone: "blocked", tip: "Bisect en curso" });
});
