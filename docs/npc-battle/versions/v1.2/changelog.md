# v1.2 变更记录 - 多人组队对战 NPC

## [已发布]

### v1.2.23 - 对手 preset 覆盖伤害估算 (2026-10-05)

**背景**: NormalAI 之前把对手一律按 IV=31 / EV=85 / 无性格 估算，和竞技练度（252/252/修正性格）系统性偏差 ~9-10%。影响到 Garchomp / Tyranitar 这类对手时伤害估低。

**改动**：
- 新建 `data/npc/opponent-presets.json`，按 `toID(species)` 为 key 存一个"主流练度"
- `trackedPokemonToAIPokemon` 优先查 preset，命中则用 preset 的 EV + nature + （可选）item 计算 stats；未命中回退既有默认估算
- item 处理：**协议暴露的 item** > preset.item > 空字符串。`itemLost=true` 时不回退 preset.item（避免 Eviolite 已消耗后还按 ×1.5 算）
- 本版 preset 只填 4 只（按用户指定）：Garchomp / Hydreigon / Tyranitar / Chansey。只处理有伤害影响的道具（仅 Eviolite）

**第一批 preset**：
| 精灵 | Nature | EVs | Item |
|---|---|---|---|
| Garchomp | Jolly | 252 Atk / 252 Spe / 4 HP | — |
| Hydreigon | Timid | 252 SpA / 252 Spe / 4 HP (Atk IV 0) | — |
| Tyranitar | Adamant | 252 HP / 252 Atk / 4 SpD | — |
| Chansey | Bold | 252 HP / 252 Def / 4 SpD (Atk IV 0) | Eviolite |

**不做的事**（本版明确跳过，和用户对齐过）：
- 其他 Pokemon preset：等用户逐只给
- 大部分道具（Life Orb / Choice X / 讲究道具）：这版只开 Eviolite
- 速度推断 / 协议级 Scarf 检测
- 伤害反推 EV/Nature（留 HardAI）

**文件变更**:
| 文件 | 变更 |
|------|------|
| data/npc/opponent-presets.json | 新建，4 只 preset |
| server/npc/ai/cfru/util/opponent-presets.ts | 新建，loader + stats 计算 |
| server/npc/ai/cfru/state-builder.ts | trackedPokemonToAIPokemon 接入 preset |
| test/npc/ai/opponent-presets.test.js | 新建 13 个用例 |
| test/npc/ai/run-tests.js | 挂新测试 |

**测试**: 398 unit tests 全过（+13 新）；sim-battle 单打跑完一局无异常。

---

### v1.2.22 - 攻击/防御特性 + 抵抗果 (2026-10-05)

**目的**: NormalAI 的伤害估算正确性补齐。CFRU 迁移清单里 10+ 个常见特性/道具原来是 ❌，这些漏项在"用那种 Pokemon 的 NPC" 场景下会给出错误伤害，影响评分决策。

**攻击方特性（basePower 修饰）**：
| 特性 | 效果 |
|---|---|
| Water Bubble | 水招式 ×2 |
| Punk Rock | 声音招式 ×1.3 |
| Steelworker | 钢招式 ×1.5 |
| Transistor | 电招式 ×1.5 |
| Dragon's Maw | 龙招式 ×1.5 |
| Analytic | 后手时 ×1.3（用 isFaster 判定） |

**攻击方特性（post-effectiveness）**：
| 特性 | 效果 |
|---|---|
| Tinted Lens | 被抵抗伤害 ×2 |
| Neuroforce | 超效伤害 ×1.25 |

**防御方特性（post-effectiveness）**：
| 特性 | 效果 |
|---|---|
| Filter / Solid Rock / Prism Armor | 超效伤害 ×0.75 |
| Fluffy | 火 ×2，接触 ×0.5（可叠加 → Flare Blitz 抵消为 ×1） |
| Ice Scales | 特殊招 ×0.5 |
| Punk Rock（defender） | 声音招 ×0.5 |

**道具**：
- 17 种抵抗果（Occa/Passho/.../Roseli）在被对应属性超效打到时 ×0.5，一次性消耗（感知 `defender.itemLost`）
- Chilan Berry：Normal 招无条件 ×0.5

**未处理（KNOWN LIMITATION）**：
- Steely Spirit / Friend Guard：需要队友 ability，`calculateDamage` 签名目前没传入队友上下文
- Metronome 道具：需要跨回合招式历史

**文件变更**:
| 文件 | 变更 |
|------|------|
| server/npc/ai/cfru/util/damage-calc.ts | +RESIST_BERRY_TYPES、+10 个攻击方分支、+8 个防御方/post-eff 分支，import isFaster |
| test/npc/ai/ai-damage-calc.test.js | +18 个用例（新能力） |
| docs/ai-logic/CFRU-Migration-Checklist.md | 11 个 ❌ → ✅ v1.2.22，M1 完成率 75% → 95% |

**测试**: 385 unit tests 全过（+18 新），sim-battle 单打仍能跑完一局

---

### v1.2.21 - 固定伤害招式 + Counter/Mirror Coat + Sucker Punch (2026-10-05)

**新增能力**:

**M1 - 固定伤害招式**（原 P0 遗漏，basePower=0 一刀切 → 现按 CFRU 公式）：

| 招式 | 伤害估算 |
|------|---------|
| Seismic Toss / Night Shade | 使用者等级（类型克制/免疫走常规类型检查） |
| Dragon Rage | 40 |
| Sonic Boom | 20 |
| Super Fang | 对手当前 HP / 2 |
| Endeavor | 对手 HP − 自己 HP（≤0 不打） |
| Final Gambit | 自己当前 HP |
| Psywave | min=level/2, max=level×3/2 |
| Counter / Mirror Coat / Metal Burst | 对手 lastMove 匹配类别时，反向跑 `calculateDamage` 得到对手上招伤害 × {2, 2, 1.5}；不匹配返回 0 |

**M2 - Sucker Punch 简化版**：对手 `lastMove` 空或类别为 Status → 伤害估成 0（按失败考虑）；否则走常规公式。等 M7 招式预测做完再升级到完整版。

**实现要点**:
- 固定伤害分支放在类型免疫 / Wonder Guard 之后、常规公式之前，不影响既有攻击招式的伤害链
- Counter 系反向调用常规 `calculateDamage` 估伤——CFRU 用的是协议级实际伤害记录，我们没有，用 lastMove 估算是近似
- Sucker Punch 直接在 damage-calc 入口判定，评分系统天然继承"伤害 = 0 → 分低"的既有规则，不需要新建 negatives case

**文件变更**:
| 文件 | 变更 |
|------|------|
| server/npc/ai/cfru/util/damage-calc.ts | +computeFixedDamage()，Sucker Punch 失败判定 |
| test/npc/ai/ai-damage-calc.test.js | +15 用例（固定伤害 7 / Counter&Mirror 5 / Sucker Punch 3） |
| docs/ai-logic/CFRU-Migration-Checklist.md | P0 固定伤害、P1 Sucker Punch 标✅ |

**测试**: 367 unit tests 全过（+15 新用例），sim-battle 单打 mirror-npc 场景跑通 Chansey 两次 Seismic Toss

**后续**:
- M1 残留：Final Gambit 的"自己也会倒"影响评分里的后续回合（现在 damage-calc 不感知）
- Sucker Punch 升级：等 M7 招式预测，当前用 lastMove 近似在"对手刚换上来 / 刚被 force-switched 回"的场景会判错

---

### v1.2.20 - 重复代码重构 P1/P2/P3 (2026-10-05)

**背景**: `docs/tmp.md` 里 P1/P2/P3 遗留，每次 bug 修复要改多处（v1.2.8/v1.2.9 的 Bug 根因）。

**P1 - Pokemon 构建**：
- 新增 `server/npc/ai/cfru/util/pokemon-builder.ts`：`parseCondition` / `parseDetails` / `speciesDefaults` / `makeAIPokemonSkeleton`
- `buildPokemonFromRequest` / `trackedPokemonToAIPokemon` 都走共享骨架
- `multi-manager.ts` 的 `buildAIPokemon` 现有字段形态（`isActive` + `terastallized`）与 AIPokemon 不严格对齐；下游不读这几个字段，暂保留并加 JSDoc 说明等 Multi 流程后续重构一并处理

**P2 - AIMove 构造**：
- `state-builder.ts` 导出 `buildAIMove(moveData, slot)`
- `normal.ts` 的 `convertToAIMoves` / `multi-manager.ts` 的 `convertToAIMoves` 都改为 `moves.map((m, i) => buildAIMove(m, i + 1))`
- Return/Frustration 的硬编码只在一处维护

**P3 - DEFAULT_BOOSTS**：
- `types.ts` 新增 `defaultBoosts()` 工厂（返回新对象）
- 替换生产代码 10+ 处字面量（state-builder、battle-tracker、multi-manager）
- test/ 下的 mock 定义保留原样（独立快照更稳定）

**文件变更**:
| 文件 | 变更 |
|------|------|
| server/npc/ai/cfru/util/pokemon-builder.ts | 新建 |
| server/npc/ai/cfru/types.ts | +defaultBoosts |
| server/npc/ai/cfru/state-builder.ts | 用共享工具重写 buildPokemonFromRequest / trackedPokemonToAIPokemon，导出 buildAIMove |
| server/npc/ai/cfru/util/battle-tracker.ts | 用 defaultBoosts 替换字面量 |
| server/npc/ai/multi-manager.ts | 用 buildAIMove / defaultBoosts；buildAIPokemon 加字段差异说明 |
| server/npc/ai/normal.ts | convertToAIMoves 收敛到共享实现 |
| docs/tmp.md | 标记 P1/P2/P3 已处理 |

**测试**: 352 个测试通过，sim-battle singles / multi 回归验证通过

---

### v1.2.19 - sim-battle runner 策略化 + Multi 支持 + AI 伤害回归 (2026-10-05)

**新增能力**:
- Runner 把 player 控制重构成 **5 种策略**：`max-damage`、`random`、`mirror-npc`、`scripted`、`interactive`，可以采集 NPC 在不同压力下的决策曲线
- 支持 `--game-type singles | doubles | multi`，Multi 下 `(p1+p3)` 玩家对 `(p2+p4)` NPC
- 支持 PS 导出 `.txt` 队伍文件（Teams.import），不再强制 JSON
- Multi NPC 队伍自动按 `slot: "p2" / "p4"` 字段拆分
- 新增 `test/npc/ai/ai-damage-calc.test.js` —— 用 Garchomp vs Mega Char-X 的 4 个期望值（含双打 0.75× 衰减）锚定 AI 的 `calculateDamage` 输出

**背景**:
原来 player 只能被动脚本控制，不能用来验证 NPC 在"合理对手"下的决策合理性。改成策略插件后：
- `mirror-npc` 让两个 NormalAI 互殴，用来找对称场景的决策盲点
- `max-damage` 当作一个强而稳定的基准对手，让 NPC 必须给出不被压制的 counter
- 组合不同 team × 不同策略跑一批场景，批量采集"NPC 用某招时的局势"

**文件变更**:
| 文件 | 变更类型 |
|------|---------|
| test/npc/sim-battle/strategies.ts | 新建，5 种策略实现 |
| test/npc/sim-battle/runner.ts | 重写：策略 + game-type + Multi + .txt 支持 |
| test/npc/sim-battle/README.md | 重写使用说明 |
| test/npc/sim-battle/sample-teams/*.txt | 新建 Gen7 OU 样例队伍（Garchomp / Mega Char-X 对子） |
| test/npc/ai/ai-damage-calc.test.js | 新建，4 个 Garchomp/Char-X 伤害范围断言 |
| test/npc/ai/run-tests.js | 挂上新测试 |

**测试**: 352 个测试通过（新增 4 个伤害计算用例）

---

### v1.2.18 - 新增 NPC AI 实战模拟 Runner (2026-10-04)

**新增能力**:
- `test/npc/sim-battle/runner.ts` — 进程内启动 BattleStream，p1 由 scripted/interactive/random 玩家控制、p2 直接实例化 BasicAI / NormalAI
- 协议日志（stdout）+ AI 决策日志（stderr）同时输出，解决"开发功能不知道实际运行时执行到哪里获取了什么数据"的调试盲区
- 固定 `--seed` 可重现，脚本模式可写入 CI 做回归

**使用场景**:
- 发现 AI 决策异常时，直接把当时场景写成 Scripted 回归用例
- 用 `--log-level SCORING` 对照 CFRU 预期评分
- 用 `interactive` 模式手动驱动 p1，现场观察 AI 的反应

**文件变更**:
| 文件 | 变更类型 |
|------|---------|
| test/npc/sim-battle/runner.ts | 新建 |
| test/npc/sim-battle/README.md | 新建 |
| test/npc/sim-battle/scripts/*.json | 新建示例脚本 |
| docs/testing/README.md | 增加实战验证层 |

**已知限制**: 仅接 p1+p2 单打 / 双打，Multi 尚未支持。

---

### v1.2.17 - Return/Frustration 威力计算修复 (2026-02-04)

**问题修复**:
- 修复 Return（报恩）和 Frustration（迁怒）招式威力计算为 0、类型识别为 Status 的问题

**根本原因**:
PS 对这两个招式发送的名称格式为 `"Return 102"`，导致：
1. `Dex.moves.get("Return 102")` 查找失败
2. `category` 默认为 `"Status"`
3. `basePower` 默认为 `0`

**解决方案**:
在 `convertToAIMoves`（NormalAI）和 `buildMovesFromRequest` 中检测 `return`/`frustration` 开头的招式 ID，硬编码正确属性：

| 招式 | 威力 | 类型 | 分类 |
|------|------|------|------|
| Return | 102 | Normal | Physical |
| Frustration | 1 | Normal | Physical |

**文件变更**:
| 文件 | 变更类型 |
|------|---------|
| server/npc/ai/normal.ts | `convertToAIMoves` 添加 Return/Frustration 检测 |
| server/npc/ai/cfru/state-builder.ts | `buildMovesFromRequest` 添加 Return/Frustration 检测 |

**测试**: 348 个测试通过

---

### v1.2.16 - Multi Battle p2 阵亡后 selfIndex 修复 (2026-01-26)

**问题修复**:
- 修复 Multi Battle 中 p2 全部阵亡后，p4 伤害计算失效的问题

**根本原因**:
当 p2 阵亡时，`buildVirtualDoublesState` 的 `selfActive` 数组只有 1 个元素（p4 在索引 0），但 `evaluateSideChoice` 调用时 p4 的 `selfIndex` 固定传入 1，导致 `attacker = virtualState.self.active[1]` 为 undefined。

**解决方案**:
动态计算 p4 的 selfIndex：
```typescript
const p4SelfIndex = p2Request ? 1 : 0;  // p2 阵亡时，p4 在索引 0
```

**文件变更**:
| 文件 | 变更类型 |
|------|---------|
| server/npc/ai/multi-manager.ts | 动态计算 p4 selfIndex |

**测试**: 348 个测试通过

---

### v1.2.15 - Pokemon Changes 命令 (2026-01-25)

**新功能**:
- 新增 `/changes` 命令查看自定义精灵改动
- 支持中英文名称搜索

**命令用法**:
| 命令 | 作用 |
|------|------|
| `/changes` 或 `/改动` | 查看所有有改动的精灵列表 |
| `/changes 大狼犬` | 查看大狼犬的具体改动 |
| `/changes mightyena` | 同上，支持英文名 |

**技术细节**:
- 解析 `data/changelog.md` 文件获取改动记录
- 使用 `normalizeKey()` 函数代替 `toID()` 以支持中文字符
- `toID()` 只保留 a-z 和 0-9，会删除中文字符导致所有中文名变成空字符串
- 使用 `process.cwd()` 定位文件路径（编译后 `__dirname` 指向 `dist/` 目录）

**文件变更**:
| 文件 | 变更类型 |
|------|---------|
| server/chat-plugins/pokemon-changes.ts | 新建 |

**Bug 修复** (开发过程中):
1. 路径问题：`__dirname` 编译后指向 `dist/server/chat-plugins/`，改用 `process.cwd()`
2. 中文 Key 问题：`toID('大狼犬')` 返回空字符串，改用 `normalizeKey()` 保留中文

---

### v1.2.14 - Multi Battle 按钮修复 (2026-01-25)

**问题修复**:
- 修复点击 "Start Multi Battle" 按钮报错 `User "smart" not found or not online.`

**根本原因**:
按钮生成的命令格式错误：
```
按钮命令: /npc multi cynthia, smart
期望格式: /npc multi [npcId], [teammate], [difficulty]
```

`smart` (难度参数) 被错误解析为 teammate 用户名。

**解决方案**:
1. 按钮改为调用新命令 `/npc multisetup`
2. `multisetup` 显示输入表单让用户填写队友用户名
3. 表单提交正确格式的 `/npc multi [npcId], [teammate], [difficulty]` 命令

**新增命令**:
- `/npc multisetup [npcId], [difficulty]` - 显示 Multi Battle 设置界面

**文件变更**:
| 文件 | 变更类型 |
|------|---------|
| server/chat-plugins/npc.ts | 新增 `multisetup` 命令，修改按钮调用 |

**测试**: 348 个测试通过 (无变化)

---

### v1.2.13 - Sleep Talk/Snore 评分 (2026-01-25)

**新功能**:
- 实现 Sleep Talk 和 Snore 招式的评分逻辑

**CFRU 参考**:
- `ai_negatives.c:1783-1795` - 非睡眠状态扣分
- `ai_positives.c:982-986` - 睡眠状态加分

**评分规则**:
| 场景 | 分数调整 |
|------|----------|
| 非睡眠状态使用 | -10 (负面) |
| 睡眠最后 1 回合使用 | -10 (负面，会先醒来) |
| 睡眠状态使用 (>1 回合) | +10 (正面) |
| Comatose 特性使用 | +10 (正面，始终有效) |

**文件变更**:
| 文件 | 变更类型 |
|------|---------|
| server/npc/ai/cfru/scoring/negatives.ts | 新增 `checkSleepTalkSnore` |
| server/npc/ai/cfru/scoring/positives.ts | 新增 `rewardSleepTalkSnore` |
| test/npc/ai/negatives.test.js | 新增 10 个测试用例 |
| docs/ai-logic/CFRU-Migration-Checklist.md | 更新迁移状态 |

**测试**: 348 个测试通过 (新增 10 个)

---

### v1.2.12 - Multi Battle p4 Slot 修复 (2026-01-25)

**问题修复**:
- 修复 Multi Battle 中 p4 的 boost 不影响伤害计算的问题

**根本原因**:
PS 协议中 Multi Battle 的位置格式：
- p2 使用 slot 'a' → 威吓消息: `|-unboost|p2a: ...|atk|1`
- p4 使用 slot 'b' → 威吓消息: `|-unboost|p4b: ...|atk|1`

但代码硬编码使用 `${side}a`：
```typescript
// 旧代码 - 错误
const boostKey = `${side}a`;  // p4 得到 'p4a'，但追踪的是 'p4b'
```

**解决方案**:
根据 side 确定正确的 slot：
```typescript
// 新代码 - 正确
const slotChar = side === 'p2' ? 'a' : 'b';
const boostKey = `${side}${slotChar}`;  // p4 得到 'p4b'
```

**文件变更**:
| 文件 | 变更类型 |
|------|---------|
| server/npc/ai/multi-manager.ts | `buildAIPokemon` 使用正确的 slot 格式 |
| test/npc/ai/multi-battle.test.js | 更新测试使用正确的 PS 协议格式 |

**测试**: 338 个测试通过

---

### v1.2.11 - Multi Battle Boost 追踪修复 (2026-01-25)

**问题修复**:
- 修复 Multi Battle 中威吓 (Intimidate) 等 boost 变化不影响伤害计算的问题

**根本原因**:
两个层面的问题：

1. **BattleTracker 只追踪 p2 的 boost**: `handleBoost` 中检查 `side === this.ourSide` (p2)，但 multi battle 中 p4 也是我们队伍的成员，其 boost 变化被忽略

2. **multi-manager 不使用追踪的 boost**: `buildAIPokemon` 硬编码 boost 为全 0，没有从 tracker 获取追踪的值

**解决方案**:
1. BattleTracker 添加 `ourTeamSides` 概念，在 multi 模式下追踪整个队伍 (p2 + p4) 的 boost
2. 使用 `side+slot` 格式 (如 'p2a', 'p4a') 作为 boost 追踪的 key，区分不同位置
3. multi-manager 的 `buildAIPokemon` 从 tracker 获取活跃 Pokemon 的 boost

**文件变更**:
| 文件 | 变更类型 |
|------|---------|
| server/npc/ai/cfru/util/battle-tracker.ts | 添加 `ourTeamSides`, `isOurTeamSide()`, 更新追踪方法使用新 key 格式 |
| server/npc/ai/multi-manager.ts | `buildAIPokemon` 从 tracker 获取 boost |

**测试**: 330 个测试通过

---

### v1.2.10 - 双打/Multi Spread Move 伤害递减 (2026-01-25)

**新功能**:
- 实现双打/Multi 模式下 spread move 的伤害递减（75%）

**CFRU 参考**:
`damage_calc.c:3239-3247` - Spread Move Cut

```c
if (IS_DOUBLE_BATTLE) {
    if (moveTarget & MOVE_TARGET_BOTH && CountAlive >= 2)
        damage = (damage * 75) / 100;
    else if (moveTarget & MOVE_TARGET_FOES_AND_ALLY && CountAlive >= 2)
        damage = (damage * 75) / 100;
}
```

**实现**:
- `calculateDamage` 新增 `spreadInfo` 参数: `{ isDoubles, numAliveTargets }`
- 当 `isDoubles && numAliveTargets >= 2` 且招式 target 是 `allAdjacentFoes` 或 `allAdjacent` 时，伤害 * 0.75

**文件变更**:
| 文件 | 变更类型 |
|------|---------|
| server/npc/ai/cfru/util/damage-calc.ts | 添加 `spreadInfo` 参数和减伤逻辑 |
| server/npc/ai/cfru/scoring/index.ts | `scoreMove` 传入 spreadInfo |
| server/npc/ai/cfru/scoring/positives.ts | `rewardSpreadMove` 传入 spreadInfo |
| server/npc/ai/cfru/scoring/negatives.ts | `checkSpreadMoveHitsPartner` 传入 spreadInfo |

**测试**: 330 个测试通过

---

### v1.2.9 - Multi 模式己方能力值修复 (2026-01-25)

**问题修复**:
- 修复 Multi Battle 中己方能力值仍使用种族值的问题

**根本原因**:
v1.2.8 修复了 `state-builder.ts` 中的问题，但 `multi-manager.ts` 中的 `parseBaseStats` 方法没有同步修复，仍然始终使用种族值。

注释写着 "Always use species base stats for damage calculation consistency"，这在 v1.2.8 之前是正确的（因为当时 state-builder.ts 也用种族值），但现在需要同步改用实际能力值。

**解决方案**:
修改 `parseBaseStats` 方法，优先使用传入的 `stats` 参数（实际能力值），仅在无 stats 时回退到种族值。

**文件变更**:
| 文件 | 变更类型 |
|------|---------|
| server/npc/ai/multi-manager.ts | `parseBaseStats` 使用实际能力值 |

**测试**: 330 个测试通过

---

### v1.2.8 - 己方能力值修复 (2026-01-25)

**问题修复**:
- 修复己方能力值使用种族值而非实际能力值的严重 Bug
- 修复等级默认值错误（默认 L50 改为 L100）

**根本原因**:
两个 Bug 叠加导致伤害计算严重不准确：

1. **己方使用种族值**：`buildPokemonFromRequest` 使用 `speciesData.baseStats`（种族值），而 PS request 实际包含 `mon.stats`（实际能力值）
2. **等级默认值错误**：PS 在 details 中省略默认等级时，代码默认使用 'L50' 而非 'L100'

| 问题 | 修复前 | 修复后 |
|------|--------|--------|
| 己方 ATK | 134 (种族值) | 403 (实际能力值) |
| 己方等级 | Lv50 (错误默认) | Lv100 (正确) |

**解决方案**:
1. 使用 `mon.stats` 获取己方实际能力值
2. 修改默认等级为 L100（与 National Dex 格式一致）
3. 对手继续使用追踪等级 `tracked.level`（已在 v1.2.7 修复）

**文件变更**:
| 文件 | 变更类型 |
|------|---------|
| server/npc/ai/cfru/state-builder.ts | 使用 `mon.stats` 和修改默认等级 |

**关键发现**:
- PS `request.side.pokemon[].stats` 包含实际能力值（非种族值）
- PS 在 details 中省略默认等级（如 "Tyranitar, F" 无 L100）

**测试**: 330 个测试通过

---

### v1.2.7 - 等级计算统一修复 (2026-01-25)

**问题修复**:
- 修复 v1.2.6 引入的等级不一致问题
- 不同代码路径使用不同的默认等级值 (50 vs 100)，导致伤害计算不准确

**根本原因**:
v1.2.6 的修复虽然添加了等级追踪，但各处默认值不一致：

| 位置 | 默认值 | 问题 |
|------|--------|------|
| `state-builder.ts` 对手函数 | 50 | 与 tracker 不一致 |
| `trackedPokemonToAIPokemon` | 100 | v1.2.6 新增 |
| `multi-manager.ts` | 100 | v1.2.6 新增 |
| `damage-calc.ts` | 50 | 后备值不一致 |

当攻击方和防御方使用不同等级时，伤害百分比会出错。

**解决方案**:
采用"格式推断等级"策略：
- 随机对战：使用追踪/解析的等级（每只精灵等级可能不同）
- 其他格式：使用格式默认等级（National Dex=100, VGC=50, LC=5）
- 关键点：双方使用相同等级，确保伤害百分比准确

**新增**:
- `getFormatLevel(formatId)`: 根据格式返回默认等级
- `resolveLevel(formatId, parsedLevel)`: 解析最终使用的等级
- `CFRUAIConfig.formatId`: 配置中存储格式 ID

**文件变更**:
| 文件 | 变更类型 |
|------|---------|
| server/npc/ai/cfru/types.ts | 新增 `getFormatLevel`, `resolveLevel`, `formatId` 字段 |
| server/npc/ai/cfru/state-builder.ts | 统一默认值为 100，使用 `resolveLevel` |
| server/npc/ai/cfru/util/damage-calc.ts | 统一默认值为 100 |
| server/npc/ai/multi-manager.ts | 传递 formatId 给 `trackedPokemonToAIPokemon` |
| server/npc/ai/normal.ts | 在 `setBattle` 时设置 `cfruConfig.formatId` |

**格式等级映射**:
| 格式 | 等级 |
|------|------|
| Random Battle | 使用追踪值 |
| National Dex / OU / UU | 100 |
| VGC / BSS / Battle Stadium | 50 |
| Little Cup | 5 |

**测试**: 316 个测试通过 (无变化)

---

### v1.2.6 - Multi Battle 伤害计算修复 (2026-01-25)

**问题修复**:
- 修复 Multi Battle 中伤害计算异常的问题
- Iron Head 对 Garchomp 显示 68% 伤害（双打模式下约 35%）

**根本原因**:
1. `multi-manager.ts` 的 `parseBaseStats` 使用 request 中的实际属性值，而应使用种族值（与 state-builder.ts 一致）
2. **主要问题**: `trackedPokemonToAIPokemon` 硬编码 `level = 50`，而 National Dex 格式是 level 100
   - 这导致对手 HP 被估算为实际的一半 (194 vs 378)
   - 伤害百分比翻倍 (35% → 68%)

**解决方案**:
1. 修改 `parseBaseStats` 始终使用种族值
2. 添加 `level` 字段到 `TrackedPokemon` 接口
3. 在 `handleSwitch` 中从协议消息解析等级（从 "Species, L100, M" 格式）
4. `trackedPokemonToAIPokemon` 使用追踪的等级，默认 100

**文件变更**:
| 文件 | 变更类型 |
|------|---------|
| server/npc/ai/multi-manager.ts | 修复 `parseBaseStats` 始终使用种族值 |
| server/npc/ai/cfru/util/battle-tracker.ts | 添加 level 字段和解析逻辑 |
| server/npc/ai/cfru/state-builder.ts | 使用追踪的等级 |
| docs/npc-battle/troubleshooting/known-issues.md | 更新 Bug 19 |

**测试**: 316 个测试通过 (无变化)

---

### v1.2.5 - 双打 Spread Move 评分修复 (2026-01-24)

**问题修复**:
- 修复双打 Spread Move 评分使用第一目标分数的问题
- Earthquake vs Roaring Moon 有 117 分，但 AI 错误选择了 Iron Head (105 分) 攻击 Sinistcha

**根本原因**:
代码假设 spread move 对所有目标评分相同，只在第一个目标时参与比较：
```typescript
if (isSpreadMove && targetIdx > 0) continue; // 117 分被跳过！
```

实际上，同一个 spread move 对不同目标的评分可能差异很大：
- vs Sinistcha：地面被抵抗，只有 24% 伤害 → 102 分
- vs Roaring Moon：伤害 56%，可 2HKO → 117 分

**解决方案**:
重构为两遍扫描：
1. 第一遍：收集所有目标的评分
2. 第二遍：spread move 取所有目标中的最高分

**文件变更**:
| 文件 | 变更类型 |
|------|---------|
| server/npc/ai/normal.ts | 重构 `chooseBestMoveWithScores` 的 spread move 评分逻辑 |

**测试**: 316 个测试通过 (无新增)

---

### v1.2.4 - Multi Battle 对手追踪修复 (2026-01-24)

**问题修复**:
- 修复 NPCMultiManager 无法追踪对手精灵的问题
- 修复 BattleTracker 在 multi 战斗中只追踪 p1，遗漏 p3 的问题
- 修复 room.ts 中 `battle.p2.active = true` 覆盖 Side.active 数组的问题

**根本原因**:
1. **sim Battle 不可直接访问**: PS 架构中 sim Battle 运行在子进程，主进程无法通过 `roomBattle.stream.battle` 访问
2. **RoomBattle.p1 != Side**: `battle.p2` 是 `RoomBattlePlayer` 对象，不是 sim 的 `Side` 对象
3. **BattleTracker 单对手逻辑**: 原先只检查 `this.opponentSide` (p1)，multi 战斗需要同时追踪 p1 和 p3

**解决方案**:
- NPCMultiManager 使用 BattleTracker 追踪对手信息（同 NormalAI 模式）
- BattleTracker 新增 `isMulti` 参数，multi 战斗时追踪 p1 AND p3
- 新增 `opponentSides: Set<string>` 和 `isOpponentSide()` 方法
- 移除 room.ts 中的 `battle.p2.active = true` 等破坏性代码

**文件变更**:
| 文件 | 变更类型 |
|------|---------|
| server/npc/room.ts | 移除覆盖 active 属性的代码 |
| server/npc/ai/multi-manager.ts | 重构使用 BattleTracker，重命名 battle → roomBattle |
| server/npc/ai/cfru/util/battle-tracker.ts | 新增 multi battle 支持 |
| server/npc/ai/cfru/state-builder.ts | 导出 trackedPokemonToAIPokemon |

**技术说明**:
- Multi 战斗 Team 1 = p1 + p3，Team 2 = p2 + p4
- AI (p2/p4) 需要追踪 p1 AND p3 作为对手
- BattleTracker 通过协议消息追踪，不依赖直接访问 sim Battle

---

### v1.2.3 - 日志与调试增强 (2026-01-24)

**问题修复**:
- 修复 NPCMultiManager 日志不输出的问题
- 创建了 logger 但没有调用 `logMoveDecision`、`logSwitchDecision` 等方法

**功能增强**:
- `evaluateSideChoice` 现在记录完整的招式评分和选择信息
- `chooseSwitch` 支持记录换人决策
- `handleTeamPreview` 记录队伍预览决策
- `handleForceSwitch` 构建 virtualState 以支持日志记录

**说明**:
- 队伍预览阶段只显示一个玩家的队伍是 PS multi battle 的正常行为
- 在 multi battle 中，每个玩家只能看到自己和对手的队伍预览，看不到队友的

---

### v1.2.2 - 邀请流程重构 (2026-01-24)

**问题修复**:
- 修复 p3 placeholder 导致的 `Cannot read properties of null (reading 'user')` 错误
- 修复空队伍导致的 `Custom bans are not currently supported` 随机队伍生成错误

**重构**:
- 重构 multi battle 创建流程：从"先创建房间再邀请"改为"先邀请再创建房间"
- 移除 `delayedStart: 'multi'` 和 p3 placeholder 的复杂逻辑
- 两个玩家都准备好后才创建完整的 4 人房间

**新增命令**:
- `/npc multi [npcId], [teammate], [difficulty]` - 发送邀请给队友
- `/npc acceptmulti [challenger]` - 接受 multi battle 邀请

**流程变更**:
1. 玩家 1 执行 `/npc multi gymbrock, @teammate`
2. 队友收到邀请通知
3. 队友执行 `/npc acceptmulti player1` 接受
4. 系统验证双方队伍，创建完整 4 人房间
5. 战斗开始，NPCMultiManager 协调 p2 和 p4

**文件变更**:
| 文件 | 变更类型 |
|------|---------|
| server/chat-plugins/npc.ts | 重构 multi 命令，新增 acceptmulti 命令 |
| server/npc/room.ts | 重构 createNPCMultiBattle，接收两个玩家 |

**技术细节**:
- 使用 PS 原生 `GameChallenge` 实现邀请机制
- 邀请数据存储在 challenge 对象的 `npcMultiData` 属性
- 格式选择 UI 过滤 multi 格式，单独显示 Multi Battle 区域

---

### v1.2.1 - 核心功能实现 (2026-01-24)

**新增**:
- `[Gen 9] National Dex Multi` 格式 (`config/formats.ts:3132-3148`)
- `createNPCMultiBattle` 房间创建函数 (`server/npc/room.ts:476-702`)
- `NPCMultiManager` AI 协调器 (`server/npc/ai/multi-manager.ts`)
- `/npc multi [npcId]` 聊天命令 (`server/chat-plugins/npc.ts:337-396`)
- NPC 队伍配置支持 `slot` 字段 (`server/npc/manager.ts:212-279`)
- 示例 multi 队伍 (`data/npc/teams/gym-brock-gen9nationaldexmulti.json`)

**功能**:
- 支持两名玩家组队 (p1+p3) 对战 NPC (p2+p4)
- NPCManager 协调 p2 和 p4 的 AI 决策
- 复用现有 CFRU 评分系统
- 支持 request 同步和虚拟双打状态构建

**测试**:
- 新增 12 个 multi battle 测试用例
- 测试覆盖: NPC 模板支持、队伍加载分割、NPCMultiManager 构建
- 总测试数: 316 通过

**文件变更**:
| 文件 | 变更类型 |
|------|---------|
| config/formats.ts | 新增格式定义 |
| server/npc/manager.ts | 添加 multi 支持 |
| server/npc/room.ts | 添加 createNPCMultiBattle |
| server/npc/ai/multi-manager.ts | 新建 |
| server/chat-plugins/npc.ts | 添加 multi 命令 |
| data/npc/templates.json | 添加 multi 配置 |
| data/npc/teams/gym-brock-gen9nationaldexmulti.json | 新建 |
| test/npc/ai/multi-battle.test.js | 新建 |
| test/npc/ai/run-tests.js | 添加 multi-battle 模块 |

---

### v1.2.0 - 需求设计 (2026-01-24)

**新增**:
- 完成需求分析和方案设计
- 确定采用方案 A (Multi 格式 + NPCManager)
- PS 原生 Multi Battle 机制研究
- NPCManager 协调器设计
- NPC 队伍配置方案 (slot 字段)

**文档**:
- 创建 v1.2/README.md 版本概览
- 创建 v1.2/requirements.md 需求文档
- 创建 v1.2/design.md 设计文档
- 创建 v1.2/changelog.md 变更记录

---

## 待办

### 集成测试 (已完成)
- [x] 实际房间创建端到端测试
- [x] 邀请流程端到端测试
- [x] 完整对战流程测试
- [x] AI 对手追踪验证

---

*最后更新: 2026-01-25 (v1.2.15)*
