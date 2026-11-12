// @ts-check
/**
 * Everything git can still give back, and searching it.
 *
 * Three kinds of lost work, all still in .git until `git gc` prunes them (two weeks by default for objects no
 * reflog reaches; 30 to 90 days for reflog entries):
 * - commits only a reflog reaches: a reset, a rebase, a deleted branch, a detached HEAD left behind;
 * - commits nothing reaches: dropped stashes, commits whose reflog entries expired;
 * - file contents that were added (staged) and never committed: what `reset --hard` took.
 */

import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { relative, resolve as resolvePath } from "node:path";

import { lostObjects } from "./diagnose.js";
import { KEEP_REFS, commitInfo, git, keepers, objectTime, readObjects, reflog, reflogNames, short, unreachableFromRefs } from "./git.js";

/**
 * Commits that only reflogs keep (not on any branch, tag, remote-tracking ref or the stash).
 * @param {string} cwd
 * @param {{gitDir: string, commonDir: string}} repo
 */
export function reflogOnly(cwd, repo) {
  const tips = new Set();
  for (const name of reflogNames(repo)) for (const e of reflog(repo, name)) {
    if (!/^0+$/.test(e.old)) tips.add(e.old);
    if (!/^0+$/.test(e.new)) tips.add(e.new);
  }
  const lost = unreachableFromRefs(cwd, [...tips]);
  const info = commitInfo(cwd, lost);
  return lost.map((sha) => ({ sha, ...(info.get(sha) ?? { subject: "", time: 0, parents: [] }) })).sort((a, b) => b.time - a.time);
}

/**
 * The whole picture: lost commits (reflog-only and unreachable) and staged-but-never-committed contents.
 * @param {string} cwd
 * @param {{gitDir: string, commonDir: string}} repo
 */
export function inventory(cwd, repo) {
  const objs = lostObjects(cwd);
  const blobs = objs.stagedBlobs.map((sha) => ({ sha, time: objectTime(repo, sha) }));
  const contents = readObjects(cwd, blobs.map((b) => b.sha), 64 * 1024);
  const sizes = sizeOf(cwd, blobs.map((b) => b.sha));
  return {
    reflogOnly: reflogOnly(cwd, repo),
    unreachable: objs.commits,
    staged: blobs
      .map((b) => ({ ...b, size: sizes.get(b.sha) ?? 0, preview: preview(contents.get(b.sha)) }))
      .sort((a, b) => (b.time ?? 0) - (a.time ?? 0)),
  };
}

/** @param {string} cwd @param {string[]} shas */
function sizeOf(cwd, shas) {
  /** @type {Map<string, number>} */
  const out = new Map();
  if (!shas.length) return out;
  for (const line of git(cwd, ["cat-file", "--batch-check"], { input: shas.join("\n") + "\n" }).split("\n")) {
    const m = line.match(/^([0-9a-f]{40}) \w+ (\d+)$/);
    if (m) out.set(m[1], Number(m[2]));
  }
  return out;
}

/** The first non-empty line of a content, or "(binary)". @param {Buffer | undefined} buf */
export function preview(buf) {
  if (!buf) return "";
  if (isBinary(buf)) return "(binary)";
  const line = buf.toString("utf8").split(/\r?\n/).find((l) => l.trim()) ?? "";
  return line.trim().slice(0, 100);
}

/** @param {Buffer} buf */
function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

/**
 * @typedef {{sha: string, where: string, line: number, text: string}} Match
 */

/**
 * Searches lost work for `text`: the staged contents, the files of lost commits (as they were in those
 * commits, with their paths), and the commits' messages.
 * @param {string} cwd
 * @param {{gitDir: string, commonDir: string}} repo
 * @param {string} text
 * @param {{ignoreCase?: boolean, limit?: number}} [opts]
 * @returns {Match[]}
 */
export function find(cwd, repo, text, opts = {}) {
  const inv = inventory(cwd, repo);
  const needle = opts.ignoreCase ? text.toLowerCase() : text;
  const has = (/** @type {string} */ s) => (opts.ignoreCase ? s.toLowerCase() : s).includes(needle);
  /** @type {Match[]} */
  const matches = [];
  // Which blob came from which lost commit, and under what path (only what those commits added or changed).
  const commits = [...inv.reflogOnly, ...inv.unreachable];
  /** @type {Map<string, string>} */
  const paths = new Map();
  if (commits.length) {
    const keep = keepers(cwd);
    const listed = git(cwd, ["rev-list", "--objects", "--stdin", "--not", ...KEEP_REFS], { allowFail: true,
      input: [...commits.map((c) => c.sha), ...keep.map((k) => `^${k}`)].join("\n") + "\n" });
    for (const line of listed.split("\n")) {
      const [sha, ...rest] = line.split(" ");
      if (rest.length && /^[0-9a-f]{40}$/.test(sha)) paths.set(sha, rest.join(" "));
    }
  }
  for (const c of commits) if (has(c.subject)) matches.push({ sha: c.sha, where: `commit message (${short(c.sha)})`, line: 0, text: c.subject });
  const blobShas = [...inv.staged.map((b) => b.sha), ...paths.keys()];
  const contents = readObjects(cwd, blobShas);
  const staged = new Set(inv.staged.map((b) => b.sha));
  for (const [sha, buf] of contents) {
    if (isBinary(buf)) continue;
    const lines = buf.toString("utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (has(lines[i])) {
        matches.push({ sha, where: staged.has(sha) ? "a file you staged and never committed" : `${paths.get(sha)} in a lost commit`, line: i + 1, text: lines[i].trim().slice(0, 160) });
        if (matches.length >= (opts.limit ?? 200)) return matches;
      }
    }
  }
  return matches;
}

/**
 * Writes a lost file's contents (or a lost commit's whole message and diff) to `file`, never over an
 * existing one.
 * @param {string} cwd
 * @param {string} id  a sha, or its start (at least 6 characters)
 * @param {string} file
 */
export function restore(cwd, id, file) {
  if (!/^[0-9a-f]{6,40}$/.test(id)) throw new Error(`"${id}" is not an object id (the hex code git-rescue lost shows)`);
  if (existsSync(file)) throw new Error(`${file} already exists; choose a new name (git-rescue never overwrites a file)`);
  const full = git(cwd, ["rev-parse", "--verify", "--quiet", id], { allowFail: true }).trim();
  if (!/^[0-9a-f]{40}$/.test(full)) throw new Error(`no object ${id} in this repository`);
  const type = git(cwd, ["cat-file", "-t", full]).trim();
  let data;
  if (type === "blob") {
    // Through git's filters for the name it is restored as (line endings by core.autocrlf and .gitattributes,
    // LFS and other smudge filters), as `git checkout` would write it; the raw contents if the file is outside
    // the repository or git is too old for --filters (2.11).
    const top = git(cwd, ["rev-parse", "--show-toplevel"], { allowFail: true }).trim();
    const rel = top ? relative(top, resolvePath(cwd, file)).replace(/\\/g, "/") : "";
    const filtered = rel && !rel.startsWith("..")
      ? spawnSync("git", ["cat-file", "--filters", `--path=${rel}`, full], { cwd, encoding: null, maxBuffer: 1 << 30, windowsHide: true })
      : null;
    data = filtered && filtered.status === 0 ? filtered.stdout : readObjects(cwd, [full], Number.MAX_SAFE_INTEGER).get(full);
  }
  else if (type === "commit") data = Buffer.from(git(cwd, ["show", "--stat", "--patch", full]));
  else throw new Error(`${id} is a ${type}; restore takes a file content or a commit`);
  if (!data) throw new Error(`could not read ${id}`);
  writeFileSync(file, data, { flag: "wx" });
  return { type, bytes: data.length, sha: full };
}
