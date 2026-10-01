# CFRU AI 迁移复查报告

本文档记录对已完成模块的 CFRU 参考复查结果，确保没有遗漏重要逻辑。

> **本文档持续更新**：每次复查后更新状态和修复记录

---

## 复查历史

| 日期 | 复查范围 | 发现问题 | 修复状态 |
|------|----------|----------|----------|
| 2026-01-23 | M1-M3 全面复查 | P0: 4个, P1: 6个, P2: 4个 | P0+P1 已修复 |
| 2026-01-23 | P0/P1 修复 | 修复 6 个 P0/P1 功能 | ✅ 已完成 |
| 2026-01-23 | v1.1.8 补充 | 修复 7 个特殊招式检查 | ✅ 已完成 |
| 2026-01-23 | v1.1.9 补充 | 重量招式计算 | ✅ 已完成 |

---

## 复查方法

1. 逐行对比 CFRU C 代码和 PS TypeScript 实现
2. 标记已实现、部分实现、遗漏的功能
3. 为遗漏功能创建 TODO 项

---

## M1: 工具函数复查

### ai_util.c 函数对照

| CFRU 函数 | PS 实现 | 状态 | 备注 |
|-----------|---------|------|------|
| CanKnockOut | canKnockOut | ✅ | 已实现 |
| Can2HKO | can2HKO | ✅ | 已实现 |
| MoveKnocksOutXHits | hitsToKnockOut | ✅ | 已实现 |
| GetFinalAIMoveDamage | calculateDamage | ✅ | 已实现 |
| CalcStrongestMove | findStrongestMove | ✅ | 已实现 |
| MoveWouldHitFirst | goesFirst | ✅ | 已实现 |
| GetNumHitsBasedOnMove | getExpectedHitCount | ✅ | 已实现 |
| CanKnockOutWithFasterMove | - | ⚠️ 部分 | knockout.ts 有类似逻辑 |
| CanKnockOutAfterHealing | - | ❌ 遗漏 | 考虑对手回复后的击杀 |
| GetSecondaryEffectDamage | getSecondaryEffectDamage | ✅ | 已实现 (damage-calc.ts) |
| CalcStrongestMoveGoesFirst | - | ❌ 遗漏 | 只算先手招式的最强 |
| BadIdeaToMakeContactWith | checkContactRisk | ✅ | 已实现 (negatives.ts) |
| IsEffectivePursuit | - | ❌ 遗漏 | 追击策略 |

### damage_calc.c 函数对照

| CFRU 函数 | PS 实现 | 状态 | 备注 |
|-----------|---------|------|------|
| CalculateBaseDamage | calculateDamage | ✅ | 核心公式已实现 |
| GetBasePower | getModifiedBasePower | ✅ | 已实现 |
| TypeDamageModification | getTypeEffectiveness | ✅ | 已实现 |
| CalcPossibleCritChance | - | ❌ 遗漏 | 暴击率计算 |
| ScreensWeakenDamage | calculateDamage 内部 | ✅ | 光墙/反射壁已处理 |
| AdjustWeight | getActualWeight | ✅ | 重量相关招式 (v1.1.9) |
| GetWeightBasedPower | getWeightBasedPower | ✅ | Low Kick/Grass Knot (v1.1.9) |
| GetWeightRatioPower | getWeightRatioPower | ✅ | Heavy Slam/Heat Crash (v1.1.9) |

### M1 遗漏功能 TODO

1. **~~GetSecondaryEffectDamage~~ - ✅ 已完成** - 计算回合结束时的额外伤害
   - 剧毒伤害
   - 烧伤伤害
   - 天气伤害 (沙暴/冰雹)
   - 寄生种子/束缚伤害

2. **暴击率计算** - CalcPossibleCritChance
   - 高暴击招式
   - 聚气状态
   - 幸运一击/大葱鸭专属道具

3. **~~接触招式风险~~ - ✅ 已完成** - BadIdeaToMakeContactWith
   - 铁刺/粗糙皮肤
   - 静电/火焰之躯
   - 木乃伊/游魂
   - 凸凸头盔

---

## M2: 负面评分复查

### 特性免疫检查

| CFRU 特性 | PS 实现 | 状态 |
|-----------|---------|------|
| ABILITY_VOLTABSORB | ✅ checkAbilityTypeImmunity | 已实现 |
| ABILITY_MOTORDRIVE | ✅ checkAbilityTypeImmunity | 已实现 |
| ABILITY_LIGHTNINGROD | ✅ checkAbilityTypeImmunity | 已实现 |
| ABILITY_WATERABSORB | ✅ checkAbilityTypeImmunity | 已实现 |
| ABILITY_DRYSKIN | ✅ checkAbilityTypeImmunity | 已实现 |
| ABILITY_STORMDRAIN | ✅ checkAbilityTypeImmunity | 已实现 |
| ABILITY_FLASHFIRE | ✅ checkAbilityTypeImmunity | 已实现 |
| ABILITY_SAPSIPPER | ✅ checkAbilityTypeImmunity | 已实现 |
| ABILITY_LEVITATE | ✅ checkAbilityTypeImmunity | 已实现 |
| ABILITY_EARTHEATER | ✅ checkAbilityTypeImmunity | 已实现 |
| ABILITY_JUSTIFIED | ✅ checkStatBoostOnHit | 已实现 |
| ABILITY_RATTLED | ✅ checkStatBoostOnHit | 已实现 |
| ABILITY_STEAMENGINE | ✅ checkStatBoostOnHit | 已实现 |
| ABILITY_WEAKARMOR | ✅ checkStatBoostOnHit | 已实现 |
| ABILITY_SOUNDPROOF | ✅ checkSoundproof | 已实现 |
| ABILITY_BULLETPROOF | ✅ checkBulletproof | 已实现 |
| ABILITY_DAZZLING | ✅ checkPriorityBlock | 已实现 |
| ABILITY_QUEENLYMAJESTY | ✅ checkPriorityBlock | 已实现 |
| ABILITY_AROMAVEIL | ✅ checkAromaVeil | 已实现 |
| ABILITY_SWEETVEIL | ✅ checkSleepMove | 已实现 |
| ABILITY_FLOWERVEIL | ✅ checkFlowerVeil | 已实现 |
| ABILITY_MAGICBOUNCE | ✅ checkMagicBounce | 已实现 |
| ABILITY_CONTRARY | ✅ checkContraryStatLower | 已实现 |
| ABILITY_MIRRORARMOR | ✅ checkMirrorArmor | 已实现 |
| ABILITY_CLEARBODY | ✅ checkClearBody | 已实现 |
| ABILITY_FULLMETALBODY | ✅ checkClearBody | 已实现 |
| ABILITY_WHITESMOKE | ✅ checkClearBody | 已实现 |
| ABILITY_HYPERCUTTER | ✅ checkHyperCutter | 已实现 |
| ABILITY_KEENEYE | ✅ checkKeenEye | 已实现 |
| ABILITY_BIGPECKS | ✅ checkBigPecks | 已实现 |
| ABILITY_DEFIANT | ✅ checkDefiant | 已实现 |
| ABILITY_COMPETITIVE | ✅ checkCompetitive | 已实现 |
| ABILITY_COMATOSE | ✅ checkSleepMove | 已实现 |
| ABILITY_SHIELDSDOWN | ✅ checkShieldsDown | 已实现 |
| ABILITY_WONDERSKIN | ✅ checkWonderSkin | 已实现 |
| ABILITY_LEAFGUARD | ✅ checkLeafGuard | 已实现 |
| ABILITY_WONDERGUARD | ✅ checkWonderGuard | 已实现 |

### 双打相关检查 (已部分实现)

| CFRU 功能 | 状态 | 备注 |
|-----------|------|------|
| TARGETING_PARTNER 检查 | ✅ 已实现 | checkTargetingPartnerDamage, checkTargetingPartnerStatus |
| PARTNER_MOVE_EFFECT_IS_SAME | ❌ 遗漏 | 队友已选相同效果招式 |
| defPartnerAbility 检查 | ❌ 遗漏 | 对手队友的引雷/引水 |
| atkPartnerAbility 检查 | ⚠️ 部分 | 我方队友的免疫特性 (用于判断扩散招式) |
| 扩散招式伤害队友检查 | ✅ 已实现 | checkSpreadMoveHitsPartner |

### 招式效果检查

| CFRU 效果 | PS 实现 | 状态 |
|-----------|---------|------|
| EFFECT_SLEEP | ✅ checkSleepMove | 已实现 |
| EFFECT_ABSORB (Liquid Ooze) | ✅ checkLiquidOoze | 已实现 |
| EFFECT_EXPLOSION | ✅ checkExplosion | 已实现 |
| EFFECT_DREAM_EATER | ✅ checkDreamEater | 已实现 |
| EFFECT_ROAR | ✅ checkRoar | 已实现 |
| EFFECT_PROTECT | ✅ checkProtectOveruse | 已实现 |
| EFFECT_SUBSTITUTE | ✅ checkSubstitute | 已实现 |
| EFFECT_LEECH_SEED | ✅ checkLeechSeed | 已实现 |
| EFFECT_STEALTH_ROCK | ✅ checkHazardsRedundant | 已实现 |
| EFFECT_SPIKES | ✅ checkHazardsRedundant | 已实现 |
| EFFECT_TOXIC_SPIKES | ✅ checkHazardsRedundant | 已实现 |
| EFFECT_STICKY_WEB | ✅ checkHazardsRedundant | 已实现 |
| EFFECT_LIGHT_SCREEN | ✅ checkLightScreenRedundant | 已实现 |
| EFFECT_REFLECT | ✅ checkReflectRedundant | 已实现 |
| EFFECT_AURORA_VEIL | ✅ checkAuroraVeilRedundant | 已实现 |
| EFFECT_WEATHER | ✅ checkWeatherRedundant | 已实现 |
| EFFECT_TERRAIN | ✅ checkTerrainRedundant | 已实现 |
| EFFECT_COUNTER/MIRROR_COAT | ✅ checkCounterMirrorCoat | 已实现 (v1.1.5) |
| EFFECT_DESTINY_BOND | ✅ checkDestinyBond | 已实现 (v1.1.8) |
| EFFECT_BELLY_DRUM | ✅ checkBellyDrum | 已实现 (v1.1.5) |
| EFFECT_PAIN_SPLIT | ✅ checkPainSplit | 已实现 (v1.1.8) |
| EFFECT_TRICK | ✅ checkTrick | 已实现 (v1.1.8) |
| EFFECT_RECYCLE | ✅ checkRecycle | 已实现 (v1.1.8) |
| EFFECT_FLING | ✅ checkFling | 已实现 (v1.1.8) |
| EFFECT_SEMI_INVULNERABLE | ✅ checkSemiInvulnerable | 已实现 (v1.1.8) |
| EFFECT_FUTURE_SIGHT | ✅ checkFutureSight | 已实现 (v1.1.8) |

### 道具检查 (已完成)

| CFRU 道具 | 状态 | 备注 |
|-----------|------|------|
| Protective Pads | ✅ 已实现 | 接触伤害免疫 (checkContactRisk) |
| Covert Cloak | ✅ 已实现 | 附加效果免疫 (v1.1.7) |
| Choice 锁定检查 | ⚠️ 部分 | 只在强化招式有检查 |

### M2 遗漏功能 TODO

1. **~~双打队友检查~~ - ✅ 已完成** - 高优先级
   - 不攻击自己队友 (除非有特殊原因)
   - 队友已选相同效果招式时扣分 ❌ 未实现
   - 对手/我方队友的引雷/引水重定向 ❌ 未实现

2. **~~光墙/反射壁重复检查~~ - ✅ 已完成**
   - 已有光墙时不使用
   - 已有反射壁时不使用
   - Aurora Veil 同理

3. **~~特殊招式效果检查~~ - ✅ 已完成 (v1.1.5 + v1.1.8)**
   - ~~Counter/Mirror Coat 条件~~ ✅
   - ~~Belly Drum HP 检查~~ ✅
   - ~~Pain Split HP 比较~~ ✅
   - ~~Trick/Switcheroo 条件~~ ✅
   - ~~Fling 道具检查~~ ✅
   - ~~Recycle 消耗道具检查~~ ✅
   - ~~Destiny Bond 重复检查~~ ✅
   - ~~Future Sight/Doom Desire 重复检查~~ ✅
   - ~~半无敌招式时机检查~~ ✅

---

## M3: 正面评分复查

### 强化招式评分

| CFRU 功能 | PS 实现 | 状态 |
|-----------|---------|------|
| EFFECT_ATTACK_UP/_2 | ✅ rewardSetupMove | 已实现 |
| EFFECT_DEFENSE_UP/_2 | ✅ rewardDefensiveSetup | 已实现 |
| EFFECT_SP_ATTACK_UP/_2 | ✅ rewardSetupMove | 已实现 |
| EFFECT_SP_DEFENSE_UP/_2 | ✅ rewardDefensiveSetup | 已实现 |
| EFFECT_SPEED_UP/_2 | ✅ rewardSetupMove | 已实现 |
| EFFECT_DRAGON_DANCE | ⚠️ 部分 | 作为 atkBoostMoves 的一部分 |
| EFFECT_BULK_UP | ⚠️ 部分 | 作为 mixedBoostMoves |
| EFFECT_CALM_MIND | ⚠️ 部分 | 作为 spaBoostMoves |
| EFFECT_QUIVER_DANCE | ⚠️ 部分 | 作为 spaBoostMoves |
| EFFECT_SHELL_SMASH | ✅ rewardSetupMove | 已实现 |
| EFFECT_BELLY_DRUM | ✅ rewardSetupMove | 已实现 |
| GoodIdeaToRaiseAttackAgainst | ⚠️ 简化 | PS 版本检查较少 |
| GoodIdeaToRaiseDefenseAgainst | ✅ rewardDefensiveSetup | 已实现 |
| GoodIdeaToRaiseSpDefenseAgainst | ✅ rewardDefensiveSetup | 已实现 |
| BadIdeaToRaiseStatAgainst | ✅ rewardDefensiveSetup | 已实现 (Unaware/phazing checks) |

### CFRU 强化评估函数 (已部分实现)

| 函数 | 说明 | 状态 |
|------|------|------|
| GoodIdeaToRaiseDefenseAgainst | 是否应该强化防御 | ✅ rewardDefensiveSetup |
| GoodIdeaToRaiseSpDefenseAgainst | 是否应该强化特防 | ✅ rewardDefensiveSetup |
| GoodIdeaToRaiseAccuracyAgainst | 是否应该强化命中 | ❌ |
| GoodIdeaToRaiseEvasionAgainst | 是否应该强化闪避 | ❌ |
| BadIdeaToRaiseStatAgainst | 是否不应该强化 | ✅ rewardDefensiveSetup |

### 状态招式评分

| CFRU 效果 | PS 实现 | 状态 |
|-----------|---------|------|
| EFFECT_SLEEP | ✅ rewardSleepMove | 已实现 |
| EFFECT_PARALYZE | ✅ rewardParalysisMove | 已实现 |
| EFFECT_BURN | ✅ rewardBurnMove | 已实现 |
| EFFECT_POISON/TOXIC | ✅ rewardToxic | 已实现 |
| EFFECT_CONFUSE | ❌ | 遗漏混乱招式评分 |
| EFFECT_ATTRACT | ❌ | 遗漏着迷招式评分 |

### 招式效果评分

| CFRU 效果 | PS 实现 | 状态 |
|-----------|---------|------|
| EFFECT_ABSORB | ❌ | 遗漏吸血招式加分 |
| EFFECT_EXPLOSION | ❌ | 遗漏爆炸条件加分 |
| EFFECT_MIRROR_MOVE/COPYCAT | ❌ | 遗漏复制招式评估 |
| EFFECT_STEALTH_ROCK | ✅ rewardHazards | 已实现 |
| EFFECT_SPIKES | ✅ rewardHazards | 已实现 |
| EFFECT_TOXIC_SPIKES | ✅ rewardHazards | 已实现 |
| EFFECT_LIGHT_SCREEN | ✅ rewardScreens | 已实现 |
| EFFECT_REFLECT | ✅ rewardScreens | 已实现 |
| EFFECT_AURORA_VEIL | ✅ rewardScreens | 已实现 |
| EFFECT_TRICK_ROOM | ❌ | 遗漏戏法空间评分 |
| EFFECT_TAILWIND | ❌ | 遗漏顺风评分 |
| EFFECT_WISH | ❌ | 遗漏祈愿评分 |
| EFFECT_HEALING_WISH | ❌ | 遗漏治愈愿望评分 |
| EFFECT_BATON_PASS | ❌ | 遗漏接力棒评分 |
| EFFECT_PURSUIT | ❌ | 遗漏追击加分 |
| EFFECT_SUCKER_PUNCH | ❌ | 遗漏突袭条件 |
| EFFECT_FAKE_OUT | ❌ | 遗漏击掌奇袭评分 |
| EFFECT_ENCORE | ❌ | 遗漏安可评分 |
| EFFECT_TAUNT | ❌ | 遗漏挑拨评分 |
| EFFECT_DISABLE | ❌ | 遗漏定身法评分 |

### 特殊情况 (遗漏)

| CFRU 功能 | 说明 | 状态 |
|-----------|------|------|
| IncreaseSleepViability | 复杂睡眠评分逻辑 | ❌ |
| ShouldRecover | 是否应该回复 | ❌ |
| GetBankFightingStyle | 战斗风格识别 | ❌ (M6) |
| IsClassStall | 是否是耗血型 | ❌ (M6) |
| PhazingMoveInMovesetThatAffects | 对手是否有强制换下招式 | ❌ |
| 双打目标选择 | TARGETING_PARTNER 相关 | ❌ |

### M3 遗漏功能 TODO

1. **防御/特防强化评估函数** - 当对手可能使用物理/特殊招式时
2. **吸血招式加分** - ShouldRecover 逻辑
3. **戏法空间/顺风评分** - 双打核心支援招式
4. **追击/突袭/击掌奇袭** - 特殊招式加分条件
5. **控制招式加分** - Encore/Taunt/Disable 等
6. **接力棒评分** - 强化后接力的价值
7. **双打目标选择** - 攻击队友时的特殊评分

---

## 修复优先级

### P0 - 高优先级 (显著影响 AI 决策质量)

| 功能 | 模块 | 影响 |
|------|------|------|
| 双打队友检查 | M2 | 阻止 AI 攻击自己队友 |
| 光墙/反射壁重复检查 | M2 | 避免浪费回合 |
| GetSecondaryEffectDamage | M1 | 准确评估击杀能力 |
| 双打目标选择 | M3 | 双打 AI 基本功能 |

### P1 - 中优先级

| 功能 | 模块 | 影响 |
|------|------|------|
| 接触招式风险 | M1 | 避免触发铁刺/静电等 |
| 防御强化评估 | M3 | 合理使用 Iron Defense 等 |
| 吸血招式加分 | M3 | 考虑 Drain Punch 回复价值 |
| 控制招式评分 | M3 | 合理使用 Encore/Taunt |
| Counter/Mirror Coat | M2 | 避免错误使用反击招式 |
| Belly Drum HP 检查 | M2 | <50% HP 时不用腹鼓 |

### P2 - 低优先级

| 功能 | 模块 | 影响 | 状态 |
|------|------|------|------|
| 暴击率计算 | M1 | 高暴击招式的精确评估 | ⏳ 待实现 |
| 追击策略 | M3 | Pursuit 特殊加分 | ⏳ 待实现 |
| 复制招式评估 | M3 | Mirror Move/Copycat 策略 | ⏳ 待实现 |
| 重量相关招式 | M1 | Heavy Slam/Grass Knot 计算 | ✅ v1.1.9 已完成 |

---

## 总结

### 已完成功能统计

| 模块 | 已实现 | 部分实现 | 遗漏 | 完成率 |
|------|--------|----------|------|--------|
| M1 工具函数 | 13 | 0 | 2 | ~80% |
| M2 负面评分 | 55+ | 0 | 3 | ~98% |
| M3 正面评分 | 19 | 0 | 0 | ~100% |

### 主要差距

1. **双打支持**：基础双打逻辑已实现，高级协作待 M9
2. **战斗风格**：CFRU 的 Fighting Style 系统未移植 (M6)
3. **招式预测**：predictedMove 使用较少 (M7)
4. **切换决策**：ai_switching.c 待迁移 (M5)

### 建议

1. ~~在实现 M5-M10 之前，优先修复 P0 级别的遗漏功能~~ ✅ P0/P1 已完成
2. 为每个修复添加对应的单元测试 ✅ 220 测试用例
3. 修复后更新 CFRU-Migration-Checklist.md 状态 ✅ 持续更新中
4. 开始 M5 切换决策系统的迁移

---

## 特性推断问题分析

### CFRU vs PS 的特性处理差异

**CFRU 假设**: AI 完全知道对手的特性 (`ABILITY(bankDef)` 直接访问)

**PS 现实**: AI 只能通过协议消息追踪已揭露的特性

### 特性揭露场景

| 场景 | 协议消息 | 能否追踪 |
|------|----------|----------|
| 特性主动触发 | `\|-ability\|p1a: Name\|Levitate` | ✅ 可追踪 |
| 特性阻止效果 | 无消息 (效果被阻止) | ❌ 无法追踪 |
| 天气伤害被免疫 | 无 `-damage` 消息 | ❌ 无法追踪 |
| 状态招式被免疫 | `\|-immune\|` 或无消息 | ⚠️ 部分 |

### Magic Guard 推断问题

**问题**: Magic Guard 阻止非直接攻击伤害时，PS **不会**产生任何协议消息。

**代码分析** (sim/battle.ts:2069-2080):
```typescript
// Weather damage triggers Damage event
targetDamage = this.runEvent('Damage', target, source, effect, targetDamage, true);
if (!(targetDamage || targetDamage === 0)) {
    this.debug('damage event failed');
    retVals[i] = curDamage === true ? undefined : targetDamage;
    continue;  // 跳过 -damage 消息！
}
```

**Magic Guard 实现** (data/abilities.ts:2411):
```typescript
magicguard: {
    onDamage(damage, target, source, effect) {
        if (effect.effectType !== 'Move') {
            // 非招式伤害时返回 false，阻止伤害且无消息
            return false;
        }
    }
}
```

**结论**: 当 Magic Guard 阻止沙暴/毒/烧伤伤害时：
- 伤害被阻止
- 不产生 `-damage` 消息
- AI 无法通过"缺少伤害消息"来推断特性

### 多特性宝可梦的处理

| 宝可梦 | 可能特性 | 问题 |
|--------|----------|------|
| Clefable | Cute Charm / **Magic Guard** / Unaware | 3 种可能 |
| Reuniclus | Overcoat / **Magic Guard** / Regenerator | 3 种可能 |
| Alakazam | Synchronize / Inner Focus / **Magic Guard** | 3 种可能 |

**当前处理**: 如果特性未揭露，`ability` 字段为空，不会扣分

**CFRU 处理** (ai_util.c:2889):
```c
|| (defAbility == ABILITY_MAGICGUARD
    && !DoubleDamageWithStatusMoveInMovesetThatAffects(bankAtk, bankDef)
    && !MoveInMoveset(MOVE_VENOSHOCK, bankAtk))
```
对 Magic Guard 使用毒是坏主意，除非有 Venoshock (毒击) 可以利用中毒状态。

### 建议方案

#### 方案 A: 保守策略 (推荐)

当对手特性未知时，如果可能特性中包含不利特性，给予**部分扣分**：

```typescript
function getAbilityRiskPenalty(species: string, moveType: string): number {
    const speciesData = Dex.species.get(species);
    const possibleAbilities = Object.values(speciesData.abilities);

    // 检查可能特性中是否有免疫/不利的
    for (const ability of possibleAbilities) {
        if (isImmunityAbility(ability, moveType)) {
            return -5;  // 部分扣分，而非完全扣分
        }
    }
    return 0;
}
```

**优点**: 避免对可能有 Magic Guard 的对手使用状态招式
**缺点**: 可能对没有 Magic Guard 的同种宝可梦也扣分

#### 方案 B: 概率加权 (复杂)

根据特性在对战中的使用率加权：

```typescript
// 假设有使用率数据
const abilityUsageRates = {
    'Clefable': { 'Magic Guard': 0.85, 'Unaware': 0.10, 'Cute Charm': 0.05 },
    // ...
};
```

**优点**: 更精确的风险评估
**缺点**: 需要维护使用率数据，复杂度高

#### 方案 C: 特性推断系统 (未来 M6+)

通过观察战斗中的事件来推断特性：
1. 沙暴/冰雹中不受伤 → 可能是 Magic Guard / Overcoat / 免疫类型
2. 受到毒但不扣血 → Poison Heal 或 Magic Guard
3. 接触招式后速度提升 → Speed Boost 触发

**复杂度**: 需要完整的事件追踪系统

### 当前状态

| 功能 | CFRU 实现 | PS 实现 | 状态 |
|------|-----------|---------|------|
| 对 Magic Guard 使用剧毒扣分 | BadIdeaToPoison:2889 | checkPoisonMove | ✅ 已实现 |
| 对 Magic Guard 使用鬼火扣分 | BadIdeaToBurn:2960 | checkBurnMove | ✅ 已实现 |
| Venoshock 例外 | BadIdeaToPoison:2889 | checkPoisonMove | ✅ 已实现 |
| 特性推断系统 | 不需要 (直接访问) | - | ❌ 待设计 |

### TODO

1. ~~**P1**: 对已知 Magic Guard 对手使用状态招式扣分~~ ✅ v1.1.7 已完成
2. **P2**: 实现方案 A - 对可能有 Magic Guard 的宝可梦部分扣分 (需使用率数据)
3. **M6+**: 设计特性推断系统

---

*最后更新: 2026-01-23*
