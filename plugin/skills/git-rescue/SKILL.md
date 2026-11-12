---
name: git-rescue
description: Recover from git accidents with git-rescue. Use when the user says they messed up git or lost work, for example after reset --hard, a deleted branch, a dropped stash, a rebase or merge stuck or gone wrong, commits on a detached HEAD, files they staged and then lost, or "how do I undo that". It diagnoses the repository, explains what happened, and applies a fix only after the user agrees, with a backup and an undo.
license: MIT
compatibility: Needs Node 18+ and git 2.17+ on the machine. Runs git-rescue with npx from GitHub (github:zch6a/git-rescue) unless a git-rescue command is installed.
metadata:
  homepage: https://github.com/zch6a/git-rescue
---

# Getting someone's work back with git-rescue

git-rescue reads a repository's state (reflogs, the files git leaves mid-rebase or merge, objects nothing points
to) and reports what went wrong, each finding with the commits involved and options with exact git commands. It
changes nothing unless told to, backs up every branch, HEAD and uncommitted work before a fix, and can undo it.

## First: do not destroy the evidence

Until the diagnosis is done, do not run anything that rewrites refs or deletes objects: no `git gc`, `git prune`,
`git reflog expire`, `git reset`, `git checkout -- .`, `git clean`, `git stash drop`, `git rebase --abort`. Lost
commits and staged files live as objects that `gc` deletes. If an operation is stuck halfway, leave it as it is:
git-rescue reports it and saves the edits before abandoning it.

## 1. Diagnose

In the repository the user means (use `-C <path>` if it is not the current directory):

```bash
npx -y github:zch6a/git-rescue --json
```

Use `git-rescue --json` instead if the command is installed. The output is one JSON object:
`{format, version, state, findings}`. Exit status 0 means nothing wrong, 1 something to look at, 2 could not run
(not a repository, or no Node/git; tell the user).

Each finding has `id`, `key`, `level` (`problem`, `warning`, `info`), `title`, `detail`, `commits`, and
`options`; each option has `title`, `risk` (`safe`, `careful`, `manual`) and `steps` (git's arguments, one list per
command; a one-string step with spaces is something the person does).

## 2. Explain before acting

Tell the user, in plain words, what each finding means for them, most serious first: which commits or files are
at stake (the `detail` names them), and the options with their risk. `info` findings are usually harmless. If
nothing is wrong, say so. To show what happened recently, in words (each event with where things were before it):

```bash
npx -y github:zch6a/git-rescue timeline --json
```

Recommend the option that matches what they want (usually the `safe` one: keep the commits on a new branch, put a
deleted branch back, restore a stash). Show the exact commands from its `steps`.

## 3. Apply only with the user's yes

Never apply a fix without the user explicitly agreeing to that option. Then apply it by its **key** (numbers shift
after each fix; a key names the same finding or is refused):

```bash
npx -y github:zch6a/git-rescue fix <key>/<letter> --yes
```

For example `fix dropped-by-reset:39f66d49/a --yes`. Report what it printed. Exit 0 means done; 1 means a step
failed or the next step is the user's (for example resolving conflicts: guide them through it); 2 means the key is
no longer there (run the diagnosis again).

After a fix, tell the user it can be taken back:

```bash
npx -y github:zch6a/git-rescue undo --yes
```

Run `undo` only when they ask. It puts back exactly what the fix changed and leaves later work alone.

## Lost files: search and restore

Files the user staged (`git add`) and then lost to `reset --hard` or `checkout .` are in the report as
`lost-staged-files`. Find one by a piece of text they remember, then save it to a **new** file (restore never
overwrites):

```bash
npx -y github:zch6a/git-rescue find "some text they remember" --json
npx -y github:zch6a/git-rescue restore <id> <new-file-name>
```

`find --json` gives `{format, version, text, matches}`; each match has `sha` (the id), `where`, `line`, `text`.

## Rules

- git-rescue never pushes and never fetches. If a fix rewrote commits that were already pushed, tell the user
  that pushing again needs `git push --force-with-lease` and that it is their call.
- Do not delete `refs/rescue/*`, `.git/rescue.log` or `.git/rescue-files/`: they are the backups.
- Files the user never added or committed before a `reset --hard` or `checkout .` cannot come back from git; their
  editor's local history may still have them.
