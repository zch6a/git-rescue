// @ts-check
/**
 * Throwaway repositories in the system's temp folder, with git's home and config pointed there too: the tests
 * never touch a real repository or the user's git settings.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), "git-rescue-test-")));
const HOME = join(SANDBOX, "home");
mkdirSync(HOME);
Object.assign(process.env, {
  HOME,
  USERPROFILE: HOME,
  XDG_CONFIG_HOME: join(HOME, ".config"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: join(HOME, ".gitconfig"),
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  NO_COLOR: "1",
});
writeFileSync(join(HOME, ".gitconfig"), "[core]\n\tautocrlf = false\n[advice]\n\tdetachedHead = false\n");

let n = 0;

/** A new empty folder in the sandbox. @param {string} [name] */
export function folder(name = "repo") {
  const dir = join(SANDBOX, `${name}-${++n}`);
  mkdirSync(dir);
  return dir;
}

/** Runs git in a sandbox folder (and refuses anywhere else). @param {string} dir @param {...string} args */
export function git(dir, ...args) {
  if (!resolve(dir).startsWith(SANDBOX)) throw new Error(`refusing to run git outside the test sandbox: ${dir}`);
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: process.env });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** A repository with one commit on main. */
export function repo() {
  const dir = folder();
  git(dir, "init", "-q");
  git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
  commit(dir, "README.md", "hello\n", "first");
  return dir;
}

/** Writes a file and commits it. @param {string} dir @param {string} file @param {string} content @param {string} message */
export function commit(dir, file, content, message) {
  writeFileSync(join(dir, file), content);
  git(dir, "add", file);
  git(dir, "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

/** The repository as git-rescue sees it. @param {string} dir */
export async function at(dir) {
  const { repoAt } = await import("../src/git.js");
  const r = repoAt(dir);
  if (!r) throw new Error(`not a repository: ${dir}`);
  return r;
}

const BIN = fileURLToPath(new URL("../bin/git-rescue.js", import.meta.url));

/** Runs the git-rescue command. @param {string} dir @param {...string} args */
export function cli(dir, ...args) {
  if (!resolve(dir).startsWith(SANDBOX)) throw new Error(`refusing to run outside the test sandbox: ${dir}`);
  const r = spawnSync(process.execPath, [BIN, "-C", dir, ...args], { encoding: "utf8", env: process.env, input: "" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
