// History marks where a branch was before a fast-forward (from its reflog).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Q, O, git, sh, makeRepo, commit, ctx, withRemote } from "./helpers/repo.mjs";

test("parseFfReflog: merge, Actualizar (fetch .) and pull fast-forwards; other moves ignored", () => {
  const row = (h, s, t) => `${h}\x1f${s}\x1f${t}`;
  const out = [
    row("c3", "fetch . refs/remotes/origin/qa:refs/heads/qa: fast-forward", 300),
    row("c2", "pull: Fast-forward", 200),
    row("c1", "commit: x", 150),
    row("b1", "merge dev: Fast-forward", 100),
    row("a1", "commit (initial): base", 50),
  ].join("\0") + "\0";
  const ev = Q.parseFfReflog(out, "main");
  assert.deepEqual(ev.map((e) => [e.from, e.to, e.source]), [["c2", "c3", "origin/qa"], ["c1", "c2", "pull"], ["a1", "b1", "dev"]]);
  assert.equal(ev[2].at, 100000);
});

test("ffMarks on a real merge: main's old tip is marked with the source", async () => {
  const d = await makeRepo();
  const base = (await sh(d, "rev-parse", "HEAD")).trim();
  await sh(d, "switch", "-qc", "dev"); await commit(d, "b.txt", "b\n", "add b"); await sh(d, "switch", "-q", "main");
  await O.merge(git, (await ctx(d)).repo, "dev", "ff");
  const tip = (await sh(d, "rev-parse", "HEAD")).trim();
  const marks = await Q.ffMarks(git, d, ["main", "dev", "missing"]);
  assert.equal(marks.length, 1);
  assert.deepEqual([marks[0].branch, marks[0].from, marks[0].to, marks[0].source], ["main", base, tip, "dev"]);
  assert.match(Q.ffMarkText(marks[0]), new RegExp(`^main estaba aquí antes del fast-forward de dev y avanzó a ${tip.slice(0, 7)} sin commit de merge\\.$`));
});

test("a --no-ff merge is not a fast-forward mark; old events age out", async () => {
  const d = await makeRepo();
  await sh(d, "switch", "-qc", "dev"); await commit(d, "b.txt", "b\n", "add b"); await sh(d, "switch", "-q", "main");
  await O.merge(git, (await ctx(d)).repo, "dev", "no-ff");
  assert.deepEqual(await Q.ffMarks(git, d, ["main"]), []);
  await sh(d, "switch", "-qc", "dev2"); await commit(d, "c.txt", "c\n", "add c"); await sh(d, "switch", "-q", "main");
  await O.merge(git, (await ctx(d)).repo, "dev2", "ff");
  assert.equal((await Q.ffMarks(git, d, ["main"])).length, 1);
  assert.equal((await Q.ffMarks(git, d, ["main"], { now: Date.now() + 40 * 864e5 })).length, 0);
});

test("Actualizar (fast-forward without checkout) is marked with its upstream", async () => {
  const { src, bare } = await withRemote();
  await sh(src, "switch", "-qc", "qa"); await sh(src, "push", "-q", "-u", "origin", "qa"); await sh(src, "switch", "-q", "main");
  const other = bare + "-clone";
  await sh(src, "clone", "-q", bare, other);
  await sh(other, "switch", "-q", "qa"); await commit(other, "q.txt", "q\n", "qa work"); await sh(other, "push", "-q", "origin", "qa");
  await sh(src, "fetch", "-q", "origin");
  await O.fastForwardBranch(git, (await ctx(src)).repo, "qa", "origin/qa");
  const marks = await Q.ffMarks(git, src, ["qa"]);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].source, "origin/qa");
  assert.match(Q.ffMarkText(marks[0]), /^qa estaba aquí antes del fast-forward de origin\/qa/);
});
