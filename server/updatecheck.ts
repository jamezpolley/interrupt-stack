// "Is there something newer on GitHub?" Read-only (git ls-remote), so it needs no writable checkout and works
// from the image's own code too. request() never blocks and never throws: the answer shows up in state() later.

export type Available = { commit: string; short: string; ref: string };
export type UpdateState = { enabled: boolean; ref: string | null; checkedAt: number | null; available: Available | null };

type LsRemote = (url: string, ref: string) => Promise<string | null>;

/** The commit a branch or tag points at on the remote. An annotated tag's peeled line is the commit itself. */
const gitLsRemote: LsRemote = async (url, ref) => {
  const proc = Bun.spawn(["git", "ls-remote", url, `refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`], {
    stdout: "pipe",
    stderr: "ignore",
    timeout: 15_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const text = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) return null;
  const rows = text.split("\n").map((l) => l.trim().split(/\s+/)).filter((p) => p.length === 2);
  const pick = (name: string) => rows.find(([, n]) => n === name)?.[0];
  return pick(`refs/tags/${ref}^{}`) ?? pick(`refs/tags/${ref}`) ?? pick(`refs/heads/${ref}`) ?? null;
};

export function createUpdateChecker(opts: {
  codeDir: string;
  ref: string;
  current: string | null;
  now?: () => number;
  minIntervalMs?: number;
  lsRemote?: LsRemote;
}) {
  const now = opts.now ?? Date.now;
  const minInterval = opts.minIntervalMs ?? 60_000;
  const lsRemote = opts.lsRemote ?? gitLsRemote;

  let url: string | null = null;
  try {
    const r = Bun.spawnSync(["git", "-C", opts.codeDir, "remote", "get-url", "origin"], { stdout: "pipe", stderr: "ignore", timeout: 5000 });
    if (r.exitCode === 0) url = r.stdout.toString().trim() || null;
  } catch {}

  let checkedAt: number | null = null;
  let available: Available | null = null;
  let startedAt: number | null = null;
  let inflight: Promise<void> | null = null;

  async function check() {
    try {
      const remote = await lsRemote(url!, opts.ref);
      if (!remote || !opts.current) return; // cannot tell: say nothing rather than guess
      checkedAt = now();
      available = remote !== opts.current ? { commit: remote, short: remote.slice(0, 7), ref: opts.ref } : null;
    } catch {} // a failed check changes nothing
  }

  return {
    state: (): UpdateState => ({ enabled: url !== null, ref: url ? opts.ref : null, checkedAt, available }),
    request(): void {
      if (!url || inflight) return;
      if (startedAt !== null && now() - startedAt < minInterval) return;
      startedAt = now();
      inflight = check().finally(() => (inflight = null));
    },
    /** Resolves when any running check has finished (for tests). */
    settled: async () => void (await inflight),
  };
}
