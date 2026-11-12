# Polish log

## Development — 2026-11-12

**What it is for.** "How do I undo X" questions are the most upvoted git questions there are. The answer is usually somewhere in the reflog, which is hostile to read when you are worried. Existing tools: gitpanic (TypeScript; detects disasters from the reflog and timing heuristics such as "committed less than 2 minutes ago", and walks you through options), git-undo (reverses a past operation picked from the reflog), git_oops (recovers deleted commits). What they leave out is what the reflog cannot see: files you staged and then lost to `reset --hard` or `checkout .`, and dropped stashes. git still has both as unreachable objects until `git gc` prunes them, about two weeks.

**Design**
- **State, not guesses.** Each finding is a fact with the commits it concerns: files git leaves during an operation (`MERGE_HEAD`, `rebase-merge/`, `CHERRY_PICK_HEAD`, `BISECT_LOG`), an old `index.lock`, the reflogs (read from their files, whose format has not changed in years), and `git fsck --unreachable` (read-only; not `--lost-found`, which writes files). Findings: an operation stopped halfway (with the conflicted files), a stale lock, a detached HEAD with commits, commits left behind on one, commits that fell off a branch (reset, rebase, forced pull; an amend as information), a deleted branch whose commits no other branch has (merged ones are not reported), a dropped stash (recognised by its message and its index parent), staged contents never committed (unreachable blobs that are not part of an unreachable commit's tree), an upstream someone force-pushed (`forced-update` in the remote-tracking reflog).
- **Options with exact commands and a risk**: safe (a plain git command undoes it), careful (moves a branch or files), you do it (resolve a conflict). Shown before anything runs; run after a yes, or with `--yes`; stopped at the first failure.
- **A backup before every fix**: every branch, HEAD, and a `git stash create` snapshot of the index and working tree, under `refs/rescue/<time>/` (refs, so `git gc` keeps them), noted in `.git/rescue.log`. `git-rescue undo` moves the branches and HEAD back (`reset --keep` for the checked-out branch, which refuses to overwrite uncommitted work) and offers the snapshot again.
- **Search and restore**: `lost` lists commits only reflogs keep, commits nothing reaches, and staged contents (with the loose object's time, size and first line); `find` searches all of that, including the files of lost commits with their paths; `restore` writes one to a new file and never overwrites.
- **Old git**: only long-standing commands (no `switch`, `restore`, `cherry-pick --skip`), because this laptop runs git 2.19 (2018), a fair stand-in for what people have on old machines. No dependencies; plain JavaScript type-checked with JSDoc and `tsc` (no build step, so `npx github:zch6a/git-rescue` runs it).

**Found while building**
- Reading object contents asked Node for `encoding: "buffer"`, which Node 24 rejects: `restore` and `find` failed on every lost file. Now `null` (bytes).
- During a conflicted merge, `git stash create` prints "README.md: needs merge" instead of an id, and the backup tried to store that as a ref. Now only an id is accepted; without one, git-rescue says your uncommitted changes could not be backed up, and the merge option says so before you choose it.
- Errors in a fix escaped as a crash with a stack trace: `main()` returned the async commands without `await`, so its `try` never saw them.
- Starting the command through a file-name check would have done nothing when npm links the command on macOS and Linux; a separate `bin/` file calls `main()`.

**Tests** (20): each in a throwaway repository in the system's temp folder, with git's home and config pointed there too, and a guard that refuses to run anywhere else. Every finding is staged for real (a reset, a deleted branch, commits on a detached HEAD, a dropped stash, a staged file lost to `reset --hard`, a conflicted merge and rebase, a stale lock, a remote force-pushed by another clone, an amend), the fix is applied through the command, and the result checked; a fix is undone with `undo`; nothing changes without `--yes` when there is no terminal to ask in; a dry run changes nothing; `restore` refuses to overwrite.

**Open for the polishing rounds**
- An independent review.
- Commits made on a deleted branch after you last left it are not in HEAD's reflog (only in the deleted branch's own, which git deletes with it); they show in `lost` as unreachable, not as a "deleted branch".
- Worktrees, submodules, a repository mid-`git gc`.

## Round 1 — 2026-11-12

**Independent review.** A reviewer new to the code tried to break it, only in throwaway repositories (git 2.19, Node 24), and reproduced 14 of 15 findings. All fixed; `test/review.test.js` holds 16 regression tests, and all 15 that cover the review fail on the code before (one of them by hanging until its 30-second limit, waiting for an editor).

- **"Abandon the rebase" was rated safe and threw away conflict work.** An abort resets the files, and git cannot snapshot files in conflict, so a half-written resolution was gone for good. Now aborts are rated careful, and when git cannot snapshot, the backup copies every changed file as it is to `.git/rescue-files/<time>/`.
- **`undo` reset every branch to the backup**, wiping commits made since on branches the fix never touched. Now the state after the fix is recorded too, and undo reverses only what the fix changed (a branch moved, made or deleted; HEAD), leaving alone and naming whatever moved since. Options that start with something the user does no longer make a backup (so they cannot become "the last thing" to undo).
- **Around 800 reflog entries or lost commits crashed `lost`, `find` and the report** (Windows' command-line limit), after up to 100 s of one `git cat-file` per id. Now ids go through stdin (`rev-list --stdin`, `cat-file --batch-check`, `log --no-walk --stdin`) and the diagnosis finds all lost commits in one batch; `fsck --connectivity-only` lists the same objects about 11 times faster.
- **False alarms**: every rebase and `pull --rebase` ("N commits fell off"), every `stash pop` ("a dropped stash", offering to put back an applied stash), adding a file twice or resolving a merge (git writes the conflict-marked file to the object store), and an upstream force-push long after it was dealt with. Now commits are compared by patch (`git cherry`; an amend against the commit that replaced it), a stash whose files are in HEAD, the index or the working tree counts as applied, blobs with conflict markers are left out and the rest are information, and the upstream finding needs the old history to still be on the branch.
- **Missed losses**: `branch -f`, `checkout -B`, a reset while detached. Now every reflog move that leaves commits on no ref is judged, whatever its message; HEAD's reflog is read only for moves made while detached (those in a branch's reflog are judged there).
- **Wrong steps**: conflicted files with non-ASCII names got a quoted `git add` that failed (now `status -z`); "finish it" steps opened an editor no one could see (now `GIT_EDITOR=true`); two findings could propose the same rescue branch name (now the name carries the commit).
- **Worktrees**: git 2.19's fsck ignores other worktrees' HEADs and indexes, so their work looked lost; and undo from another worktree moved a branch checked out there. Now other worktrees' HEADs and staged files count as kept, and undo refuses outside the worktree where the fix ran and skips branches checked out elsewhere.
- **Smaller**: a bare repository was "not a git repository"; `lost` listed `stash@{1}` and notes as lost (now every ref under `refs/` but the backups, every stash, and not HEAD: `--all` counts HEAD, which hid commits on a detached HEAD); `restore` ignored line-ending conversion (now `cat-file --filters` for the target name); the old-git warning went to stdout; `find --json` exited 0 with no match. The README said a fix that needs a force push is flagged: no such check existed; now it says git-rescue never pushes.

Found while fixing: the first version of "other worktrees keep commits" counted this worktree's own HEAD, so commits on the current detached HEAD looked kept; and `git worktree add -q` does not exist in git 2.19 (the test now runs without it).

**Tests**: 36 (+16). CI: Windows, macOS and Linux, Node 18 and 24.

**Open**
- Submodules (a submodule's own repository is a separate case); a repository in the middle of `git gc`.
- A second review in a later round.
