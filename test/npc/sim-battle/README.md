# NPC AI 实战模拟 Runner

直接在进程内跑一局 PS 对战，一方由"策略玩家"（max-damage / random / mirror-npc / scripted / interactive）控制，另一方由本仓库的 NPC AI 控制。目标是让 AI 的真实运行时轨迹可观察、可复现，不用启服务器 + 浏览器 + 复制聊天日志。

支持 **singles / doubles / multi** 三种 game type。

---

## 快速开始

```bash
npm run build

# 单打：max-damage p1 对 Normal NPC
node dist/test/npc/sim-battle/runner.js \
  --format        gen9nationaldex \
  --game-type     singles \
  --player        test/npc/sim-battle/sample-teams/sample_team_1_gen7ou.txt \
  --npc           test/npc/sim-battle/sample-teams/sample_team_2_gen7ou.txt \
  --p1-strategy   max-damage \
  --npc-difficulty normal \
  --log-level     DECISION \
  --seed          1,2,3,4 \
  --max-turns     30 \
  > battle.log 2> ai.log
```

- `battle.log` = PS 全视角协议
- `ai.log` = NormalAI 决策日志 + 玩家决策日志

---

## 五种玩家策略

| 策略 | 用途 |
|---|---|
| `max-damage` | 按 BP × STAB × 平均属性相克挑最强招（忽略 Status 招式）；对手类型从协议 switch/drag 实时聚合 |
| `random` | PS 原生 `RandomPlayerAI`，冒烟/批量跑 |
| `mirror-npc` | 对面也用 NPC AI（跟随 `--npc-difficulty`），basic vs basic / normal vs normal，用来观察对称情况 |
| `scripted` | JSON 定义的 choice 序列，回归测试、复现 Bug |
| `interactive` | 从 stdin 读 choice，现场手动调试 |

p1 用 `--p1-strategy`；Multi 的 p3 用 `--p3-strategy`。两边可以不同策略。

### scripted 示例

```bash
--p1-strategy scripted --script-p1 test/npc/sim-battle/scripts/always-move-1.json
```

每个条目一个 `{"choice": "move 2"}`，依次用于每次 **招式** request；`teamPreview`/`forceSwitch` 固定走 `default`。

---

## 三种 game type

### singles（默认）
```
--game-type singles
--player team_a.txt --npc team_b.txt
```
p1 玩家 vs p2 NPC。

### doubles
```
--format gen9nationaldexdoublesou --game-type doubles
--player team_a.txt --npc team_b.txt
--p1-strategy max-damage
```
p1 玩家 vs p2 NPC，各 2 只 active。

### multi
```
--format gen9nationaldexmulti --game-type multi
--player test/npc/sim-battle/sample-teams/sample_team_1_gen7ou.txt --player2 test/npc/sim-battle/sample-teams/sample_team_2_gen7ou.txt
--npc data/npc/teams/maxie-gen9nationaldexmulti.json
# 可选：--npc2 另一个 NPC 文件
--p1-strategy max-damage --p3-strategy max-damage
```
`(p1+p3)` 玩家队伍 vs `(p2+p4)` NPC 队伍。

**NPC 队伍结构**：优先读 npc 文件里 `slot: "p2"` / `slot: "p4"` 字段拆成两边；也可以用 `--npc` + `--npc2` 两个文件分开指定。Max Team Size = 3，长队伍自动截断前 3 只。

---

## 队伍文件格式

runner 自动识别三种：

1. **PS 导出 `.txt`**（Smogon / damagecalc.com 导出）
   ```
   Garchomp @ Rockium Z
   Ability: Rough Skin
   EVs: 252 Atk / 4 SpD / 252 Spe
   Jolly Nature
   - Swords Dance
   - Earthquake
   ...
   ```

2. **带 `format` + `pokemon` 的 JSON**（`data/npc/teams/*.json`）
3. **纯 `PokemonSet[]` JSON 数组**

Multi 文件可以带 `slot: "p2" | "p4"` 字段，被自动分割。

---

## CLI 参数

| 参数 | 说明 | 默认 |
|---|---|---|
| `--format` | PS 格式 id | `gen9nationaldex` |
| `--game-type` | `singles` \| `doubles` \| `multi` | `singles` |
| `--player` / `--player-team` | p1 队伍 | 必填 |
| `--player2` | p3 队伍（Multi） | — |
| `--npc` / `--npc-team` | p2 队伍 | 必填 |
| `--npc2` | p4 队伍（Multi）；或留空让 npc 文件按 slot 拆分 | — |
| `--p1-strategy` | p1 策略 | `max-damage` |
| `--p3-strategy` | p3 策略（Multi） | `max-damage` |
| `--script-p1` / `--script` | scripted 策略的脚本路径 | — |
| `--script-p3` | p3 scripted 脚本 | — |
| `--npc-difficulty` | `basic` \| `normal` | `normal` |
| `--npc2-difficulty` | p4 的难度（Multi） | 同 `--npc-difficulty` |
| `--seed` | PRNG 种子 `a,b,c,d` | 随机 |
| `--log-level` | `NONE` \| `DECISION` \| `SCORING` \| `VERBOSE` | `DECISION` |
| `--max-turns` | 上限，到达后 `>forcetie` | `200` |
| `--debug-ai` | 额外打印 NPC 的 choose（stderr） | 关闭 |

---

## 典型调试工作流

1. **收集数据**：固定 `--seed`，用不同 `--p1-strategy` 跑几遍，观察 NormalAI 对不同难度对手的决策差异
2. **锁定场景**：发现决策异常后，`--log-level SCORING` 看评分明细
3. **写回归**：把场景写成 `scripted` 脚本放到 `scripts/`，加进 CI
4. **AI 伤害计算校验**：`test/npc/ai/ai-damage-calc.test.js` —— Garchomp vs Mega Char-X 的四个期望值
   ```bash
   node test/npc/ai/run-tests.js ai-damage-calc
   ```

## 测试 "挑衅" 这类特殊招式的使用

1. 找一队装 Taunt 的队伍，和一队高威胁 Setup 使用者的队伍
2. `--p1-strategy mirror-npc` 让另一个 NormalAI 做 Setup，让 NPC 侧有正当理由出 Taunt
3. `--log-level SCORING` 看 Taunt 的具体评分，对照 CFRU `ai_positives.c` 的 Taunt 分支

---

## 已知限制

- max-damage 策略只认 Dex basePower；对 BP=0 的变基招（Low Kick、Grass Knot、Hidden Power 之类）会落到 fallback，不是最佳对手选择
- scripted 还不支持"看到协议子串 X 后才下一个 choice"的断言型等待
- Multi 下如果给出 6 只 pokemon 的文件又没有 slot 字段，会被 team-validator 以 Max Team Size=3 拒掉
- BasicAI 没有决策级日志，只能靠 `--debug-ai` 看 choose 原文
