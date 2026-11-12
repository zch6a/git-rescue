# Contributing

Thanks for helping. A few things matter more here than in most projects, because git-rescue works on
repositories people are already worried about.

## Never on a real repository

Tests create throwaway repositories in the system's temp folder, with git's home and config pointed there too
(`test/helpers.js`). The helpers refuse to run git or git-rescue anywhere else. Keep it that way: a new test
builds its own repository and stages the accident for real (`reset --hard`, `stash drop`, a conflicted merge)
rather than using any existing checkout.

## Old git

git-rescue supports git 2.17 and later, because people in trouble are often on an old machine. Use only
long-standing commands and flags (no `git switch`, `git restore`, `cherry-pick --skip`, `worktree add -q`), and
read files whose format has not changed (reflogs) rather than newer porcelain. CI runs on the git of GitHub's
Windows, macOS and Linux runners; check locally with an old git if you can.

## Findings are facts

A finding states something that is the case, with the commits it is about. No guesses from timing. Every new
finding needs a test that it is reported, and tests that the common situations that look like it (a routine
rebase, a `stash pop`) are not.

## Options

Each option lists the exact git commands before anything runs, has a risk (`safe`, `careful`, `manual`), and is
undoable with `git-rescue undo`. git-rescue never pushes and never deletes what it cannot back up.

## Running

```bash
npm install
npm test            # node --test
npm run check       # type-check the JavaScript (JSDoc types, tsc)
```

No runtime dependencies, please: `npx github:zch6a/git-rescue` should run anywhere Node 18+ does.
