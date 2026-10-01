# PS 队伍转换工具

将 Pokemon Showdown 格式的队伍文本转换为 NPC JSON 格式。

## 基本用法

```bash
node tools/convert-team.js <输入文件> <输出文件名> [选项]
```

## 参数说明

| 参数 | 必填 | 说明 |
|------|------|------|
| `<输入文件>` | 是 | PS 格式队伍文本文件路径 |
| `<输出文件名>` | 是 | 输出 JSON 文件名（自动保存到 `data/npc/teams/`） |

## 选项

| 选项 | 说明 |
|------|------|
| `--npc <id>` | NPC 模板 ID（如 `gymbrock`） |
| `--format <fmt>` | 对战格式（如 `gen9nationaldex`） |
| `--mode <mode>` | 队伍模式：`singles`、`doubles`、`multi`（默认 `singles`） |
| `--no-update` | 不自动更新 `templates.json` |
| `--help` | 显示帮助信息 |

## 使用示例

### Singles 队伍

```bash
node tools/convert-team.js team.txt gym-brock-gen9ou.json \
  --npc gymbrock --format gen9nationaldex --mode singles
```

### Doubles 队伍

```bash
node tools/convert-team.js doubles.txt gym-brock-doubles.json \
  --npc gymbrock --format gen9doublesou --mode doubles
```

### Multi 队伍

Multi 模式要求输入 6 只精灵，自动分配 slot：
- 前 3 只 -> `p2`
- 后 3 只 -> `p4`

```bash
node tools/convert-team.js multi.txt gym-brock-multi.json \
  --npc gymbrock --format gen9nationaldexmulti --mode multi
```

### 仅转换（不更新 templates.json）

```bash
node tools/convert-team.js team.txt output.json --format gen9ou --no-update
```

## 输入格式

标准 Pokemon Showdown 队伍格式，支持以下字段：

```
Tyranitar @ Leftovers
Ability: Sand Stream
Shiny: Yes
Tera Type: Rock
EVs: 252 HP / 252 Atk / 4 Spe
Adamant Nature
IVs: 0 Spe
- Stone Edge
- Crunch
- Earthquake
- Stealth Rock

Torkoal @ Heat Rock
Ability: Drought
Tera Type: Fire
EVs: 252 HP / 252 SpA / 4 SpD
Quiet Nature
IVs: 0 Spe
- Eruption
- Heat Wave
- Earth Power
- Protect
```

### 支持的字段

| 字段 | 示例 |
|------|------|
| Species / Nickname | `Tyranitar` 或 `Rocky (Tyranitar)` |
| Item | `@ Leftovers` |
| Ability | `Ability: Sand Stream` |
| Nature | `Adamant Nature` |
| Tera Type | `Tera Type: Rock` |
| EVs | `EVs: 252 HP / 252 Atk / 4 Spe` |
| IVs | `IVs: 0 Spe` 或 `IVs: 0 Atk / 0 Spe` |
| Level | `Level: 50` |
| Shiny | `Shiny: Yes` |
| Gender | `(M)` 或 `(F)` |
| Happiness | `Happiness: 0` |
| Moves | `- Stone Edge` |

## 输出格式

```json
{
  "format": "gen9nationaldex",
  "pokemon": [
    {
      "species": "Tyranitar",
      "ability": "Sand Stream",
      "item": "Leftovers",
      "nature": "Adamant",
      "teraType": "Rock",
      "evs": { "hp": 252, "atk": 252, "spe": 4 },
      "ivs": { "spe": 0 },
      "shiny": true,
      "moves": ["Stone Edge", "Crunch", "Earthquake", "Stealth Rock"]
    }
  ]
}
```

### Multi 模式输出

Multi 模式会自动添加 `slot` 字段：

```json
{
  "format": "gen9nationaldexmulti",
  "pokemon": [
    { "species": "Pokemon1", "slot": "p2", ... },
    { "species": "Pokemon2", "slot": "p2", ... },
    { "species": "Pokemon3", "slot": "p2", ... },
    { "species": "Pokemon4", "slot": "p4", ... },
    { "species": "Pokemon5", "slot": "p4", ... },
    { "species": "Pokemon6", "slot": "p4", ... }
  ]
}
```

## 自动更新 templates.json

当同时提供 `--npc` 和 `--format` 时，脚本会自动更新 `data/npc/templates.json`：

```json
{
  "gymbrock": {
    "teams": {
      "singles": {
        "gen9nationaldex": ["gym-brock-gen9nationaldex.json"]
      }
    }
  }
}
```

如果 NPC 不存在，会创建新条目。

## 常用场景

### 场景 1：为现有 NPC 添加新格式队伍

```bash
node tools/convert-team.js ou-team.txt gym-brock-gen9ou.json \
  --npc gymbrock --format gen9ou --mode singles
```

### 场景 2：为现有 NPC 添加备选队伍

```bash
# 添加第二套队伍（同格式可有多套队伍，随机选择）
node tools/convert-team.js ou-team-2.txt gym-brock-gen9ou-2.json \
  --npc gymbrock --format gen9ou --mode singles
```

### 场景 3：创建欺骗空间队伍（0 速度）

确保输入文件中相关精灵有 `IVs: 0 Spe`：

```
Torkoal @ Heat Rock
Ability: Drought
EVs: 252 HP / 252 SpA / 4 SpD
Quiet Nature
IVs: 0 Spe
- Eruption
...
```

### 场景 4：批量转换多个队伍

```bash
for f in teams/*.txt; do
  name=$(basename "$f" .txt)
  node tools/convert-team.js "$f" "${name}.json" --format gen9ou --no-update
done
```
