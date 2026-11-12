// Runs git with an argument list (never a shell string), records what it ran,
// and keeps writes to one repository one at a time. Pure: the host's `exec`
// is injected, so the tests drive it with Node's child_process.

// Reads write nothing under .git (no index refresh or lock, no fsmonitor
// cookie): the folder watch would see it and refresh again, and an agent's
// own git command would find the index locked.
export const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "-c", "core.quotePath=false", "-c", "color.ui=false"];
const WRITE = ["-c", "core.quotePath=false", "-c", "color.ui=false"];

export class GitError extends Error {
  constructor(result, argv) {
    super((result.stderr || result.stdout || `git exited with ${result.code}`).trim());
    this.code = result.code; this.stderr = result.stderr ?? ""; this.stdout = result.stdout ?? ""; this.argv = argv;
  }
}

export class Runner {
  /**
   * @param {{ exec: Function, platform?: string, on?: string|null, onLog?: Function, now?: Function }} host
   */
  constructor(host) {
    this.host = host;
    this.queue = new Map(); // lock key → tail promise
    this.busy = new Map();  // lock key → label of the running write
    this.seq = 0;
  }

  record(entry) { try { this.host.onLog?.(entry); } catch {} }

  /** `expected`: exit codes that are answers, not failures (merge-tree 1 = conflicts). */
  async raw(cwd, argv, { timeout = 30000, kind = "read", log = false, label, expected = [0] } = {}) {
    const started = (this.host.now ?? Date.now)();
    const [cmd, ...args] = argv;
    let result;
    try { result = await this.host.exec(cmd, args, { cwd, on: this.host.on ?? null, timeout }); }
    catch (e) { result = { code: -1, stdout: "", stderr: String(e?.message ?? e) }; }
    const ms = (this.host.now ?? Date.now)() - started;
    if (log || !expected.includes(result.code)) this.record({ id: ++this.seq, at: started, ms, cwd, argv, code: result.code, kind, label, stderr: (result.stderr ?? "").slice(0, 4000), stdout: kind === "read" ? "" : (result.stdout ?? "").slice(0, 2000) });
    return result;
  }

  /** A read-only git command; resolves with the result (check `.code`). */
  read(cwd, args, opts = {}) { return this.raw(cwd, ["git", ...READ, ...args], { ...opts, kind: "read" }); }

  /** A read that must succeed. */
  async readOk(cwd, args, opts) {
    const r = await this.read(cwd, args, opts);
    if (r.code !== 0) throw new GitError(r, args);
    return r.stdout;
  }

  /** A command that changes the repository. Serialized per `lock` (the common dir). */
  write(cwd, args, { lock = cwd, timeout = 120000, label, network = false } = {}) {
    const argv = network ? this.networkArgv(args) : ["git", ...WRITE, ...args];
    const prev = this.queue.get(lock) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(async () => {
      this.busy.set(lock, label ?? args[0]);
      try { return await this.raw(cwd, argv, { timeout, kind: network ? "network" : "write", log: true, label }); }
      finally { this.busy.delete(lock); }
    });
    this.queue.set(lock, run.catch(() => {}));
    return run;
  }

  isBusy(lock) { return this.busy.get(lock) ?? null; }

  // Fetch/pull/push without a terminal: never wait on a password prompt.
  networkArgv(args) {
    if (this.host.platform === "windows" && !this.host.on) return ["git", ...WRITE, "-c", "credential.interactive=never", ...args];
    return ["env", "GIT_TERMINAL_PROMPT=0", "git", ...WRITE, ...args];
  }
}

/** How a command is shown in the operations log: quoted when needed, READ flags folded. */
export function displayArgv(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-optional-locks") continue;
    if (a === "-c" && /^(core\.fsmonitor|diff\.autoRefreshIndex|core\.quotePath|color\.ui)=/.test(argv[i + 1] ?? "")) { i++; continue; }
    out.push(/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
  }
  return out.join(" ");
}
