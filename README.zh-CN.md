<div align="center">

# git-rescue

### git 搞砸了？把你的代码找回来。

一条命令读懂你的仓库，用大白话告诉你出了什么问题，并给出能直接运行的修复命令。改动任何东西之前都会先完整备份，`git-rescue undo` 可以撤回修复改动的东西。它还能找回 reflog 看不到的东西：被 `reset --hard` 弄丢的已暂存文件、被丢掉的 stash。

<a href="https://github.com/zch6a/git-rescue/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/zch6a/git-rescue/actions/workflows/ci.yml/badge.svg"></a>
<img alt="Node 18+" src="https://img.shields.io/badge/node-18%2B-339933?logo=node.js&logoColor=white">
<img alt="git 2.17+" src="https://img.shields.io/badge/git-2.17%2B-f05032?logo=git&logoColor=white">
<img alt="无依赖" src="https://img.shields.io/badge/dependencies-none-2ea44f">
<a href="LICENSE"><img alt="MIT 许可证" src="https://img.shields.io/badge/license-MIT-blue"></a>

[English](README.md) · **简体中文**

<br>

<img src="docs/demo.svg" width="860" alt="git-rescue 在 reset --hard 之后：找到两个丢失的提交和一个丢失的已暂存文件，一条命令把提交保存到新分支，再按文字找到那个文件">

</div>

```bash
npx github:zch6a/git-rescue        # 在出问题的仓库里运行；你同意之前它什么都不改
```

（演示和报告的输出是英文的。）

## 为什么用 git-rescue

- **读的是实际发生的事，不靠猜。** 每一条都是仓库里确实存在的情况（一条 reflog 记录、rebase 做到一半留下的文件、没有任何东西指向的对象），并列出涉及的提交和它们的标题。
- **能找回 reflog 看不到的东西。** 你 `git add` 过的每个文件，git 都存了一份；`reset --hard` 或 `checkout .` 之后，大约两周内还在。被丢掉的 stash 也一样。`git-rescue find "某段文字"` 能在里面搜索。
- **放心试。** 你选一个选项并同意之前什么都不改。改之前先备份所有分支、HEAD 和没提交的修改，`git-rescue undo` 精确撤回这次修复改动的东西。测试会把每种问题的每个选项都真跑一遍再撤销，覆盖 git 2.17 到最新版、Windows/macOS/Linux。
- **平时不打扰。** rebase、squash、`stash pop`、squash 合并都不算丢失，也不会被报成丢失。两次独立审查专门找过误报。

## 交给 AI 编程助手

git-rescue 自带一个 Agent Skill（技能）。在 Claude Code 里：

```text
/plugin marketplace add zch6a/git-rescue
/plugin install git-rescue@git-rescue
```

然后直接说发生了什么（“我不小心 reset --hard 了”“rebase 卡住了”“我的 stash 去哪了”）。助手会运行 git-rescue，告诉你发现了什么、哪些东西有风险，只有在你同意某个选项之后才按问题的固定 key 执行修复，并且有 git-rescue 的备份和 `undo`。技能还会叮嘱它在诊断之前不要运行 `gc`、`prune`、`reset`，免得把证据毁掉。从文件夹读取技能的其他助手：把 [`plugin/skills/git-rescue`](plugin/skills/git-rescue/SKILL.md) 复制到它们的技能文件夹（Claude Code 是 `~/.claude/skills/`）。

## 能发现什么

它读取的是仓库的实际状态，而不是根据时间去猜：每一条都是确实存在的情况，并列出涉及的提交。

- **做到一半的操作**：等着解决冲突的 rebase、`am`、merge、cherry-pick、revert（列出是哪些文件），没有结束的 bisect。可以放弃（回到开始之前；放弃会重置文件，所以你已经做的修改会先保存下来，处于冲突状态的会复制到 `.git/rescue-files/`），或者完成它。
- **残留的 `.git/index.lock`**：它会让 git 拒绝做任何修改。
- **不在任何分支上的提交**：detached HEAD 上的提交，从 detached HEAD 切走、或在上面 reset 时被丢下的提交，以及你离开某个分支时还在它上面、现在却不在任何分支上的提交。
- **从分支上掉下来的提交**，不管是什么造成的：`reset`、`branch -f` 或 `checkout -B`、强制 pull、丢掉了提交的 rebase、改了内容的 amend（只作提示）。保留了改动的 rebase、squash、fixup 或 amend 不算丢失：提交按改动内容比较，而不是按 id；改动已经全部在某个分支（本地或远程）上的丢失提交也不报。
- **被删掉的分支**，而且它的提交别的分支都没有（已合并的分支不会报，squash 合并的也一样）。
- **被丢掉、而且改动不在你的文件或提交里的 stash**（`stash drop`、`stash clear`；用 `stash -u` 存的新文件也算）：放回 stash 列表。（`stash pop` 应用之后也会丢掉 stash，这种不会报。）
- **已暂存但从未提交的文件**，被 `reset --hard` 或 `checkout .` 弄丢的：reflog 看不到它们，但在 `git gc` 清理之前（大约两周），git 还留着它们的内容。只作提示，因为 add 一个文件、再改、再 add，也会留下前一个版本。
- **连 reflog 都不再指向的提交**：reflog 条目过期了，或者仓库根本不记 reflog（服务器上的裸仓库就不记，force push 之后旧提交就是这种状态）。改动已经在分支上的提交（比如很久以前的 rebase）不报。
- **正在运行的 `git gc`**：它会删掉超过两周、没有任何东西指向的对象；git-rescue 会提醒你等它结束再找回。
- **别人 force push 过的上游分支**：你的分支还带着旧历史，这时 pull 会把旧历史又合并回来；对应的修复只把你自己的提交接到新历史上。

每一条都会列出涉及的东西：提交（id 和标题）、stash 改过的文件、丢失文件的第一行。在子模块里，HEAD 停在父仓库记录的那个提交上（detached）是 git 的正常做法，不算问题。在父仓库里会列出它的子模块，子模块要单独检查（`-C lib`）。

## 用法

```bash
git-rescue                  # 这里有什么问题；选一个修复（改动之前一定会问）
git-rescue timeline         # 最近发生了什么，用大白话说，并列出每一步之前的位置
git-rescue lost             # git 还能找回的所有东西
git-rescue find "某段文字"   # 在丢失的内容里搜索：已暂存的文件、丢失提交里的文件、提交说明
git-rescue restore ID 文件   # 把丢失的文件（或丢失提交的 diff）存到一个新文件；从不覆盖已有文件
git-rescue undo             # 撤销 git-rescue 上一次做的事（再 undo 一次就是重做）
git-rescue undo STAMP       # 撤销更早的一次修复（git-rescue undo --list 列出所有备份）
git-rescue fix 1a --yes     # 不经菜单直接执行第 1 个问题的 a 选项
git-rescue fix KEY/a --yes  # 按 --json 里的 key 执行，用于脚本，见下文
git-rescue --dry-run        # 只显示，不修改；--json 用于脚本；-C 路径 指定别的文件夹
```

安装成命令：`npm install -g github:zch6a/git-rescue`，或者像上面那样用 `npx` 直接运行一次。需要 Node 18+ 和 git 2.17 或更新的版本（用 2018 年的 git 2.17、2.19 和最新版测试过）。

## 给脚本用：`--json`

每个命令都支持 `--json`，输出一个对象。`format` 目前是 1：只有删掉字段或改变字段含义时才会加 1；新增字段不改版本号。1.x 保持稳定的全部内容见 [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)（英文）。

退出码：0 没有问题或已完成；1 有需要看的（报告：有 problem 或 warning；`find`：没找到；`fix` 和 `undo`：你选了否，或者下一步要你自己做）；2 无法运行。`lost` 和 `timeline` 只要运行了就返回 0。

每修复一个问题，编号就会变（修好第 1 个，原来的第 2 个就变成第 1 个）。脚本应该按 `key` 选：`git-rescue fix dropped-by-reset:39f66d49/a --yes` 执行那个问题的 a 选项；如果它已经不在了，就拒绝执行（退出码 2）。

```jsonc
// git-rescue --json
{
  "format": 1, "version": "1.1.0",
  "state": { "branch": "main", "headSha": "…", "unborn": false, "bare": false, "operation": null,
             "conflicted": [], "changed": 0, "untracked": 0, "lockAge": null,
             "superproject": null, "submodules": [] },
  "findings": [{
    "id": "dropped-by-reset",            // 问题的类型，全部 id 见 src/diagnose.js
    "key": "dropped-by-reset:39f66d49",  // 这一条问题：类型加第一个提交，用于 fix KEY/a
    "level": "warning",                   // "problem"、"warning" 或 "info"
    "title": "2 commits fell off main with a reset (moving to HEAD~2) just now",
    "detail": "…",
    "commits": ["39f66d49…", "3b48736b…"],
    "options": [{ "title": "Keep them on a new branch …", "risk": "safe",   // "safe"、"careful"、"manual"
                  "steps": [["branch", "rescued/main-before-reset-39f66d49", "39f66d49…"]] }]
  }]
}
```

每一步是 git 的参数。如果一步只是一个带空格的字符串，就需要你自己做；`[":remove-index-lock"]` 由 git-rescue 自己完成。`timeline --json` 输出 `{format, version, events}`，`lost --json` 输出 `{format, version, reflogOnly, unreachable, staged}`，`find --json` 输出 `{format, version, text, matches}`，`undo --list --json` 输出 `{format, version, backups}`。

## 放心运行

- **不问就不改任何东西。** 报告以及 `timeline`、`lost`、`find` 都只读。修复会先列出确切的 git 命令，你同意后才执行（或者加 `--yes`）。
- **每次修复之前都会备份** 所有分支、HEAD 和你没提交的修改（像 `git stash` 那样，但不动你的文件），存在 `refs/rescue/<时间>/` 下：这是普通的 ref，`git gc` 不会删，用普通的 git 命令就能读。文件处于冲突状态、git 没法做快照时，改动过的文件会原样复制到 `.git/rescue-files/<时间>/`。`git-rescue undo` 只撤回这次修复改动的东西（它移动、新建或删除的分支，以及 HEAD），之后又变过的东西不动，并提供恢复当时没提交的修改。放弃了 rebase 或 merge 之后再 undo，HEAD 保持不动：操作没法恢复，你在其中做的修改在 `.git/rescue-files/` 里。未跟踪的文件不会保存，任何修复都不会动它们。undo 使用备份记录前会先检查它是不是 git-rescue 写的，不是就忽略。
- **选项都标了风险**：*safe*（用一条普通 git 命令就能撤销），*careful*（会移动分支或改动你的文件，事先已备份），*you do it*（需要你自己操作，比如解决冲突）。
- `restore` 只会写到新文件名。
- 完全本地：不联网、不收集数据、没有任何依赖。

## 它做不到的

- 找不回 git 从来没拿到过的东西：在 `checkout .` 或 `reset --hard` 之前，既没 add 也没提交的修改。（编辑器的本地历史里可能还有。）
- `git gc` 清理掉之后（reflog 也不引用的对象大约两周，reflog 条目 30 到 90 天），丢失的提交和文件就彻底没了。
- 它从不 push。如果修复改动了你已经推送过的提交，再推送需要 `git push --force-with-lease`，由你自己决定。

## 状态

1.0（[更新记录](CHANGELOG.md)、[1.x 保持稳定的内容](docs/COMPATIBILITY.md)、[参与贡献](CONTRIBUTING.md)）。测试只用在系统临时文件夹里新建的仓库，绝不碰真实仓库：

- 每一种问题都会真的制造出来，git-rescue 能执行的每个选项都通过命令执行一遍，然后检查：问题消失了、别处没提交的修改还在、`undo` 把每个分支和 HEAD 都放回原处；
- 像真人那样使用菜单：选一项、回答是或否、直接回车、提前输入答案、输入中途结束；
- 边角情况：reflog 已过期、force push 之后的裸仓库、浅克隆、稀疏检出、子模块、worktree、名字里带 `/`、`#` 和中文的分支、带空格的路径、会改变 git 输出的配置（`color.ui=always`、`format.pretty`、`diff.external`），以及有 3 万个提交和 3000 个丢失文件版本的仓库（在 Windows 上报告大约 3 秒）；
- 两次独立审查发现的情况（不算丢失的普通 rebase、squash、fixup、`stash pop` 和 squash 合并，被丢掉的 `stash -u`，第一次提交之前暂存的文件，900 条 reflog，非 ASCII 文件名，换行符）。

在这里的 git 2.19 上测试；CI 里在 git 2.17.0（从源码编译）以及 GitHub 的 Windows、macOS、Linux 自带的 git 上测试。

## 开发

```bash
npm install
npm test            # node --test
npm run check       # 检查 JavaScript 的类型（JSDoc 类型，tsc）
```

## 许可证

[MIT](LICENSE)
