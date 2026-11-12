// @ts-check
// The Agent Skill (plugin/skills/git-rescue/SKILL.md) and the Claude Code plugin around it: the format, and that
// every command the skill tells an AI to run works, run here on a staged accident.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { cli, commit, git, repo } from "./helpers.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKILL = readFileSync(join(ROOT, "plugin", "skills", "git-rescue", "SKILL.md"), "utf8").replace(/\r\n/g, "\n");

/** The frontmatter as key: value (one level; nested maps kept as their first line). */
function frontmatter() {
  const m = SKILL.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, "the frontmatter starts on the first line");
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-z-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

test("the skill's frontmatter: portable fields only, within the limits", () => {
  const fm = frontmatter();
  assert.equal(fm.name, "git-rescue", "the name matches its folder");
  const allowed = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);
  for (const k of Object.keys(fm)) assert.ok(allowed.has(k), `${k} is a field every skill host accepts`);
  assert.ok(fm.description.length > 100 && fm.description.length <= 1536, `description length ${fm.description.length}`);
  assert.doesNotMatch(fm.description, /[<>]/);
  assert.ok(fm.compatibility.length <= 500);
  assert.ok(SKILL.split("\n").length < 500);
});

test("the plugin and its marketplace agree, and follow the package version", () => {
  const market = JSON.parse(readFileSync(join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
  const plugin = JSON.parse(readFileSync(join(ROOT, "plugin", ".claude-plugin", "plugin.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(market.plugins.length, 1);
  assert.equal(market.plugins[0].name, plugin.name, "entry name = manifest name");
  assert.ok(existsSync(join(ROOT, market.plugins[0].source, ".claude-plugin", "plugin.json")));
  assert.equal(plugin.version, pkg.version);
});

/** The commands in the skill's bash blocks, with the npx prefix taken off. */
function skillCommands() {
  const blocks = [...SKILL.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
  return blocks.flatMap((b) => b.split("\n")).filter((l) => l.startsWith("npx -y github:zch6a/git-rescue")).map((l) => l.replace("npx -y github:zch6a/git-rescue", "").trim());
}

/** Splits a command line into arguments, keeping "quoted text" together. @param {string} line */
const argv = (line) => [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);

test("every command the skill uses works, in the order an AI would run them", () => {
  const commands = skillCommands();
  assert.deepEqual(commands.map((c) => argv(c)[0] ?? "(report)"), ["--json", "timeline", "fix", "undo", "find", "restore"]);

  const dir = repo();
  commit(dir, "parser.js", "v1\n", "parser handles quotes");
  git(dir, "reset", "-q", "--hard", "HEAD~1");
  writeFileSync(join(dir, "notes.md"), "call the bank about the invoice\n");
  git(dir, "add", "notes.md");
  git(dir, "reset", "-q", "--hard");

  // 1. Diagnose: the fields the skill names are there.
  const report = cli(dir, ...argv(commands[0]));
  assert.equal(report.code, 1);
  const json = JSON.parse(report.out);
  const finding = json.findings.find((/** @type {{id: string}} */ f) => f.id === "dropped-by-reset");
  for (const k of ["id", "key", "level", "title", "detail", "commits", "options"]) assert.ok(k in finding, k);
  for (const k of ["title", "risk", "steps"]) assert.ok(k in finding.options[0], k);
  // 2. What happened.
  assert.equal(cli(dir, ...argv(commands[1])).code, 0);
  // 3. Fix by key, as the skill shows it.
  const fix = cli(dir, ...argv(commands[2].replace("<key>/<letter>", `${finding.key}/a`)));
  assert.equal(fix.code, 0, fix.out + fix.err);
  assert.match(git(dir, "branch", "--list", "rescued/*"), /rescued\//);
  // 4. Undo.
  assert.equal(cli(dir, ...argv(commands[3])).code, 0);
  assert.equal(git(dir, "branch", "--list", "rescued/*"), "");
  // 5. Find a lost file by its text, and restore it to a new file.
  const found = cli(dir, ...argv(commands[4].replace("some text they remember", "the invoice")));
  assert.equal(found.code, 0);
  const match = JSON.parse(found.out).matches[0];
  for (const k of ["sha", "where", "line", "text"]) assert.ok(k in match, k);
  const restored = cli(dir, ...argv(commands[5].replace("<id>", match.sha.slice(0, 8)).replace("<new-file-name>", join(dir, "notes-restored.md"))));
  assert.equal(restored.code, 0, restored.err);
  assert.equal(readFileSync(join(dir, "notes-restored.md"), "utf8"), "call the bank about the invoice\n");
});
