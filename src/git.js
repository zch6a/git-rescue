// @ts-check
/**
 * Running git, and reading what it keeps: refs, reflogs, objects.
 *
 * Every call goes through `git()`, which never opens a pager or asks for a password and reads output in a
 * fixed locale, so it can be parsed. Only commands git has had for years are used (no `switch`, `restore`,
 * `--skip` for cherry-pick): git 2.17 and later.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export class GitError extends Error {
  /** @param {string} message @param {string[]} args @param {number|null} code */
  constructor(message, args, code) {
    super(message);
    this.args = args;
    this.code = code;
  }
}

/** The environment for git: the caller's, read on each call, with what makes output parseable and quiet. */
const env = () => ({
  ...process.env,
  LC_ALL: "C",
  LANG: "C",
  GIT_PAGER: "cat",
  PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0", // reading the status must not take the index lock
  GIT_EDITOR: "true", // `rebase --continue` and the like keep their message instead of opening an editor no one sees
});

/**
 * Runs git in `cwd`. Returns stdout; throws GitError when git fails, unless `allowFail`.
 * @param {string} cwd
 * @param {string[]} args
 * @param {{allowFail?: boolean, input?: string | Buffer, maxBuffer?: number, raw?: boolean}} [opts]
 * @returns {string}
 */
export function git(cwd, args, opts = {}) {
  const r = spawnSync("git", args, {
    cwd,
    env: env(),
    input: opts.input,
    maxBuffer: opts.maxBuffer ?? 256 * 1024 * 1024,
    encoding: opts.raw ? null : "utf8", // null: bytes, for object contents
    windowsHide: true,
  });
  if (r.error) throw new GitError(`could not run git ${args[0]}: ${r.error.message.slice(0, 200)}`, args.slice(0, 3), null);
  if (r.status !== 0 && !opts.allowFail) {
    const err = String(r.stderr || "").trim();
    throw new GitError(err || `git ${args[0]} failed (exit ${r.status})`, args, r.status);
  }
  return /** @type {string} */ (r.stdout ?? "");
}

/** The same, returning the exit code and both outputs. @param {string} cwd @param {string[]} args */
export function gitRun(cwd, args) {
  const r = spawnSync("git", args, { cwd, env: env(), encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new GitError(`could not run git: ${r.error.message}`, args, null);
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * The repository around `cwd`: its top folder and its .git folder (for a worktree, the worktree's own git
 * dir, and the common dir where refs and objects live).
 * @param {string} cwd
 */
export function repoAt(cwd) {
  const bare = git(cwd, ["rev-parse", "--is-bare-repository"], { allowFail: true }).trim() === "true";
  const out = git(cwd, ["rev-parse", "--absolute-git-dir", "--git-common-dir"], { allowFail: true }).trim().split("\n");
  if (out.length < 2 || !out[0]) return null;
  const [gitDir, common] = out;
  const top = bare ? gitDir : git(cwd, ["rev-parse", "--show-toplevel"], { allowFail: true }).trim();
  const commonDir = common.match(/^([A-Za-z]:)?[\\/]/) ? common : join(cwd, common);
  return { top, gitDir, commonDir: existsSync(commonDir) ? commonDir : gitDir, bare };
}

/** @param {string} cwd @param {string} rev @returns {string|null} */
export function resolve(cwd, rev) {
  const out = git(cwd, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { allowFail: true }).trim();
  return /^[0-9a-f]{40}$/.test(out) ? out : null;
}

/** @param {string} cwd @param {string} sha */
export function exists(cwd, sha) {
  return gitRun(cwd, ["cat-file", "-e", sha]).code === 0;
}

/**
 * Which of these objects the repository has, in one `cat-file --batch-check` (ids go through stdin: a command
 * line holds about 800 of them on Windows, and a busy repository's reflogs hold more).
 * @param {string} cwd
 * @param {string[]} shas
 * @returns {string[]}
 */
export function present(cwd, shas) {
  const unique = [...new Set(shas)].filter((s) => /^[0-9a-f]{40}$/.test(s) && !/^0+$/.test(s));
  if (!unique.length) return [];
  const out = git(cwd, ["cat-file", "--batch-check"], { input: unique.join("\n") + "\n" });
  return out.split("\n").filter((l) => / (commit|tree|blob|tag) \d+$/.test(l)).map((l) => l.slice(0, 40));
}

/**
 * All refs: name -> sha (branches, tags, remote-tracking refs, stash, notes; not refs/rescue).
 * @param {string} cwd
 * @returns {Map<string, string>}
 */
export function refs(cwd) {
  const out = git(cwd, ["for-each-ref", "--format=%(objectname) %(refname)"]);
  const m = new Map();
  for (const line of out.split("\n")) {
    const [sha, name] = line.split(" ");
    if (sha && name && !name.startsWith("refs/rescue/")) m.set(name, sha);
  }
  return m;
}

/** @param {string} cwd @returns {string[]} */
export function branches(cwd) {
  return [...refs(cwd).keys()].filter((r) => r.startsWith("refs/heads/")).map((r) => r.slice("refs/heads/".length));
}

/**
 * Commits reachable from `shas` that no ref reaches (branches, tags, remotes, stash): what would be lost
 * if the reflog expired. Empty when they are all safe somewhere.
 * @param {string} cwd
 * @param {string[]} shas
 * @returns {string[]}
 */
export function unreachableFromRefs(cwd, shas, keep = keepers(cwd)) {
  const have = present(cwd, shas);
  if (!have.length) return [];
  // The ids through stdin, then everything that keeps commits: every ref but git-rescue's own backups (branches,
  // tags, remotes, notes, refs/original ...; --glob=refs/* and not --all, which counts HEAD too, and commits on a
  // detached HEAD are what may be lost) and every stash on the stash list, not only the newest.
  const out = git(cwd, ["rev-list", "--stdin", "--not", ...KEEP_REFS], { allowFail: true, input: [...have, ...keep.map((k) => `^${k}`)].join("\n") + "\n" });
  return out.split("\n").filter((l) => /^[0-9a-f]{40}$/.test(l));
}

/** The refs that keep commits, for rev-list: all of refs/, less git-rescue's backups. */
export const KEEP_REFS = ["--exclude=refs/rescue/*", "--glob=refs/*"];

/**
 * Commits that are kept though no ref names them: the stashes below the newest (stash@{1} ...), which only
 * the stash's reflog holds, and the HEADs of other worktrees (git 2.19's fsck ignores them).
 * @param {string} cwd
 * @returns {string[]}
 */
export function keepers(cwd) {
  const out = [];
  const stashes = git(cwd, ["log", "-g", "--format=%H", "refs/stash", "--"], { allowFail: true });
  out.push(...stashes.split("\n").filter((l) => /^[0-9a-f]{40}$/.test(l)));
  // Other worktrees' HEADs, not this one's: commits on this detached HEAD are exactly what may be about to be lost.
  const here = git(cwd, ["rev-parse", "--show-toplevel"], { allowFail: true }).trim().replace(/\\/g, "/").toLowerCase();
  for (const w of worktrees(cwd)) if (w.head && w.path.replace(/\\/g, "/").toLowerCase() !== here) out.push(w.head);
  return [...new Set(out)];
}

/**
 * The repository's worktrees: path, HEAD commit and branch (`worktree list --porcelain`, git 2.7+).
 * @param {string} cwd
 * @returns {{path: string, head: string | null, branch: string | null}[]}
 */
export function worktrees(cwd) {
  const out = git(cwd, ["worktree", "list", "--porcelain"], { allowFail: true });
  /** @type {{path: string, head: string | null, branch: string | null}[]} */
  const list = [];
  for (const block of out.split(/\n\n+/)) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    if (!path) continue;
    list.push({ path, head: block.match(/^HEAD ([0-9a-f]{40})$/m)?.[1] ?? null, branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null });
  }
  return list;
}

/**
 * @typedef {{old: string, new: string, time: number, message: string, ref: string}} ReflogEntry
 */

/**
 * A reflog, newest first, read from its file (git's own reflog command changed its output over the years;
 * the file format has not). `ref` is "HEAD" or "refs/heads/main" and so on.
 * @param {{gitDir: string, commonDir: string}} repo
 * @param {string} ref
 * @returns {ReflogEntry[]}
 */
export function reflog(repo, ref) {
  const base = ref === "HEAD" ? repo.gitDir : repo.commonDir;
  const file = join(base, "logs", ...ref.split("/"));
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) .*?> (\d+) [+-]\d{4}\t?(.*)$/);
    if (m) out.push({ old: m[1], new: m[2], time: Number(m[3]) * 1000, message: m[4], ref });
  }
  return out.reverse();
}

/** Every reflog git keeps for this repository: HEAD, branches, remote-tracking refs, stash. @param {{gitDir: string, commonDir: string}} repo */
export function reflogNames(repo) {
  const names = existsSync(join(repo.gitDir, "logs", "HEAD")) ? ["HEAD"] : [];
  const walk = (/** @type {string} */ dir, /** @type {string} */ prefix) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, `${prefix}${name}/`);
      else names.push(`${prefix}${name}`);
    }
  };
  walk(join(repo.commonDir, "logs", "refs"), "refs/");
  return names.filter((n) => !n.startsWith("refs/rescue/"));
}

/**
 * One-line facts about commits: sha -> {subject, time, parents}. Unknown shas are left out.
 * @param {string} cwd
 * @param {string[]} shas
 */
export function commitInfo(cwd, shas) {
  /** @type {Map<string, {subject: string, time: number, parents: string[]}>} */
  const out = new Map();
  const have = present(cwd, shas);
  if (!have.length) return out;
  const text = git(cwd, ["log", "--no-walk=unsorted", "--stdin", "--format=%H%x00%ct%x00%P%x00%s"], { input: have.join("\n") + "\n", allowFail: true });
  for (const line of text.split("\n")) {
    const [sha, ct, parents, subject] = line.split("\0");
    if (sha && /^[0-9a-f]{40}$/.test(sha)) out.set(sha, { subject: subject ?? "", time: Number(ct) * 1000, parents: parents ? parents.split(" ") : [] });
  }
  return out;
}

/**
 * Objects no ref and no reflog reaches (`git fsck --unreachable`): staged files lost to `reset --hard`,
 * dropped stashes, commits whose reflog entries expired. Read-only (no --lost-found, which writes files).
 * @param {string} cwd
 * @returns {{type: string, sha: string}[]}
 */
export function unreachableObjects(cwd) {
  // --connectivity-only: the same list, without checking every object's contents (11 times faster on a big repo).
  const out = git(cwd, ["fsck", "--unreachable", "--connectivity-only", "--no-progress"], { allowFail: true });
  const found = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^unreachable (commit|blob|tree|tag) ([0-9a-f]{40})/);
    if (m) found.push({ type: m[1], sha: m[2] });
  }
  return found;
}

/**
 * When a loose object was written (its file's time): roughly when it was created. null for packed objects.
 * @param {{commonDir: string}} repo
 * @param {string} sha
 */
export function objectTime(repo, sha) {
  try {
    return statSync(join(repo.commonDir, "objects", sha.slice(0, 2), sha.slice(2))).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Object contents in one `cat-file --batch` run: sha -> Buffer (objects over `limit` bytes are skipped).
 * @param {string} cwd
 * @param {string[]} shas
 * @param {number} [limit]
 * @returns {Map<string, Buffer>}
 */
export function readObjects(cwd, shas, limit = 4 * 1024 * 1024) {
  /** @type {Map<string, Buffer>} */
  const out = new Map();
  if (!shas.length) return out;
  const sizes = git(cwd, ["cat-file", "--batch-check"], { input: shas.join("\n") + "\n" });
  const wanted = [];
  for (const line of sizes.split("\n")) {
    const m = line.match(/^([0-9a-f]{40}) \w+ (\d+)$/);
    if (m && Number(m[2]) <= limit) wanted.push(m[1]);
  }
  if (!wanted.length) return out;
  const buf = /** @type {Buffer} */ (/** @type {unknown} */ (git(cwd, ["cat-file", "--batch"], { input: wanted.join("\n") + "\n", raw: true })));
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(10, pos);
    if (nl < 0) break;
    const header = buf.subarray(pos, nl).toString("utf8");
    const m = header.match(/^([0-9a-f]{40}) \w+ (\d+)$/);
    if (!m) break;
    const size = Number(m[2]);
    out.set(m[1], buf.subarray(nl + 1, nl + 1 + size));
    pos = nl + 1 + size + 1; // the content, then a newline
  }
  return out;
}

/** @param {string} cwd */
export function version(cwd) {
  const m = git(cwd, ["--version"]).match(/(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
}

/** A short sha. @param {string} sha */
export const short = (sha) => sha.slice(0, 8);
