// Optional automatic fetch: off by default, due only when idle, paused after a failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { F, O, Q, git, sh, makeRepo, commit, ctx, withRemote, exec } from "./helpers/repo.mjs";

const MIN = 60000;

test("off unless one of the offered intervals was chosen", () => {
  assert.deepEqual(F.AUTO_FETCH_CHOICES, [0, 5, 15, 30]);
  assert.equal(F.autoFetchMinutes(null), 0);
  assert.equal(F.autoFetchMinutes("15"), 15);
  assert.equal(F.autoFetchMinutes("7"), 0, "only the offered values");
  assert.equal(F.autoFetchMinutes("abc"), 0);
});

test("due after the interval, never while busy, without remotes or when paused", () => {
  const now = 100 * MIN, st = { last: now - 15 * MIN, paused: false };
  const base = { minutes: 15, state: st, now, busy: false, remotes: 1 };
  assert.equal(F.autoFetchDue(base), true);
  assert.equal(F.autoFetchDue({ ...base, state: { last: now - 14 * MIN } }), false);
  assert.equal(F.autoFetchDue({ ...base, minutes: 0 }), false);
  assert.equal(F.autoFetchDue({ ...base, busy: true }), false);
  assert.equal(F.autoFetchDue({ ...base, remotes: 0 }), false);
  assert.equal(F.autoFetchDue({ ...base, state: { ...st, paused: true } }), false);
  assert.equal(F.autoFetchDue({ ...base, state: { last: 0 } }), true, "just enabled: fetch now");
});

test("tooltip line says off, the interval and the last one, or paused", () => {
  const now = 100 * MIN;
  assert.match(F.autoFetchLine(0, null, now), /desactivado/);
  assert.equal(F.autoFetchLine(15, { last: now - 3 * MIN }, now), "Fetch automático cada 15 min · el último hace 3 min (clic derecho para cambiarlo)");
  assert.match(F.autoFetchLine(5, { paused: true }, now), /pausado/);
});

test("the fetch it runs brings new commits, keeps branches and files, and never prunes", async () => {
  const { src, bare } = await withRemote();
  await sh(src, "switch", "-qc", "old"); await sh(src, "push", "-q", "-u", "origin", "old"); await sh(src, "switch", "-q", "main");
  const other = bare + "-clone";
  await sh(src, "clone", "-q", bare, other);
  await commit(other, "n.txt", "n\n", "remote work"); await sh(other, "push", "-q", "origin", "main");
  await sh(other, "push", "-q", "origin", "--delete", "old");
  const before = (await sh(src, "rev-parse", "main")).trim();
  await O.fetch(git, (await ctx(src)).repo, "origin");
  assert.equal((await sh(src, "rev-parse", "main")).trim(), before, "local branch untouched");
  assert.equal((await sh(src, "rev-list", "--count", "main..origin/main")).trim(), "1");
  assert.equal((await exec("git", ["rev-parse", "--verify", "-q", "refs/remotes/origin/old"], { cwd: src })).code, 0, "no --prune");
});
