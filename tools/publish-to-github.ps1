# publish-to-github.ps1
# 把本目录发布为 GitHub 上 smogon/pokemon-showdown 的 fork（保留上游提交历史）
#
# 前置：先在 https://github.com/smogon/pokemon-showdown 点 Fork（右上 Fork 按钮）
# 用法：powershell -ExecutionPolicy Bypass -File tools/publish-to-github.ps1 -RepoUrl https://github.com/jiayi37u/pokemon-showdown.git
#
# 脚本只做 git init / fetch / commit / push，不删除任何源码文件。

param(
    [Parameter(Mandatory = $true)][string]$RepoUrl,
    [string]$UpstreamUrl = "https://github.com/smogon/pokemon-showdown.git",
    [string]$Branch = "master",
    [string]$CommitMessage = "feat: NPC battle system with CFRU-ported AI (singles/doubles/multi)"
)

$ErrorActionPreference = "Stop"

function Run($cmd) {
    Write-Host "`n>>> $cmd" -ForegroundColor Cyan
    Invoke-Expression $cmd
    if ($LASTEXITCODE -ne 0) { throw "命令失败: $cmd" }
}

if (Test-Path ".git") {
    Write-Host "已存在 .git 目录，本脚本只用于首次初始化。" -ForegroundColor Yellow
    exit 1
}

# 0) 清理不想公开的开发残留
foreach ($f in @("error.log", "test.tar")) {
    if (Test-Path $f) { Remove-Item $f -Force; Write-Host "已删除 $f" -ForegroundColor DarkGray }
}
Write-Host "提示：all_changes.patch 含 6 万行开发过程 diff；Translation.js 是他人脚本。不想公开请先手动删除。" -ForegroundColor Yellow

# 1) 初始化
Run "git init -b $Branch"

# 2) origin = 你的 fork；upstream = 上游
Run "git remote add origin $RepoUrl"
Run "git remote add upstream $UpstreamUrl"

# 3) 拉取上游完整历史（上百 MB，需要几分钟；浅克隆会导致 push 被拒）
Run "git fetch upstream"

# 4) 把工作区放到上游历史之上，你的文件改动原样保留
Run "git reset --soft upstream/$Branch"

# 5) 确认自己在上游提交之上
Run "git log --oneline -1"

# 6) 提交全部改动
Run "git add -A"
Run "git commit -m `"$CommitMessage`""

# 7) 推送（fork 默认分支名可能不同，用 HEAD 推当前分支最稳）
Run "git push -u origin HEAD --force"

# 8) 把 fork 的默认分支指向刚推的分支
Run "gh repo edit $($RepoUrl -replace '\.git$','') --default-branch $Branch"

Write-Host "`n完成：https://github.com/jiayi37u/pokemon-showdown" -ForegroundColor Green
