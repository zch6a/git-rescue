<div align="center">

# git-rescue

**我的 git 仓库刚才怎么了？我的代码怎么找回来？** 一条命令查看仓库的状态，告诉你哪里出了问题，以及能直接运行的修复命令。它还能找回 reflog 看不到的东西：被 `reset --hard` 弄丢的已暂存文件、被丢掉的 stash。每次修复之前都会先备份。

<a href="https://github.com/zch6a/git-rescue/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/zch6a/git-rescue/actions/workflows/ci.yml/badge.svg"></a>
<img alt="Node 18+" src="https://img.shields.io/badge/node-18%2B-339933?logo=node.js&logoColor=white">
<img alt="无依赖" src="https://img.shields.io/badge/dependencies-none-2ea44f">
<a href="LICENSE"><img alt="MIT 许可证" src="https://img.shields.io/badge/license-MIT-blue"></a>

[English](README.md) · **简体中文**

</div>

---

```bash
npx github:zch6a/git-rescue
```

在执行了 `reset --hard HEAD~2`、用 `-D` 删了一个分支、又弄丢了一个已暂存的文件之后（输出是英文的）：

```text
~/projects/app: on main, nothing uncommitted

! 1. Branch "experiment" was deleted with 1 commit no other branch has
     Its last commit seen was e65f82b2, when you left it 5 minutes ago:
       e65f82b2  try a faster tokenizer
     (Commits it got from another worktree or a `branch -f` are not in this list; `git-rescue lost`
     shows them.)
     a) Bring "experiment" back  [safe]
          git branch experiment e65f82b21596f06afa270587322b7f9d0be37c82

! 2. 2 commits fell off main with a reset (moving to HEAD~2) just now
     main was at 39f66d49 before; no branch has these commits now:
       39f66d49  parser handles escapes
       3b48736b  parser handles quotes
     a) Keep them on a new branch "rescued/main-before-reset-39f66d49" (main stays as it is)  [safe]
          git branch rescued/main-before-reset-39f66d49 39f66d49115fc9fa67247b8e5d6a2c0d96e4b888
     b) Put main back where it was (39f66d49)  [careful]
          git checkout main
          git reset --keep 39f66d49115fc9fa67247b8e5d6a2c0d96e4b888
          --keep refuses to run if it would overwrite changes you have not committed; git-rescue
          backs them up first anyway.

· 3. 1 file version that you added (staged) but never committed
     What `git add` saved before a `reset --hard`, `checkout .` or `stash`, or an earlier version of
     a file you added again. git keeps the contents, not the names:
       169672f8  just now        TODO: call the bank about the invoice
     a) Save one to a new file  [you do it]
          (git-rescue restore <id> <new-file-name>)
          `git-rescue find "some text"` searches them all.

Fix one? Type its number and letter (like 1a), or press Enter to leave everything as it is:
```

```text
$ git-rescue find invoice
  169672f8  a file you staged and never committed, line 1
      TODO: call the bank about the invoice

$ git-rescue restore 169672f8 notes.md
Saved the file (38 bytes) to notes.md.
```

## 能发现什么

它读取的是仓库的实际状态，而不是根据时间去猜：每一条都是确实存在的情况，并列出涉及的提交。

- **做到一半的操作**：等着解决冲突的 rebase、`am`、merge、cherry-pick、revert（列出是哪些文件），没有结束的 bisect。可以放弃（回到开始之前；放弃会重置文件，所以你已经做的修改会先复制到 `.git/rescue-files/`），或者完成它。
- **残留的 `.git/index.lock`**：它会让 git 拒绝做任何修改。
- **不在任何分支上的提交**：detached HEAD 上的提交，或者从 detached HEAD 切走、或在上面 reset 时被丢下的提交。
- **从分支上掉下来的提交**，不管是什么造成的：`reset`、`branch -f` 或 `checkout -B`、强制 pull、丢掉了提交的 rebase、改了内容的 amend（只作提示）。保留了改动的 rebase 或 amend 不算丢失：提交按改动内容比较，而不是按 id。
- **被删掉的分支**，而且它的提交别的分支都没有（已合并的分支不会报）。
- **被丢掉、而且改动不在你的文件或提交里的 stash**（`stash drop`、`stash clear`）：放回 stash 列表。（`stash pop` 应用之后也会丢掉 stash，这种不会报。）
- **已暂存但从未提交的文件**，被 `reset --hard` 或 `checkout .` 弄丢的：reflog 看不到它们，但在 `git gc` 清理之前（大约两周），git 还留着它们的内容。只作提示，因为 add 一个文件、再改、再 add，也会留下前一个版本。
- **别人 force push 过的上游分支**：你的分支还带着旧历史，这时 pull 会把旧历史又合并回来；对应的修复只把你自己的提交接到新历史上。

每一条都会列出涉及的东西：提交（id 和标题）、stash 改过的文件、丢失文件的第一行。在子模块里，HEAD 停在父仓库记录的那个提交上（detached）是 git 的正常做法，不算问题；在父仓库里会列出它的子模块，子模块要单独检查（`-C lib`）。

## 用法

```bash
git-rescue                  # 这里有什么问题；选一个修复（改动之前一定会问）
git-rescue timeline         # 最近发生了什么，用大白话说，并列出每一步之前的位置
git-rescue lost             # git 还能找回的所有东西
git-rescue find "某段文字"   # 在丢失的内容里搜索：已暂存的文件、丢失提交里的文件、提交说明
git-rescue restore ID 文件   # 把丢失的文件（或丢失提交的 diff）存到一个新文件；从不覆盖已有文件
git-rescue undo             # 撤销 git-rescue 上一次做的事
git-rescue fix 1a --yes     # 不经菜单直接执行第 1 个问题的 a 选项（用于脚本）
git-rescue --dry-run        # 只显示，不修改；--json 用于脚本；-C 路径 指定别的文件夹
```

安装成命令：`npm install -g github:zch6a/git-rescue`，或者像上面那样用 `npx` 直接运行一次。需要 Node 18+ 和 git（用 2018 年的 git 2.19 和最新版测试过）。

## 给脚本用：`--json`

每个命令都支持 `--json`，输出一个对象。`format` 目前是 1：只有删掉字段或改变字段含义时才会加 1；新增字段不改版本号。退出码：0 没有问题（或已完成），1 有需要看的（或没找到），2 无法运行。

```jsonc
// git-rescue --json
{
  "format": 1, "version": "0.2.0",
  "state": { "branch": "main", "headSha": "…", "unborn": false, "bare": false, "operation": null,
             "conflicted": [], "changed": 0, "untracked": 0, "lockAge": null,
             "superproject": null, "submodules": [] },
  "findings": [{
    "id": "dropped-by-reset",            // 问题的类型，全部 id 见 src/diagnose.js
    "level": "warning",                   // "problem"、"warning" 或 "info"
    "title": "2 commits fell off main with a reset (moving to HEAD~2) just now",
    "detail": "…",
    "commits": ["39f66d49…", "3b48736b…"],
    "options": [{ "title": "Keep them on a new branch …", "risk": "safe",   // "safe"、"careful"、"manual"
                  "steps": [["branch", "rescued/main-before-reset-39f66d49", "39f66d49…"]] }]
  }]
}
```

每一步是 git 的参数；只有一个、带空格的字符串的那一步需要你自己做，`[":remove-index-lock"]` 由 git-rescue 自己完成。`timeline --json` 输出 `{format, version, events}`，`lost --json` 输出 `{format, version, reflogOnly, unreachable, staged}`，`find --json` 输出 `{format, version, text, matches}`。

## 放心运行

- **不问就不改任何东西。** 报告以及 `timeline`、`lost`、`find` 都只读。修复会先列出确切的 git 命令，你同意后才执行（或者加 `--yes`）。
- **每次修复之前都会备份** 所有分支、HEAD 和你没提交的修改（像 `git stash` 那样，但不动你的文件），存在 `refs/rescue/<时间>/` 下：这是普通的 ref，`git gc` 不会删，用普通的 git 命令就能读。文件处于冲突状态、git 没法做快照时，改动过的文件会原样复制到 `.git/rescue-files/<时间>/`。`git-rescue undo` 只撤回这次修复改动的东西（它移动、新建或删除的分支，以及 HEAD），之后又变过的东西不动，并提供恢复当时没提交的修改。未跟踪的文件不会保存，任何修复都不会动它们。
- **选项都标了风险**：*safe*（用一条普通 git 命令就能撤销），*careful*（会移动分支或改动你的文件，事先已备份），*you do it*（需要你自己操作，比如解决冲突）。
- `restore` 只会写到新文件名。
- 完全本地：不联网、不收集数据、没有任何依赖。

## 它做不到的

- 找不回 git 从来没拿到过的东西：在 `checkout .` 或 `reset --hard` 之前，既没 add 也没提交的修改。（编辑器的本地历史里可能还有。）
- `git gc` 清理掉之后（reflog 也不引用的对象大约两周，reflog 条目 30 到 90 天），丢失的提交和文件就彻底没了。
- 它从不 push。如果修复改动了你已经推送过的提交，再推送需要 `git push --force-with-lease`，由你自己决定。

## 状态

0.2，开发中（[更新记录](CHANGELOG.md)、[参与贡献](CONTRIBUTING.md)）。测试只用在系统临时文件夹里新建的仓库（绝不碰真实仓库）：上面每种情况都会真的制造出来（reset、删分支、丢 stash、有冲突的 merge 和 rebase、残留的锁、被 force push 的远程），然后通过命令执行修复，再撤销；还有子模块、路径带空格和中文、有 3 万个提交和 3000 个丢失文件版本的仓库（在 Windows 上报告大约 3 秒）；以及独立审查发现的情况（不算丢失的普通 rebase 和 `stash pop`、900 条 reflog、worktree、裸仓库、非 ASCII 文件名、换行符）。在这里的 git 2.19 上测试，CI 里在 GitHub 的 Windows、macOS、Linux 上测试。

## 开发

```bash
npm install
npm test            # node --test
npm run check       # 检查 JavaScript 的类型（JSDoc 类型，tsc）
```

## 许可证

[MIT](LICENSE)
