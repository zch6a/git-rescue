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

Found while fixing: the first version of "other worktrees keep commits" counted this worktree's own HEAD, so commits on the current detached HEAD looked kept; `git worktree add -q` does not exist in git 2.19 (the test now runs without it); and on GitHub's Windows runners `restore` still wrote LF, because the temp folder is reached by its short name (`RUNNER~1`) while git reports the long one, so comparing the two paths put the file "outside" the repository. Now git itself says where the target's folder is in the repository (reproduced here through a short name, then fixed).

**Tests**: 36 (+16). CI: Windows, macOS and Linux, Node 18 and 24.

**Open**
- Submodules (a submodule's own repository is a separate case); a repository in the middle of `git gc`.
- A second review in a later round.

## Round 2 — 2026-11-12 (0.2.0)

**How it was checked.** Every command was run, as someone in trouble would, on repositories staged in the temp folder: a path with spaces and Chinese characters (a reset, a deleted branch, a dropped stash, a lost staged file), a parent repository with a submodule that lost commits, a submodule detached at its recorded commit, and a repository with 30,000 commits and 3,000 unreachable loose blobs. Each git call was timed by wrapping `spawnSync`.

**What the report said, and now says**
- "2 commits fell off main" without saying which: the user had to run `lost` and guess. Now each finding lists the commits (id and subject, the newest five), a dropped stash the files it changed, the lost-staged finding the first line of the newest five; its only "step" used to be "run git-rescue lost", now `git-rescue restore <id> <new-file-name>`.
- Detail lines ran to 200 columns; now wrapped to the terminal (at most 100), lists kept as they are.
- `lost` listed a stash's inner "index on main" commit as a separate lost commit; now only the stash.
- `timeline` showed "reset to HEAD" twice after a `git stash` with no explanation; now "dropped or unstaged uncommitted changes (reset to HEAD: `reset --hard`, `git stash`)". Messages from git 2.19 and newer git that were shown raw now have words: `rebase finished:`, `rebase: <subject>`, `pull origin main:`, `pull --rebase (...)`, `am:`, `clone:`, `Branch: renamed`, `commit (cherry-pick)`, a merge commit's "Merge made by the 'recursive' strategy."
- A stash popped and then edited further is, by git's records, the same as one dropped (both delete the reflog entry); the finding now says so instead of only "dropped".

**Bugs**
- **Run from a subfolder, a popped stash was reported as dropped**: the working-tree check hashed paths relative to the top folder from the current one. Reproduced on the 0.1 code with a test; now hashed from the top folder.
- **Credentials**: `git clone https://user:token@host/...` and `git pull <url>` write the URL into the reflog, and `timeline` (and its JSON `raw` field) printed it. Now the user part of any URL is shown as `***`.
- **Command line**: a mistyped or missing path after `-C` gave "could not run git rev-parse: spawnSync git ENOENT" (PowerShell drops an empty argument, so the next word became the path); an unknown option such as `--jsn` was taken for a command; `-n abc` became NaN. Each now says what is wrong. `--` ends the options (`find -- -x`); `-C` given twice: the last counts.

Found while testing, in my own scenario script: it used `init.defaultBranch`, which git 2.19 ignores, so the scenario failed, the folder came back empty, and git-rescue's read-only report ran on this project's own repository. Nothing was changed (no fix runs without `--yes`), but it broke the rule that git-rescue is only ever run on throwaway repositories; every later run went through a wrapper that refuses any folder outside the temp folder.

**Submodules**: in a submodule, a HEAD detached at the commit the parent records was "HEAD is detached" with an offer to go back to main, which would make the parent see a changed submodule. Now it is information without options ("that is how git leaves a submodule"). The parent names its submodules (from `.gitmodules`) and that each is checked on its own; a submodule names its parent.

**Performance** (30,000 commits, 3,000 lost loose blobs, Windows): report 4.9 → 3.0 s, `lost` 4.6 → 3.6 s, `find` 6.5 → 3.5 s. Starting a git program costs 30 to 90 ms here; `for-each-ref` ran four times per report and `rev-parse --show-toplevel` three, so answers that cannot change while git-rescue only reads are kept for the command (and dropped before and after anything is changed). Whether a stash was applied took up to four git calls per file (`rev-parse` for the stash's, HEAD's and the index's version, `hash-object`): now three per stash (`cat-file --batch-check` takes `rev:path` names, `hash-object` takes many files). `lost` and `find` read every lost blob twice. The rest is git reading loose objects: 1.1 s for 3,000 in `cat-file --batch`, and 2.9 s for Node to open and inflate them itself, so that was not the way; the report now reads only the newest 300 (stat-ing 3,000 loose objects to sort them costs 68 ms) and counts the rest.

**--json**: every command prints one object with `format` (1) and `version`; the shape is in the README with the rule for changing it, and a test pins the field names.

**Docs and project**: README example regenerated from a real run; CHANGELOG.md and CONTRIBUTING.md (never on a real repository, old git, findings are facts); `npm pack` contents checked (11 files, 34 kB; CHANGELOG added). `npm audit` could not reach its endpoint; there are no runtime dependencies.

**Tests**: 44 (+8, `test/round2.test.js`). The first CI run failed on macOS only: the line-length test counted the header, which is the repository's path, and macOS temp paths are long (`/private/var/folders/...`); the header is now left out of that check.

**Open**
- A repository in the middle of `git gc` (objects being packed while fsck reads).
- Many submodules: the parent only names them; checking them all from the parent.
- A second independent review (round 4 or 5).

## Round 3 — 2026-11-12 (0.3.0)

**Every option, run for real.** `test/matrix.test.js` stages each of the 18 kinds of finding in a fresh repository (with an uncommitted edit to another file where the situation allows one), applies every option git-rescue runs with `fix --yes`, and checks three things: the finding is gone, the edit survived, and `undo --yes` puts every branch and HEAD back exactly. Until now only some options had an end-to-end test. It found two bugs on the first run:
- **On a detached HEAD, "Go back to main" ran `git checkout "(HEAD detached at a03eab6)"`** and failed: git 2.19's `branch --contains --format` lists that line among the branches. Now `for-each-ref --contains ... refs/heads`.
- **`checkout -B` was reported as "`branch -f`"**: git writes "branch: Reset to ..." for both. Now said as either.

**The menu, as a person uses it.** The Terminal panel can start a command but not type into it, so `test/menu.test.js` runs the real CLI with stdin marked as a terminal (a `--import data:` one-liner) and pipes the answers. Found: **an answer typed ahead was lost**. Typing "1a", Enter, "y", Enter faster than git-rescue asked lost the "y" (readline's `question()` drops lines that arrive with no question pending); git-rescue then waited for an answer that had come, and when the input ended it exited 0 having done nothing and said nothing. Now typed lines wait in a queue for their question, and the end of the input is a no ("No answer: nothing changed.", exit 1). In the real terminal (Terminal panel, a repository staged in the temp folder) the report and the prompt look as intended.

**Edge cases staged in the temp folder**
- **An expired reflog, and a bare repository after a force push** (bare repositories keep no reflog): the lost commits were only in `lost`; the report said "Nothing looks wrong". New finding "commits that nothing points to, not even the reflog", one option per line of history; commits whose patch is already on HEAD (an old rebase whose reflog expired) are left out, so old rebases do not come back as alarms.
- **`git gc` running**: it deletes exactly what git-rescue finds, once two weeks old. New finding when a `gc.pid` younger than 12 hours (git's own limit) is there; a warning when something is at stake, else information.
- **The user's git config**: with `color.ui=always`, `format.pretty=oneline` and `diff.external`, `restore` of a commit wrote colour codes and a single line. Now `git show --no-color --no-ext-diff --no-textconv --no-show-signature --pretty=fuller`; `log` gets `--no-show-signature`, `diff` `--no-ext-diff --no-color`. The report itself was unaffected (explicit formats everywhere).
- **Shallow clone, sparse checkout, branch names with `/`, `#`, `@` and Chinese**: correct as they were; now tested.
- Reading the code: `restore ID FILE` wrote FILE relative to the shell's folder but chose git's line-ending filters as if FILE were relative to the `-C` folder; now both use where the user is.
- "Reflog turned off" (`core.logAllRefUpdates=false`) turned out not to be a case of its own: git still appends to reflog files that already exist; a repository without any is the bare one above.

Mistakes of mine on the way, in tests only: a scenario cloned a bare repository whose HEAD is `master` under git 2.19 and got an empty branch (now `clone -b main`); a merge expected to stop on a conflict was run with the helper that throws.

**Tests**: 75 (+31: 18 matrix, 5 menu, 8 edge cases). Before the fixes, 9 of them fail.

**Open**
- `am` with a patch that does not apply at all (no conflict, just "patch does not apply").
- A second independent review, in round 4 or 5.

## Round 4 — 2026-11-12 (0.4.0)

**A second independent review.** A reviewer given only the README and the code (not my notes or earlier findings) tried to break it for 13 minutes, only in throwaway repositories, and reproduced 21 of 22 findings. `test/review2.test.js` has one test per finding (plus the `am` case below); 22 of the 23 fail on 0.3.0, and the one that passed did so by luck (two backups happened to fall in different seconds).

**The big one: false alarms in ordinary work, from one cause.** Lost commits were compared one patch at a time (`git cherry`) and only against HEAD. So a squash or fixup rebase (no single patch matches the squashed one), a rebase followed by switching to another branch (compared against the wrong branch), a squash merge, a pull request squash-merged on the server and then pruned, and an old rebase of another branch after its reflog expired were all "lost commits", some as problems. Now, after the cheap comparison, lost commits are judged as a whole: their combined change, from just before the first to the last, must fail to come back out (`git apply --cached --check -R`, in an index file outside the repository) of every recent branch, remote-tracking branch and HEAD. Two more rules came out of making those tests pass:
- A reflog move that only went forward (a commit, a fast-forward) drops nothing, so it is not judged; if its new position is lost, a later move says so. (Without this, the entry for "commit: squash! B" was blamed for dropping its own parent.)
- The steps inside a rebase (pick, squash, fixup, finish) are not judged one by one: a squash folds in the pick before it, a fixup rewrites the original. A rebase is judged whole, from its start entry to where the branch ended.
- And in the middle of an operation, what it has made so far is on HEAD: work in progress, not lost.

The first version of the new check counted HEAD as a place where changes are kept, so commits on a detached HEAD were "kept on HEAD" and no longer reported; the existing tests caught it at once. HEAD is skipped when it has the very commits being judged.

**Real losses that were not reported**
- A dropped `stash -u` holding only new files: only tracked files were compared, so "nothing to compare" counted as applied. Now the untracked files (the stash's third parent) are compared too.
- Files staged in a repository with no commits yet: in that case `fsck --unreachable` prints "dangling", and only "unreachable" lines were read.
- An upstream force-pushed twice: only the newest forced update was looked at, whose "old" is the first rewrite, which the branch never had. Now every forced update of the last 30 days, until one matches.

**Fixes and undo**
- `fix 2b --yes` after `fix 1a` applied a different fix: numbers shift after each fix. Findings now have a `key` (kind and first commit) in `--json`; `fix KEY/a` finds the same finding or refuses. After a fix, git-rescue says the numbers may have changed.
- A submodule with changes during a conflict crashed the backup (it tried to copy a folder), so a merge could not be abandoned. Only files are copied now, and a file that cannot be copied is named, not fatal.
- Backup stamps had one-second resolution: two backups in one second shared refs and record, and the first was lost. Now to the millisecond and never reused.
- A hand-edited `rescue.log` value reached git: a branch value of `-D` made undo run `git branch -f keepme -D`, deleting the branch. Now a record line that is not exactly as git-rescue writes it (ids, branch names, stamp) is ignored whole; dropping only the bad field would have made undo think the fix had created the branch, and delete it.
- Undo after abandoning a rebase moved HEAD to a commit from the middle of it. The operation cannot come back; undo now leaves HEAD and says why.
- `undo STAMP` undoes an earlier fix; undo twice redoes, now said in `--help` and the README.
- A branch checked out in another worktree was offered "put it back" with a `checkout` that always fails. Now the option is left out and the note says to reset it in that worktree.

**Smaller**: a deleted-then-recreated branch was described as a detached HEAD (now "commits that were on exp when you left it are on no branch now"); a stray `" +` in the no-reflog finding's text (my own template mix-up from round 3); the backup message blamed conflicts when a locked index was the cause; an option that starts with you exited 0 (now 1), and exit codes are documented per command; run from a subfolder, the report says the commands are for the top folder, and fixes run there.

**Also this round**
- `git am` with a patch that does not apply at all stops with no file in conflict, and "finish it: resolve the conflicts" ran `am --continue`, which says "No changes". Now: apply it by hand (`git apply --reject .git/rebase-apply/patch`), add, continue; and "leave this patch out" rather than "commit".
- CI runs the tests on git 2.17.0 too, built from source in a cached step: the oldest version the README promises. The first build failed: today's compilers default to C23, where `thread_local`, a name git 2.17 uses, is a keyword; built with `-std=gnu99`. All 75 tests passed there on the first run.

Held up, per the reviewer: commit, message-only amend, cherry-pick, `merge --no-ff`, merged branch deletion, `stash pop`, `stash apply`+drop, tags, notes, worktree commits, `gc` and `gc --prune=now` gave no false alarm; `reset --keep` refused to overwrite an untracked file; uncommitted edits survived fixes and undos; the menu's typed-ahead and end-of-input handling; command-line errors.

**Tests**: 98 (+23). Report on the 30,000-commit repository: 2.9 s in-process (the new check only runs when something is lost).

**Open**
- The containment check looks at the 30 most recently changed branches and remote-tracking branches; a change kept only on an old branch is still reported (a false alarm, never a missed loss).
- Round 5: read the whole code once more, README line by line against behaviour, and the 1.0 promises (JSON format, exit codes, supported git).
