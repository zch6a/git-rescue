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
