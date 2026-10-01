# Claude Code 历史对话查找与保留

## 问题

超过 1 个月的对话无法通过 `claude --resume` 找回。完整对话的 `.jsonl` 文件被自动清理，只剩下 `history.jsonl` 中的用户侧消息摘要。

## 已知存储路径

| 内容 | 路径 | 说明 |
|------|------|------|
| 完整对话转录 | `~/.claude/projects/<project-slug>/*.jsonl` | 可 resume 的完整数据，会被自动清理 |
| 用户消息索引 | `~/.claude/history.jsonl` | 只有用户发的消息（display/timestamp/sessionId/project），不含 AI 回复 |
| 设置 | `~/.claude/settings.json` | 无清理相关配置项 |
| 可视化界面 | `~/.claude/history-viewer.html` | 已创建，需配合 `history.json` 使用 |
| 数据 JSON | `~/.claude/history.json` | 从 history.jsonl 转换，供前端读取 |

## 当前状态（2026-06-02）

- 本项目共 37 个会话记录在 history.jsonl 中
- 磁盘上仅存 9 个 `.jsonl` 会话文件（最早 5 月底）
- 34 个旧会话（2026-01-21 ~ 2026-02-04）的完整对话数据已丢失

## 拟定解决方案

### 方案 1：定时备份（推荐，未实际部署验证）

```bash
# crontab -e 添加：
0 3 * * * rsync -a ~/.claude/projects/ ~/claude-sessions-backup/
```

### 方案 2：硬链接保留

```bash
# 定期执行，防止文件被 unlink 删除
find ~/.claude/projects/ -name "*.jsonl" -exec ln -f {} ~/claude-sessions-hardlinks/ \;
```

如果 Claude Code 用 truncate+rewrite 方式删除则无效。

### 方案 3：等待官方支持

Claude Code 目前无 `sessionRetentionDays` 等配置项。可在 https://github.com/anthropics/claude-code/issues 提 feature request。

## 可视化查看

```bash
# 更新数据
python3 -c "
import json
data = []
with open('$HOME/.claude/history.jsonl') as f:
    for line in f:
        if line.strip(): data.append(json.loads(line))
with open('$HOME/.claude/history.json', 'w') as f:
    json.dump(data, f, ensure_ascii=False)
"

# 启动服务
cd ~/.claude && python3 -m http.server 8765
# 访问 http://localhost:8765/history-viewer.html
```
