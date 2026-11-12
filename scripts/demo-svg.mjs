// Makes docs/demo.svg, the animated terminal at the top of the README, from REAL output: an accident is staged in a
// new repository under the system temp folder (never anywhere else), git-rescue is run on it, and what it printed
// is played back line by line. node scripts/demo-svg.mjs
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "git-rescue-demo-"));
const home = join(base, "home");
mkdirSync(home);
writeFileSync(join(home, ".gitconfig"), "[advice]\n\tdetachedHead = false\n");
const env = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), NO_COLOR: "1",
  GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.invalid", GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@example.invalid" };
const repo = join(base, "app");
mkdirSync(repo);
if (!repo.startsWith(tmpdir())) throw new Error("only under the temp folder");
const git = (/** @type {string[]} */ ...a) => { const r = spawnSync("git", a, { cwd: repo, env, encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); };
const commit = (/** @type {string} */ f, /** @type {string} */ text, /** @type {string} */ msg) => { writeFileSync(join(repo, f), text); git("add", f); git("commit", "-qm", msg); };
const rescue = (/** @type {string[]} */ ...a) => spawnSync(process.execPath, [join(root, "bin", "git-rescue.js"), "-C", repo, ...a], { env, encoding: "utf8", input: "" }).stdout;

git("init", "-q"); git("symbolic-ref", "HEAD", "refs/heads/main");
commit("parser.js", "v1\n", "add the parser");
commit("parser.js", "v2\n", "parser handles quotes");
commit("parser.js", "v3\n", "parser handles escapes");
git("reset", "-q", "--hard", "HEAD~2");
writeFileSync(join(repo, "notes.md"), "TODO: call the bank about the invoice\n");
git("add", "notes.md");
git("reset", "-q", "--hard");

// What is shown: the accident as typed, then git-rescue's own output, trimmed of the long hints.
const report = rescue().replace(/^.*: on main/m, "~/app: on main").split("\n");
const keep = report.filter((l) => !/To apply one|^\s+--keep refuses|^\s+backs them up|^\s+`git-rescue find|^\s+\(git-rescue restore/.test(l));
const fix = rescue("fix", "1a", "--yes").split("\n").filter((l) => /✓|Done/.test(l));
const found = rescue("find", "invoice").split("\n").filter((l) => /169672f8|TODO/.test(l));
rmSync(base, { recursive: true, force: true });

/** @type {{text: string, kind: "cmd" | "out", gap?: number}[]} */
const lines = [
  { text: "git reset --hard HEAD~2      # oops", kind: "cmd" },
  { text: "git-rescue", kind: "cmd", gap: 0.6 },
  ...keep.filter((l, i, a) => l.trim() || (a[i - 1] ?? "").trim()).map((text) => ({ text, kind: /** @type {const} */ ("out") })),
  { text: "git-rescue fix 1a --yes", kind: "cmd", gap: 0.8 },
  ...fix.map((text) => ({ text, kind: /** @type {const} */ ("out") })),
  { text: "git-rescue find invoice", kind: "cmd", gap: 0.8 },
  ...found.map((text) => ({ text, kind: /** @type {const} */ ("out") })),
];

const esc = (/** @type {string} */ s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const W = 920, LH = 19, TOP = 44, PAD = 18;
const H = TOP + lines.length * LH + PAD;
const colour = (/** @type {string} */ t) => /^! \d/.test(t) ? "warn" : /^✗/.test(t) ? "bad" : /^· \d/.test(t) ? "info" : /\[safe\]|✓/.test(t) ? "ok" : /\[careful\]/.test(t) ? "warn"
  : /^\s{10}git /.test(t) ? "code" : /^\s{7}[0-9a-f]{8} /.test(t) ? "dim" : "";
let t = 0.4;
const rows = lines.map((l, i) => {
  t += l.gap ?? (l.kind === "cmd" ? 0.5 : 0.07);
  const y = TOP + i * LH;
  if (l.kind === "cmd") {
    const typing = Math.max(0.4, l.text.length * 0.035);
    const row = `<g class="l" style="animation-delay:${t.toFixed(2)}s"><text x="${PAD}" y="${y}" class="p">$</text>` +
      `<text x="${PAD + 16}" y="${y}" class="cmd"><tspan class="type" style="animation-delay:${t.toFixed(2)}s;animation-duration:${typing.toFixed(2)}s;--n:${l.text.length}">${esc(l.text)}</tspan></text></g>`;
    t += typing + 0.25;
    return row;
  }
  return `<text x="${PAD}" y="${y}" class="l ${colour(l.text)}" style="animation-delay:${t.toFixed(2)}s" xml:space="preserve">${esc(l.text)}</text>`;
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="git-rescue finding two lost commits after a reset --hard, keeping them on a branch, and finding a lost staged file">
<style>
  .bg { fill: #14161a; } .bar { fill: #1d2026; }
  text { font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; fill: #d7dae0; white-space: pre; }
  .p { fill: #7ee787; } .cmd { fill: #ffffff; font-weight: 600; }
  .warn { fill: #f0c674; } .bad { fill: #ff7b72; } .ok { fill: #7ee787; } .info { fill: #8b949e; } .code { fill: #79c0ff; } .dim { fill: #a5adba; }
  .l { opacity: 0; animation: show .01s linear forwards; }
  .type { clip-path: inset(0 100% 0 0); animation-name: type; animation-fill-mode: forwards; animation-timing-function: steps(var(--n)); }
  @keyframes show { to { opacity: 1; } }
  @keyframes type { to { clip-path: inset(0 -25% 0 0); } } /* past the end: a stepped animation stops a character short */
  @media (prefers-reduced-motion: reduce) { .l { animation: none; opacity: 1; } .type { animation: none; clip-path: none; } }
</style>
<rect class="bg" width="${W}" height="${H}" rx="10"/>
<rect class="bar" width="${W}" height="28" rx="10"/><rect class="bar" y="18" width="${W}" height="10"/>
<circle cx="18" cy="14" r="5.5" fill="#ff5f57"/><circle cx="36" cy="14" r="5.5" fill="#febc2e"/><circle cx="54" cy="14" r="5.5" fill="#28c840"/>
<text x="${W / 2}" y="18" text-anchor="middle" class="info">~/app</text>
${rows.join("\n")}
</svg>
`;
mkdirSync(join(root, "docs"), { recursive: true });
writeFileSync(join(root, "docs", "demo.svg"), svg);
console.log(`docs/demo.svg: ${lines.length} lines, plays for ${t.toFixed(1)} s`);
