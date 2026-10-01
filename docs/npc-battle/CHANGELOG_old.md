# NPC 对战系统 - 变更记录

简洁版本历史，详细内容见各版本文档。

## [1.1.31] - 2026-01-24
- 新增: 睡眠条款 (Sleep Clause) 检查
  - 问题: PS平台单打有睡眠条款，对方同时只能有一只精灵陷入睡眠
  - 解决: checkSleepMove 检查对手队伍是否已有睡眠精灵
  - 检查逻辑 (基于 CFRU battle_util.c:2018-2037 DoesSleepClausePrevent):
    1. 目标已有状态: -20 分
    2. **睡眠条款违规**: 对手队伍中已有未倒下的睡眠精灵: -20 分 + 设置 `hasNoEffect = true`
    3. 电气场地阻止睡眠: -10 分
    4. 特性阻止 (Vital Spirit/Insomnia/Sweet Veil/Comatose): -20 分
    5. 草系免疫粉末: -20 分
    6. Safety Goggles 阻止粉末: -20 分
  - 适用招式: Spore, Sleep Powder, Hypnosis, Sing, Grass Whistle, Lovely Kiss, Dark Void, Yawn, Relic Song
- 修复: 睡眠招式正面加分在条款违规时不应触发
  - 问题: rewardSleepMove 无条件给 +12~+20 加分，导致睡眠条款违规时净分仍可能为正
  - 解决: rewardSleepMove 检查 `ctx.flags.hasNoEffect`，如为 true 则返回 0
  - 结果: 睡眠条款违规时最终分数 = 100 - 20 + 0 = 80 分，而不是 100 - 20 + 16 = 96 分
- 修改文件:
  - server/npc/ai/cfru/scoring/negatives.ts: checkSleepMove 新增睡眠条款检查
  - server/npc/ai/cfru/scoring/positives.ts: rewardSleepMove 检查 hasNoEffect
  - test/npc/ai/negatives.test.js: 新增 10 个睡眠条款测试（包括集成测试）
- 测试: 304 个测试通过 (新增 10 个)

## [1.1.30] - 2026-01-24
- 修复: Knock Off 道具追踪逻辑
  - 问题: 所有对手都被视为"无道具"，因为 `item === '' && hasRevealedInfo` 总是为 true
  - 修复: 新增 `itemLost` 字段区分"道具未知"和"道具已失去"
    - `itemLost = false, item = ''`: 道具未知，假设持有道具
    - `itemLost = true, item = ''`: 道具已确认失去 (收到 -enditem 消息)
    - `itemLost = false, item = 'X'`: 道具已知
  - 逻辑变更:
    - rewardKnockOff: 仅当 `itemLost = true` 时不给加分
    - checkKnockOff: 仅当 `itemLost = true` 时扣 -5 分
- 修改文件:
  - server/npc/ai/cfru/util/battle-tracker.ts: TrackedPokemon 新增 itemLost，handleItem 设置 itemLost
  - server/npc/ai/cfru/types.ts: AIPokemon 新增 itemLost
  - server/npc/ai/cfru/state-builder.ts: 传递 itemLost 字段
  - server/npc/ai/cfru/scoring/positives.ts: rewardKnockOff 使用 itemLost
  - server/npc/ai/cfru/scoring/negatives.ts: checkKnockOff 使用 itemLost
  - test/npc/ai/positives.test.js: 更新 Knock Off 测试
  - test/npc/ai/negatives.test.js: 更新 Knock Off 测试
- 测试: 294 个测试通过 (无新增)

## [1.1.29] - 2026-01-24
- 增强: NPC 队伍配置系统支持多世代
  - `NPCTeamConfig` 接口改为基于完整 format 名的映射
  - 旧格式: `singles: { ou: [...], uu: [...] }` (仅 Gen 9)
  - 新格式: `singles: { gen9ou: [...], gen8ou: [...], gen7uu: [...] }`
  - 同样支持 doubles 和 randombattle 的多世代配置
- 删除: `FORMAT_NAMES` 硬编码映射和 `getAvailableFormats()` 硬编码列表
- 新增: `isDoublesFormat()` 和 `isRandomBattleFormat()` 辅助函数
- 新增: `getFormatDisplayName()` 动态生成格式显示名 (如 `[Gen 8] OU`)
- 修改: `isFormatSupported()` 改为检查 Dex.formats.get() 是否存在
- 修改文件:
  - server/npc/manager.ts: 接口和查找逻辑重构
  - server/npc/room.ts: 移除硬编码格式列表
  - server/chat-plugins/npc.ts: 格式名动态生成
  - data/npc/templates.json: 配置格式更新
  - data/npc/teams/*.json: 文件重命名为 `{npc}-{format}.json` 格式
- 测试: 294 个测试通过 (无新增)

## [1.1.28] - 2026-01-24
- 新增: Knock Off (拍落) 招式评分
  - 正面评分 (rewardKnockOff，仅当对手未失去道具时):
    - 基础加分: +5 (假设对手持有道具)
    - 耐久型目标 (HP/Def/SpD ≥ 90): 额外 +3
  - 负面评分 (checkKnockOff):
    - 对手已失去道具: -5
  - 总分: 有道具 +5~+8，已失去道具 -5
  - 设计理由: 竞技对战中几乎所有精灵都携带道具，Knock Off 有高通用价值
- 修改文件:
  - server/npc/ai/cfru/scoring/positives.ts: 新增 rewardKnockOff
  - server/npc/ai/cfru/scoring/negatives.ts: 新增 checkKnockOff
  - docs/ai-logic/NormalAI/logic.md: 添加 Knock Off 评分文档
  - test/npc/ai/positives.test.js: 新增 6 个 Knock Off 正面评分测试
  - test/npc/ai/negatives.test.js: 新增 4 个 Knock Off 负面评分测试
- 测试: 294 个测试通过 (新增 10 个)

## [1.1.27] - 2026-01-24
- 优化: 评分数值调整 (基于 logic_new.md)
  - 被抵抗扣分: 0.5x -2 → -5, 0.25x -5 → -20
  - 低伤害扣分: <10% -20, <20% -8, <33% -3 (原 <25% -5, <33% -2)
  - 高血量回复扣分: >80% -20, >70% -5, >60% -2 (原 >90% -8, >75% -5, >60% -3)
  - 腹鼓风险阈值: HP ≤ 70% (原 ≤ 60%)
  - 强化招式 HP 惩罚: 40% -11, 60% -6 (原 -6, -3)
  - 4 倍克制加分: +15 (原 +8)
  - Salt Cure: 基础 +3, 水/钢 +10, 坦克 +8 (原 +4, +6, +3)
- 简化: Protect 连续使用扣分
  - 旧逻辑: 使用 protectUses 计数器，根据次数和模式扣 -6 到 -10
  - 新逻辑: 上回合是 Protect 类招式则扣 -20
  - 删除 protectUses 字段和相关追踪代码
- 修复: 换人阈值条件改为 `<=`
  - 旧: `maxAttackScore < 95 && maxStatusScore < 90`
  - 新: `maxAttackScore <= 95 && maxStatusScore <= 90`
- 修改文件:
  - server/npc/ai/cfru/scoring/negatives.ts: 数值调整，简化 checkProtectOveruse
  - server/npc/ai/cfru/scoring/positives.ts: 数值调整
  - server/npc/ai/cfru/types.ts: 删除 protectUses 字段
  - server/npc/ai/cfru/util/battle-tracker.ts: 删除 protectUses 追踪
  - server/npc/ai/cfru/state-builder.ts: 删除 protectUses 初始化
  - server/npc/ai/normal.ts: 换人阈值改为 <=
  - docs/ai-logic/NormalAI/logic.md: 更新数值和 Protect 文档
- 测试: 284 个测试通过 (减少 1 个重复测试)

## [1.1.26] - 2026-01-24
- 增强: NormalAI 换人决策逻辑优化
  - 动态阈值 (基于 logic.md 扣分分析):
    - 旧逻辑: `maxScore <= 50` 时考虑换人 (几乎不触发)
    - 新逻辑: `maxAttackScore < 95 && maxStatusScore < 90` 时考虑换人
    - 攻击阈值 95: 单抵抗+极低伤害(93分)触发，本系双抵抗(98分)不触发
    - 状态阈值 90: 对手已有状态(85分)触发，正常状态招式(100+)不触发
    - 分开评估攻击招式和状态招式的最高分
  - 换人目标评分优化 (`scoreSwitchOption`):
    - 属性优势: 免疫对手招式 (+12)，抵抗对手招式 (+6 per move, cap at 2)
    - STAB 克制: 己方有本系克制招式 (+8)，非本系克制 (+4)
    - 生存能力: HP 百分比 / 10 (0-10 分)
    - 危险惩罚: 被对手招式克制 (-5 to -10)，被对手本系属性克制 (-3)
  - `chooseSwitch` 也使用相同评分逻辑
- 修改文件:
  - server/npc/ai/normal.ts: 新增 `scoreSwitchOption`，重构 `evaluateSwitching` 和 `chooseSwitch`
  - test/npc/ai/switching.test.js: 新增换人逻辑测试 (22 个测试用例)
  - test/npc/ai/run-tests.js: 添加 switching 测试模块
- 测试: 285 个测试通过 (新增 22 个换人逻辑测试)

## [1.1.25] - 2026-01-24
- 修复: NormalAI 双打仅剩一只精灵时日志不记录
  - 问题: 双打中第一只精灵倒下后，第二只精灵的决策过程不再记录详细日志
  - 原因: `chooseBestMoveWithScores` 和日志代码使用数组索引查找攻击方
    - `activeIndex = 1` 但 `self.active` 数组只包含存活的精灵(索引 0)
    - 导致 `attacker = undefined`，跳过评分逻辑
  - 修复: 使用 `slot` 属性查找而非数组索引
    - `attackerSlot = activeIndex + 1`
    - `attacker = self.active.find(p => p.slot === attackerSlot)`
- 修改文件:
  - server/npc/ai/normal.ts: 修复 `chooseBestMoveWithScores` 和日志中的攻击方查找逻辑
- 测试: 263 个测试通过 (无新增测试)

## [1.1.24] - 2026-01-24
- 修复: NormalAI Protect 连续使用扣分 (CFRU ai_negatives.c:1939-1962)
  - 问题: 单打中连续使用 Protect 不会扣分
  - 原因: 未追踪己方的 lastMove 和 protectUses
  - 修复:
    - BattleTracker 新增 `ourLastMove` 和 `ourProtectUses` 追踪
    - AIPokemon 新增 `lastMove` 和 `protectUses` 字段 (己方)
    - `checkProtectOveruse` 根据 CFRU 逻辑实现扣分
  - 扣分规则 (基于 CFRU):
    - protectUses >= 2: -10 (几乎必定失败)
    - King's Shield 连续使用: -9
    - protectUses == 1: 单打 -6，双打 -10
    - Quick Guard/Wide Guard/Crafty Shield: 无限使用，不扣分
    - 切换后 protectUses 重置为 0
- 修改文件:
  - server/npc/ai/cfru/types.ts: AIPokemon 新增 protectUses 字段
  - server/npc/ai/cfru/util/battle-tracker.ts: 新增 ourLastMove/ourProtectUses 追踪
  - server/npc/ai/cfru/state-builder.ts: 从 tracker 填充 lastMove/protectUses
  - server/npc/ai/cfru/scoring/negatives.ts: checkProtectOveruse 完整实现
- 测试: 新增 10 个测试用例，总计 263 个测试通过

## [1.1.23] - 2026-01-24
- 增强: NPC 队伍多样化 - 支持每个模式配置多支队伍
  - `templates.json` 队伍配置从单个文件改为文件数组
  - 每次对战随机从队伍列表中选择一支
  - 示例: `"ou": ["team-a.json", "team-b.json"]`
- 修改文件:
  - data/npc/templates.json: 队伍配置改为数组格式
  - server/npc/manager.ts: NPCTeamConfig 类型更新，getTeam() 支持随机选择
- 移除: teamCache (为支持随机选择)

## [1.1.22] - 2026-01-23
- 增强: NormalAI 群攻招式基础奖励条件优化
  - `rewardSpreadMove` 现在只在招式对**其他对手**有效时才给予 +6 基础奖励
  - 之前: 群攻招式总是获得 +6 基础奖励，即使只对一个对手有效 (另一个免疫)
  - 现在: 群攻招式必须对至少一个**额外**对手有效 (effectiveness > 0 且 damage >= 15%)
  - 场景: 地震 KO 对手A + 对手B 免疫 + 杀队友
    - 之前: 100 + 20 + 6 - 25 = 101 (+6 不应给予，因为只命中一个对手)
    - 现在: 100 + 20 - 25 = 95 (正确评估为单目标 KO)
- 修改文件:
  - server/npc/ai/cfru/scoring/positives.ts: `rewardSpreadMove` 添加 `effectiveAgainstOthers` 条件
- 测试: 248 个测试通过

## [1.1.21] - 2026-01-23
- 增强: NormalAI 群攻招式多目标 KO 奖励
  - `rewardSpreadMove` 现在为**其他对手**计算 KO/伤害奖励
  - 之前: 群攻招式只评估第一个目标的 KO 奖励 (+20)，导致双杀对手价值被低估
  - 现在: 群攻招式为每个额外被击杀的对手增加 +20 KO 奖励
  - 评分调整:
    - 基础群攻奖励: +6 (命中多目标)
    - 额外击杀: +20 (每个额外 KO)
    - 先手双杀: +5 (安全双杀奖励)
    - 额外 2HKO: +6
    - 额外中等伤害 (30%+): +3
- 问题修复: 平衡群攻招式击杀队友 vs 击杀对手的权衡
  - 之前: 地震双杀对手 + 杀队友 = 100 + 20 + 6 - 25 = 101 (低估)
  - 现在: 地震双杀对手 + 杀队友 = 100 + 20 + 6 + 20 + 5 - 25 = 126 (正确价值)
- 修改文件:
  - server/npc/ai/cfru/scoring/positives.ts: 增强 `rewardSpreadMove`
- 测试: 248 个测试通过

## [1.1.20] - 2026-01-23
- 增强: NormalAI 双打群攻打队友的伤害评估优化
  - `checkSpreadMoveHitsPartner` 现在计算实际伤害而非固定扣分
  - 扣分根据伤害百分比缩放:
    - 会击杀队友: -25 分
    - 伤害 > 50% HP: -15 分
    - 伤害 > 25% HP: -10 分
    - 低伤害: -5 分
  - 队友吸收特性免疫: 电/水/火/草/地 对应特性
- 新增: 队友吸收特性加分 (`rewardPartnerAbsorption`)
  - 基于 CFRU ai_partner.c lines 62-179
  - Volt Absorb / Water Absorb / Dry Skin: 治愈队友 (+6~+10，视 HP 而定)
  - Motor Drive / Lightning Rod / Storm Drain / Sap Sipper: 提升能力 (+8)
  - Flash Fire: 火招式威力提升 (+8)
  - Justified / Rattled / Steam Engine: 攻击/速度提升 (+6~+10)
- 修改文件:
  - server/npc/ai/cfru/scoring/negatives.ts: `checkSpreadMoveHitsPartner` 伤害缩放
  - server/npc/ai/cfru/scoring/positives.ts: 新增 `rewardPartnerAbsorption`
- 测试: 248 个测试通过

## [1.1.19] - 2026-01-23
- 增强: BasicAI 双打群攻招式总伤害计算
  - 群攻招式 (`allAdjacentFoes`, `allAdjacent`) 现在计算对所有对手的总伤害
  - 应用双打 0.75x 群攻伤害衰减
  - 群攻与单体招式公平比较，选择总伤害最高的招式
  - 示例: 地震 (0 vs 飞行 + 300 vs 路卡利欧) × 0.75 = 225 > 单体 150
- 修改逻辑:
  - 旧逻辑: 群攻招式只对第一个对手评估伤害，忽略第二个对手
  - 新逻辑: 群攻招式计算 (伤害A + 伤害B) × 0.75
- 修改文件:
  - server/npc/ai/basic.ts: `chooseBestMoveWithTarget()` 重构群攻评估
- 文档更新:
  - docs/ai-logic/BasicAI/logic.md: 添加群攻招式评估说明和示例
  - docs/ai-logic/NormalAI/logic.md: 添加选择逻辑说明
- 测试: 248 个测试通过

## [1.1.18] - 2026-01-23
- 修复: BasicAI 双打无限循环问题
  - 问题: 双打中 BasicAI 不断输出 `move 1, move 3` 无限循环
  - 原因: BasicAI 在双打中没有为单体招式提供 `targetPos`，导致 PS 返回 `[Unavailable choice]` 错误
  - PS 收到无效选择后会重发 request（带 `update: true`），`request.isWait` 被重置为 `false`，轮询再次发送相同无效选择
  - 修复: 添加 `getDefaultTargetPos()` 方法，为需要目标的招式提供默认目标
    - `normal`/`any` 目标 → `'1'` (第一个对手)
    - `adjacentAlly`/`adjacentAllyOrSelf` → `'-2'` (队友)
  - 修复位置: 单招式、tracker 无对手信息、只有状态招式三种情况
  - 额外保护: room.ts 添加重试计数器，防止其他原因导致的无限循环
- NormalAI 不受影响: 已有 `getTargetPosition()` 方法作为后备
- 修改文件:
  - server/npc/ai/basic.ts: 添加 `getDefaultTargetPos()`，修复三处目标选择
  - server/npc/room.ts: 添加重试检测和限制 (MAX_RETRIES=3)
- 测试: 248 个测试通过

## [1.1.17] - 2026-01-23
- 增强: BasicAI 支持多段攻击和重量招式威力计算
  - `estimateDamage` 现在使用 `getExpectedHitCount()` 计算多段攻击期望伤害
  - 支持 Skill Link (5 次)、Loaded Dice (4.5 次)、普通 2-5 次 (3 次)
  - 支持重量招式威力计算: Low Kick/Grass Knot、Heavy Slam/Heat Crash
  - 使用 `getWeightBasedPower()` 和 `getWeightRatioPower()` 工具函数
- 增强: BasicAI 支持双打目标选择
  - 新增 `chooseBestMoveWithTarget()` 方法评估所有对手
  - `makeDecision` 现在返回 `targetPos` 用于指定攻击目标
  - 单体招式会选择最优目标，扩散招式只评估一次
- 修改文件:
  - server/npc/ai/basic.ts: 添加多段攻击/重量招式/双打支持
- 测试: 248 个测试通过

## [1.1.16] - 2026-01-23
- 新增: Salt Cure 招式评分系统 (Gen 9)
  - `getSaltCureDamage()`: 计算 Salt Cure 持续伤害 (1/8 HP，水/钢系 1/4 HP)
  - `rewardSaltCure`: 对水/钢系目标额外加分，考虑坦克型目标
  - `checkSaltCure`: 检查 Magic Guard、替身、已有 Salt Cure 状态
  - 将 Salt Cure 加入 `getSecondaryEffectDamage()` 计算
- 基于: CFRU Leech Seed 模式 (ai_positives.c:914, ai_negatives.c:1703)
- 注意: Salt Cure 是 Gen 9 招式，CFRU 没有实现，但遵循类似的评分模式
- 修改文件:
  - server/npc/ai/cfru/util/damage-calc.ts: 添加 getSaltCureDamage
  - server/npc/ai/cfru/scoring/positives.ts: 添加 rewardSaltCure
  - server/npc/ai/cfru/scoring/negatives.ts: 添加 checkSaltCure
- 测试: 新增 15 个测试用例，总计 248 个测试通过

## [1.1.15] - 2026-01-23
- 修复: 双打 tracker 只追踪到 1 只对手
  - `handleSwitch` 错误地把同一边其他位置的精灵设为 inactive
  - 修复: 只把同一位置的之前精灵设为 inactive
- 修复: `getActiveOpponents` 返回格式支持 position 解析
  - 返回 `{ position, pokemon }` 而非单独的 `TrackedPokemon`
  - 从 position (p1a/p1b) 提取正确的 slot (1/2)
- 修改文件:
  - server/npc/ai/cfru/util/battle-tracker.ts: 修复 handleSwitch 和 getActiveOpponents
  - server/npc/ai/cfru/state-builder.ts: 使用新的 getActiveOpponents 格式
- 测试: 233 个测试通过

## [1.1.14] - 2026-01-23
- 修复: 双打目标位置使用数组索引而非实际 slot
  - 当对手有倒下时，数组索引不等于 slot
  - 使用 `target.slot` 代替 `targetIndex + 1`
- 新增: 双打多目标日志 - 显示针对每个对手的招式评分
  - 日志格式: `vs Sinistcha [CHOSEN]:` / `vs Incineroar:`
  - 显示选中的目标和原因
- 修改文件:
  - server/npc/ai/normal.ts: 使用 `targetSlot`，添加 `lastMoveScoresByTarget`
  - server/npc/ai/cfru/logger.ts: 支持多目标日志，新增 `scoresByTarget` 字段
- 测试: 233 个测试通过

## [1.1.13] - 2026-01-23
- 修复: 双打时两只精灵都显示为相同的精灵 (攻击方识别错误)
  - `makeDecision` 添加 `activeIndex` 参数标识当前行动的精灵
  - `chooseBestMoveWithScores` 使用 `activeIndex` 获取正确的攻击方
- 新增: 双打多目标评估 - AI 现在会评估所有对手并选择最优目标
  - 单体招式针对每个对手分别评分
  - 选择伤害/效果最大化的目标
  - 扩散招式 (如地震) 只评估一次
- 修改文件:
  - server/npc/ai/index.ts: `makeDecision` 签名添加 `activeIndex`
  - server/npc/ai/normal.ts: 多目标评估逻辑，返回 `bestTargetPos`
- 测试: 233 个测试通过

## [1.1.12] - 2026-01-23
- 修复: 双打目标选择 bug
  - getTargetPosition 返回 `1` (对手) 而非 `-1` (队友)
  - 正数 = 对手位置, 负数 = 队友位置
- 修复: isTargetingPartner 判断错误
  - 使用对象引用比较而非 slot 数字比较
  - slot 数字在双方可能相同 (都是 1 或 2)，导致误判为攻击队友
- 修改文件:
  - server/npc/ai/normal.ts: 修复 getTargetPosition
  - server/npc/ai/cfru/scoring/index.ts: 修复 isTargetingPartner 判断
- 测试: 233 个测试通过

## [1.1.11] - 2026-01-23
- 新增: 被抵抗招式扣分 (checkTypeResistance)
  - 单抵抗 (0.5x): -2 分
  - 双重抵抗 (0.25x): -5 分
  - 完全免疫由 checkTypeImmunity 处理，不重复扣分
- 新增: 低伤害招式扣分 (checkLowDamage)
  - 基于 CFRU ai_util.c:1021-1027 阈值
  - 极低伤害 (<25% maxHP): -5 分
  - 低伤害 (25-33% maxHP): -2 分
  - 先制招式豁免: 不因低伤害扣分
- 修改文件: server/npc/ai/cfru/scoring/negatives.ts
- 测试: 新增 13 个测试用例，总计 233 个测试通过
- 里程碑: 解决"被抵抗招式没有扣分"的问题

## [1.1.10] - 2026-01-23
- 新增: 自定义难度选择功能
  - 用户可在挑战 NPC 时选择 AI 难度 (Basic / Smart)
  - Basic: 简单 AI，选择最高伤害招式
  - Smart: 高级 AI，使用 CFRU 评分系统
- 修改文件:
  - server/chat-plugins/npc.ts: 添加难度选择 UI 和命令参数
  - server/npc/room.ts: 支持难度参数传递和 AI 实例化
- 命令更新:
  - `/npc challenge [npc], [difficulty]` - 支持难度参数
  - `/npc start [npc], [format], [difficulty]` - 支持难度参数
- 向后兼容: 不指定难度时使用 NPC 模板默认值

## [1.1.9] - 2026-01-23
- 新增: 重量招式威力计算 - Low Kick/Grass Knot/Heavy Slam/Heat Crash
  - getActualWeight(): 计算精灵实际体重，考虑 Light Metal/Heavy Metal/Float Stone
  - getWeightBasedPower(): Low Kick/Grass Knot 根据目标体重计算威力 (20-120)
  - getWeightRatioPower(): Heavy Slam/Heat Crash 根据体重比计算威力 (40-120)
- 基于: CFRU damage_calc.c 第 3521-3569 行、GetActualSpeciesWeight 函数
- 测试: 新增 16 个重量招式测试用例，总计 220 个测试通过
- 里程碑: M1 工具函数完成率提升至 ~80%

## [1.1.8] - 2026-01-23
- 新增: Pain Split HP 检查 (checkPainSplit) - 攻击方HP高于平均时扣分 (-10)
- 新增: Destiny Bond 重复检查 (checkDestinyBond) - 已激活时扣分 (-10)
- 新增: Future Sight/Doom Desire 检查 (checkFutureSight) - 已设置时扣分 (-10)
- 新增: Trick/Switcheroo 检查 (checkTrick) - Sticky Hold/相同道具时扣分 (-10)
- 新增: Recycle 检查 (checkRecycle) - 已有道具时扣分 (-10)
- 新增: Fling 检查 (checkFling) - 无道具/不可投掷/效果免疫时扣分
- 新增: 半无敌招式检查 (checkSemiInvulnerable) - Fly/Dig/Dive/Solar Beam 时机评估
- 测试: 新增 27 个测试用例，总计 204 个测试通过
- 里程碑: M2 Negative 评分完成率达到 ~98%

## [1.1.7] - 2026-01-23
- 新增: Magic Guard 状态招式检查 - 对魔法守护使用毒/烧伤招式扣分 (-10)
- 新增: Venoshock 例外 - 如果攻击方有 Venoshock，中毒仍有价值
- 新增: Covert Cloak 道具检查 - 对有附加效果的招式扣分 (-3)
- 新增: 天气招式队伍受益评分 (rewardWeatherMove) - 根据特性/属性/招式评估天气价值
- 新增: 顺风评分 (rewardTailwind) - 速度劣势时更有价值
- 文档: 补充对手能力值估算说明 (IV=31, EV=85)
- 文档: 添加使用率数据系统规划
- 里程碑: M3 Positive 评分完成率达到 ~100%

## [1.1.6] - 2026-01-23
- 修复: Encore/Disable 逻辑错误 - 改为检查对手上一回合使用的招式 (lastMove)，而非对手招式池
- 新增: BattleTracker 追踪对手 lastMove (对应 CFRU 的 gLastUsedMoves[bankDef])
- 新增: AIPokemon.lastMove 字段用于评分系统
- 新增: getOpponentLastMove() API
- 更新: rewardEncore 和 rewardDisable 使用正确的 lastMove 逻辑
- 测试: 新增 6 个 Encore/Disable 测试用例，总计 159 个测试通过

## [1.1.5] - 2026-01-23
- 新增: 吸血招式加分 (rewardDrainMove) - Drain Punch/Giga Drain 等
- 新增: 腹鼓 HP 检查 (checkBellyDrum) - HP<=50% 或 Contrary 时失败
- 新增: Counter/Mirror Coat 检查 (checkCounterMirrorCoat) - 对手无物理/特殊招式时失败
- 新增: Disable 加分 (rewardDisable) - 对有状态招式的对手更有价值
- 新增: Encore 加分 (rewardEncore) - 对有强化招式的对手更有价值

## [1.1.4] - 2026-01-23
- 新增: 额外伤害计算 (GetSecondaryEffectDamage) - 毒/烧伤/天气/寄生种子
- 新增: 接触招式风险评估 (checkContactRisk) - 铁刺/静电/火焰之躯/木乃伊等
- 新增: 防御强化评估 (rewardDefensiveSetup) - Iron Defense/Amnesia/Cosmic Power
- 新增: 双打队友检查 (checkTargetingPartnerDamage, checkTargetingPartnerStatus)
- 新增: 双打扩散招式队友检查 (checkSpreadMoveHitsPartner)
- 修复: 光墙/反射壁重复使用检查 (checkLightScreenRedundant, checkReflectRedundant)
- 修复: 极光幕天气条件检查 (checkAuroraVeilRedundant)

## [1.1.3] - 2026-01-23
- 新增: 多次攻击伤害计算 (Skill Link/Loaded Dice)
- 修复: 强化招式重复使用评分 (未读取当前 boosts)
- 修复: 隐形岩追踪失败 (协议消息含 "move: " 前缀)

## [1.1.2] - 2026-01-23
- 新增: Quark Drive/Protosynthesis 能力追踪
- 修复: 属性免疫未检测 (Ground vs Flying)
- 修复: 魔法镜 (Magic Bounce) 特性遗漏

## [1.1.1] - 2026-01-22
- 修复: 己方 boosts 读取使用错误的 sides 索引
- 修复: 服务端 battle.sides 不可访问 (改用 BattleTracker)
- 修复: 切换精灵后 boosts 未清空

## [1.1.0] - 2026-01-22
- 新增: NormalAI (CFRU 评分系统)
- 新增: BattleTracker 对手追踪
- 新增: AI 决策日志系统
- 修复: AI 选择机制 (硬编码 BasicAI → 根据 difficulty 选择)
- 修复: AI 无响应 (choose 方法缺少 >p2 前缀)
- 修复: 招式分类识别错误 (category 默认 Status → 从 Dex 查询)
- 修复: 服务端无法获取对手信息 (通过协议消息追踪)

## [1.0.0] - 2026-01-21
- 新增: NPC 模板系统
- 新增: BasicAI (最大伤害选择)
- 新增: /npc 聊天命令
- 新增: 单打/双打/随机对战支持

---

详细变更见 [releases/](./releases/) 目录。
Bug 详情见 [troubleshooting/known-issues.md](./troubleshooting/known-issues.md)。
