<div align="center">

# git-rescue

**What just happened to my git repository, and how do I get my work back?** One command looks at the
repository's state and says what is wrong, with the exact commands that fix it. It finds what the reflog
cannot: files you staged and lost to `reset --hard`, dropped stashes. And it backs up before every fix.

<a href="https://github.com/zch6a/git-rescue/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/zch6a/git-rescue/actions/workflows/ci.yml/badge.svg"></a>
<img alt="Node 18+" src="https://img.shields.io/badge/node-18%2B-339933?logo=node.js&logoColor=white">
<img alt="No dependencies" src="https://img.shields.io/badge/dependencies-none-2ea44f">
<a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue"></a>

**English** · [简体中文](README.zh-CN.md)

</div>

---

```bash
npx github:zch6a/git-rescue
```

After a `reset --hard HEAD~2`, deleting a branch with `-D`, and losing a staged file:

```text
~/projects/app: on main, nothing uncommitted

! 1. 2 commits fell off main with a reset (moving to HEAD~2) just now
     main was at fe34db98 before; no branch has those commits now.
     a) Keep them on a new branch "rescued/main-before-reset-20261112-0953" (main stays as it is)  [safe]
          git branch rescued/main-before-reset-20261112-0953 fe34db986f39f7a69b51baa25ebd023826bf043f
     b) Put main back where it was (fe34db98)  [careful]
          git checkout main
          git reset --keep fe34db986f39f7a69b51baa25ebd023826bf043f

! 2. Branch "experiment" was deleted with 1 commit no other branch has
     a) Bring "experiment" back  [safe]
          git branch experiment 26bd2348d7043eff7c551ea7e4dfcf974f1b93da

! 3. 1 file version that you added (staged) but never committed
     a) Look at them and save the ones you want  [you do it]

Fix one? Type its number and letter (like 1a), or press Enter to leave everything as it is:
```

```text
$ git-rescue find invoice
"invoice" in lost work:

  169672f8  a file you staged and never committed, line 1
      TODO: call the bank about the invoice

$ git-rescue restore 169672f8 notes.md
Saved the file (38 bytes) to notes.md.
```

## What it finds

It reads the repository's state, not timing guesses: each finding is something that is the case, with the
commits it concerns.

- **An operation stopped halfway**: a rebase, `am`, merge, cherry-pick or revert waiting on conflicts (which
  files), a bisect left running. Options: abandon it (back exactly to before), or finish it.
- **A stale `.git/index.lock`** that makes git refuse everything.
- **Commits on no branch**: a detached HEAD with commits, or commits left behind when you switched away from
  one.
- **Commits that fell off a branch**: a `reset`, a rebase, a forced pull; an amend (as information).
- **A deleted branch** whose commits no other branch has (merged branches are not reported).
- **A dropped stash** (`stash drop`, `stash clear`): back onto the stash list.
- **Files you staged and never committed**, lost to `reset --hard` or `checkout .`: the reflog cannot see
  these; git still has their contents until `git gc` prunes them (about two weeks).
- **An upstream someone force-pushed**: your branch still has the old history, and pulling would merge it
  back in; the option replays only your own commits onto the new one.

## Use

```bash
git-rescue                  # what is wrong here; pick a fix (it asks before changing anything)
git-rescue timeline         # what happened recently, in words, with where things were before each step
git-rescue lost             # everything git can still give back
git-rescue find "some text" # search lost work: staged files, the files of lost commits, their messages
git-rescue restore ID FILE  # save a lost file (or a lost commit's diff) to a new file; never overwrites
git-rescue undo             # undo what git-rescue last did
git-rescue fix 1a --yes     # apply option a of problem 1 without the menu (for scripts)
git-rescue --dry-run        # show, change nothing;  --json for scripts;  -C path for another folder
```

Install the command with `npm install -g github:zch6a/git-rescue`, or run it once with `npx` as above.
It needs Node 18+ and git (tested with git 2.19, from 2018, and the current one).

## Safe to run

- **It changes nothing without asking.** The report and `timeline`, `lost` and `find` only read. A fix
  shows its exact git commands first and runs them only after you say yes (or with `--yes`).
- **Before any fix it backs up** every branch, HEAD and your uncommitted changes (as `git stash` would,
  without touching your files) under `refs/rescue/<time>/`, plain refs that `git gc` keeps and plain git
  can read. `git-rescue undo` puts the branches and HEAD back and offers your saved changes again. (Two
  limits: untracked files are not in that snapshot, though no fix touches them; and while files are in
  conflict, git cannot snapshot uncommitted changes, which git-rescue then says.)
- **Options are rated**: *safe* (nothing that a plain git command cannot undo), *careful* (moves a branch
  or your files; backed up first), *you do it* (resolving a conflict).
- `restore` writes only to a new file name.
- Local only: no network, no telemetry, no dependencies.

## What it does not do

- It cannot bring back what git never had: changes you never added or committed, before a
  `checkout .` or `reset --hard`. (Your editor's local history may have them.)
- After `git gc` has pruned them (objects no reflog reaches: about two weeks; reflog entries: 30 to 90
  days), lost commits and files are gone for good.
- It does not rewrite published history for you: when a fix would need a force push, it says so and
  leaves that to you.

## Status

0.1, in development. Tested with throwaway repositories made in the system's temp folder (never a real
one): every finding above is staged for real (a reset, a deleted branch, a dropped stash, a conflicted
merge and rebase, a stale lock, a force-pushed remote), then the fix is applied through the command and
undone again. On git 2.19 here, and on the git of GitHub's Windows, macOS and Linux runners in CI.

## Develop

```bash
npm install
npm test            # node --test
npm run check       # type-check the JavaScript (JSDoc types, tsc)
```

## License

[MIT](LICENSE)
