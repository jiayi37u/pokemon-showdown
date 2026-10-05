# CFRU AI 迁移对照清单

本文档追踪 CFRU AI 功能的迁移状态，确保不遗漏。

## CFRU 源码位置

**路径**: `/ssd3/lvjiawei01/projects/Complete-Fire-Red-Upgrade/src/Battle_AI/`

## 模块迁移总览

| 文件 | 说明 | 里程碑 | 版本 | 迁移状态 | 完成率 |
|------|------|--------|------|----------|--------|
| ai_util.c, damage_calc.c | 工具函数 (伤害/速度) | M1 | v1.1 | ⚠️ 部分攻击/防御/双打特性遗漏 | ~75% |
| ai_negatives.c | 负面评分 (~50 个 case) | M2 | v1.1 | ✅ 完成（Sucker Punch 简化版 v1.2.21） | ~100% |
| ai_positives.c | 正面评分 (~30 个 case) | M3 | v1.1 | ✅ 完成 | ~100% |
| - | NormalAI 整合 | M4 | v1.1 | ✅ 核心完成 | 100% |
| ai_switching.c | 切换决策 | M5 | v1.2 | ⏳ 待开始 | 0% |
| ai_advanced.c | 战斗风格识别 | M6 | v1.2 | ⏳ 待开始 | 0% |
| ai_advanced.c | 招式预测 | M7 | v1.2 | ⏳ 待开始 | 0% |
| - | HardAI 整合 | M8 | v1.2 | ⏳ 待开始 | 0% |
| ai_partner.c | 双打协作 | M9 | v1.3 | ⏳ 待开始 | 0% |
| - | ExpertAI 整合 | M10 | v1.3 | ⏳ 待开始 | 0% |

> **注意**: 详细复查报告见 [CFRU-Review-Report.md](./CFRU-Review-Report.md)

---

## Negative 评分 - 特性检查

| CFRU 特性 | 中文名 | 效果 | 状态 |
|-----------|--------|------|------|
| ABILITY_VOLTABSORB | 蓄电 | 电系免疫 | ✅ |
| ABILITY_MOTORDRIVE | 电气引擎 | 电系免疫 | ✅ |
| ABILITY_LIGHTNINGROD | 引雷 | 电系免疫 | ✅ |
| ABILITY_WATERABSORB | 储水 | 水系免疫 | ✅ |
| ABILITY_DRYSKIN | 干燥皮肤 | 水系免疫 | ✅ |
| ABILITY_STORMDRAIN | 引水 | 水系免疫 | ✅ |
| ABILITY_FLASHFIRE | 引火 | 火系免疫 | ✅ |
| ABILITY_SAPSIPPER | 食草 | 草系免疫 | ✅ |
| ABILITY_LEVITATE | 飘浮 | 地面免疫 | ✅ |
| ABILITY_EARTHEATER | 食土 | 地面免疫 | ✅ |
| ABILITY_JUSTIFIED | 正义之心 | 恶系提升攻击 | ✅ |
| ABILITY_RATTLED | 胆怯 | 恶/幽灵/虫提升速度 | ✅ |
| ABILITY_STEAMENGINE | 蒸汽机 | 火/水提升速度 | ✅ |
| ABILITY_SOUNDPROOF | 隔音 | 声音招式免疫 | ✅ |
| ABILITY_BULLETPROOF | 防弹 | 球类招式免疫 | ✅ |
| ABILITY_DAZZLING | 鲜艳之躯 | 先制招式免疫 | ✅ |
| ABILITY_QUEENLYMAJESTY | 女王的威严 | 先制招式免疫 | ✅ |
| ABILITY_AROMAVEIL | 芳香幕 | 精神招式免疫 | ✅ |
| ABILITY_SWEETVEIL | 甜幕 | 睡眠免疫 | ✅ |
| ABILITY_FLOWERVEIL | 花幕 | 草系状态免疫 | ✅ |
| ABILITY_MAGICBOUNCE | 魔法镜 | 反弹状态招式 | ✅ |
| ABILITY_CONTRARY | 唱反调 | 能力变化反转 | ✅ |
| ABILITY_MIRRORARMOR | 镜甲 | 反弹能力下降 | ✅ |
| ABILITY_CLEARBODY | 恒净之躯 | 能力不下降 | ✅ |
| ABILITY_FULLMETALBODY | 金属防护 | 能力不下降 | ✅ |
| ABILITY_WHITESMOKE | 白色烟雾 | 能力不下降 | ✅ |
| ABILITY_HYPERCUTTER | 怪力钳 | 攻击不下降 | ✅ |
| ABILITY_KEENEYE | 锐利目光 | 命中不下降 | ✅ |
| ABILITY_BIGPECKS | 健壮胸肌 | 防御不下降 | ✅ |
| ABILITY_DEFIANT | 不服输 | 能力下降时提升攻击 | ✅ |
| ABILITY_COMPETITIVE | 好胜 | 能力下降时提升特攻 | ✅ |
| ABILITY_COMATOSE | 绝对睡眠 | 状态免疫 | ✅ |
| ABILITY_SHIELDSDOWN | 界限盾壳 | 状态免疫(>50%HP) | ✅ |
| ABILITY_WONDERSKIN | 奇迹皮肤 | 状态招式命中-50% | ✅ |
| ABILITY_LEAFGUARD | 叶子防守 | 晴天状态免疫 | ✅ |
| ABILITY_WONDERGUARD | 神奇守护 | 非克制免疫 | ✅ |
| ABILITY_MAGICGUARD | 魔法守护 | 状态招式伤害无效 | ✅ |

> **注意**: Magic Guard 使毒/烧伤等持续伤害无效，对其使用状态招式会扣分 (-10)。
> 特例：如果攻击方有 Venoshock，中毒仍有价值（不扣分）。
> 详见 [CFRU-Review-Report.md#特性推断问题分析](./CFRU-Review-Report.md#特性推断问题分析)

## Negative 评分 - 招式效果检查

| CFRU 效果 | 描述 | 状态 |
|-----------|------|------|
| EFFECT_SLEEP | 睡眠招式 | ✅ |
| EFFECT_ABSORB | 吸收招式 (Liquid Ooze) | ✅ |
| EFFECT_EXPLOSION | 自爆招式 | ✅ |
| EFFECT_DREAM_EATER | 食梦 | ✅ |
| EFFECT_ROAR | 吼叫 (Suction Cups/Ingrain) | ✅ |
| EFFECT_STAT_UP/DOWN | 能力变化 | ✅ |
| EFFECT_RESTORE_HP | 回复招式 | ✅ |
| EFFECT_REST | 睡眠回复 | ✅ |
| EFFECT_POISON/TOXIC | 中毒招式 | ✅ |
| EFFECT_PARALYZE | 麻痹招式 | ✅ |
| EFFECT_CONFUSE | 混乱招式 | ✅ |
| EFFECT_LIGHT_SCREEN | 光墙 | ✅ |
| EFFECT_REFLECT | 反射壁 | ✅ |
| EFFECT_SUBSTITUTE | 替身 | ✅ |
| EFFECT_LEECH_SEED | 寄生种子 | ✅ |
| EFFECT_DISABLE | 定身法 | ✅ |
| EFFECT_ENCORE | 再来一次 | ✅ |
| EFFECT_TAUNT | 挑拨 | ✅ |
| EFFECT_TORMENT | 无理取闹 | ✅ |
| EFFECT_PROTECT | 保护 | ✅ |
| EFFECT_STEALTH_ROCK | 隐形岩 | ✅ |
| EFFECT_SPIKES | 撒菱 | ✅ |
| EFFECT_TOXIC_SPIKES | 毒菱 | ✅ |
| EFFECT_STICKY_WEB | 黏黏网 | ✅ |
| EFFECT_WEATHER | 天气招式 | ✅ |
| EFFECT_TERRAIN | 地形招式 | ✅ |
| EFFECT_SLEEP_TALK | 梦话 (非睡眠时扣分) | ✅ v1.2.13 |
| EFFECT_SNORE | 打鼾 (非睡眠时扣分) | ✅ v1.2.13 |
| EFFECT_SUCKER_PUNCH | 突袭 (对手无攻击招式/用状态招式时扣分) | ✅ v1.2.21（lastMove 近似，未等 M7 招式预测） |

## Negative 评分 - 道具检查

| 道具 | 效果 | 状态 |
|------|------|------|
| Air Balloon | 地面免疫 | ✅ |
| Safety Goggles | 粉末免疫 | ✅ |
| Protective Pads | 接触伤害免疫 | ✅ |
| Covert Cloak | 附加效果免疫 | ✅ |

---

## 伤害计算 - 固定伤害招式

**状态**: ✅ v1.2.21 完成（见 `computeFixedDamage` in `damage-calc.ts`）

| 招式 | AI 伤害估算 | 状态 |
|------|------|------|
| Super Fang (愤怒门牙) | 对手当前 HP 的 50% | ✅ v1.2.21 |
| Dragon Rage (龙之怒) | 固定 40 | ✅ v1.2.21 |
| Sonic Boom (音爆) | 固定 20 | ✅ v1.2.21 |
| Seismic Toss (地球上投) | 使用者等级（Fighting，Ghost 免疫） | ✅ v1.2.21 |
| Night Shade (黑夜魔影) | 使用者等级（Ghost） | ✅ v1.2.21 |
| Psywave (精神波) | min=level/2, max=level*3/2 | ✅ v1.2.21 |
| Endeavor (蛮干) | 对手HP - 自己HP（≤0 不打） | ✅ v1.2.21 |
| Final Gambit (搏命) | 自己当前 HP | ✅ v1.2.21 |
| Counter (双倍奉还) | 对手上招（物理）伤害 × 2，否则 0 | ✅ v1.2.21 |
| Mirror Coat (镜面反射) | 对手上招（特殊）伤害 × 2，否则 0 | ✅ v1.2.21 |
| Metal Burst (金属爆炸) | 对手上招（任意伤害）× 1.5，否则 0 | ✅ v1.2.21 |

**实现要点**:
- 固定伤害分支放在类型免疫 / Wonder Guard 之后，常规公式之前
- Counter/Mirror Coat/Metal Burst 的"受到伤害"用 `defender.lastMove` 反向跑一次常规 `calculateDamage`
  估算（CFRU 走的是实际伤害记录，我们没有协议级 damage 记录，用 lastMove 的估算是近似）
- 对手 `lastMove` 空或类别不匹配 → 返回 0，避免 AI 空读
- 回归测试：`test/npc/ai/ai-damage-calc.test.js`（11 个固定伤害用例）

---

## 伤害计算 - 攻击方特性

> **CFRU 源文件**: `damage_calc.c` (第 3800-4100 行)

| CFRU 特性 | 中文名 | 效果 | 代码位置 | 状态 |
|-----------|--------|------|----------|------|
| ABILITY_TECHNICIAN | 技术高手 | 威力≤60 招式 1.5x | :3851 | ✅ |
| ABILITY_IRONFIST | 铁拳 | 拳击招式 1.2x | :3872 | ✅ |
| ABILITY_RECKLESS | 蛮力 | 反作用招式 1.2x | :3919 | ✅ |
| ABILITY_SHEERFORCE | 强行 | 附加效果招式 1.3x | :3907 | ✅ |
| ABILITY_TOUGHCLAWS | 坚硬爪 | 接触招式 1.3x | :3963 | ✅ |
| ABILITY_STRONGJAW | 强壮之颚 | 咬类招式 1.5x | :3955 | ✅ |
| ABILITY_MEGALAUNCHER | 超级发射器 | 波动招式 1.5x | :3859 | ✅ |
| ABILITY_HUGEPOWER | 大力士 | ATK 2x | :3678 | ✅ |
| ABILITY_PUREPOWER | 瑜伽之力 | ATK 2x | :3678 | ✅ |
| ABILITY_HUSTLE | 活力 | ATK 1.5x | :3686 | ✅ |
| ABILITY_GUTS | 毅力 | 异常状态时 ATK 1.5x | :3692 | ✅ |
| ABILITY_SOLARPOWER | 太阳之力 | 晴天 SPA 1.5x | :3700 | ✅ |
| ABILITY_SKILLLINK | 连续攻击 | 多段攻击保证5次 | - | ✅ |
| ABILITY_ADAPTABILITY | 适应力 | STAB 2x (非1.5x) | :826, :1076 | ❌ |
| ABILITY_TINTEDLENS | 有色眼镜 | 抵抗招式 2x | :3107 | ❌ |
| ABILITY_NEUROFORCE | 脑核之力 | 超效招式 1.25x | :3971 | ❌ |
| ABILITY_WATERBUBBLE | 水泡 (攻击) | 水招式 2x | :3990 | ❌ |
| ABILITY_PUNKROCK | 朋克摇滚 (攻击) | 声音招式 1.3x | :4002 | ❌ |
| ABILITY_STEELWORKER | 钢之意志 | 钢招式 1.5x | :3983 | ❌ |
| ABILITY_STEELYSPIRIT | 钢之精神 | 钢招式 1.5x (双打) | :3984 | ❌ |
| ABILITY_ANALYTIC | 分析 | 后手 1.3x | :3996 | ❌ |
| ABILITY_TRANSISTOR | 电晶体 | 电招式 1.5x | :4008 | ❌ |
| ABILITY_DRAGONSMAW | 龙颚 | 龙招式 1.5x | :4013 | ❌ |

---

## 伤害计算 - 防御方特性

> **CFRU 源文件**: `damage_calc.c` (第 3100-3200 行)

| CFRU 特性 | 中文名 | 效果 | 代码位置 | 状态 |
|-----------|--------|------|----------|------|
| ABILITY_THICKFAT | 厚脂肪 | 火/冰 0.5x | :3123 | ✅ |
| ABILITY_HEATPROOF | 耐热 | 火 0.5x | :3145 | ✅ |
| ABILITY_WATERBUBBLE | 水泡 (防御) | 火 0.5x | :3146 | ✅ |
| ABILITY_FURCOAT | 毛皮大衣 | DEF 2x | :3063 | ✅ |
| ABILITY_MARVELSCALE | 奇迹鳞片 | 异常状态时 DEF 1.5x | :3056 | ✅ |
| ABILITY_GRASSPELT | 青草皮肤 | 草场 DEF 1.5x | :3069 | ✅ |
| ABILITY_MULTISCALE | 多重鳞片 | 满HP 0.5x | :3152 | ✅ |
| ABILITY_SHADOWSHIELD | 幻影守护 | 满HP 0.5x | :3153 | ✅ |
| ABILITY_WONDERGUARD | 神奇守护 | 非超效免疫 | - | ✅ |
| ABILITY_FILTER | 过滤 | 超效 0.75x | :3138 | ❌ |
| ABILITY_SOLIDROCK | 坚硬岩石 | 超效 0.75x | :3136 | ❌ |
| ABILITY_PRISMARMOR | 棱镜装甲 | 超效 0.75x | :3139 | ❌ |
| ABILITY_FLUFFY | 毛茸茸 | 火 2x, 接触 0.5x | :3159 | ❌ |
| ABILITY_ICESCALES | 冰鳞粉 | 特攻 0.5x | :3175 | ❌ |
| ABILITY_PUNKROCK | 朋克摇滚 (防御) | 声音招式 0.5x | :3169 | ❌ |

---

## 伤害计算 - 双打特性

> **CFRU 源文件**: `damage_calc.c` (第 3183 行)

| CFRU 特性 | 中文名 | 效果 | 代码位置 | 状态 |
|-----------|--------|------|----------|------|
| ABILITY_FRIENDGUARD | 友情防守 | 队友受伤 0.75x | :3183 | ❌ |

---

## 伤害计算 - 道具

> **CFRU 源文件**: `damage_calc.c` (第 3020-3100 行, 3186-3200 行)

| 道具 | 效果 | 代码位置 | 状态 |
|------|------|----------|------|
| Life Orb | 伤害 1.3x | :3023 | ✅ |
| Choice Band | ATK 1.5x | :3010 | ✅ |
| Choice Specs | SPA 1.5x | :3015 | ✅ |
| Expert Belt | 超效 1.2x | :3028 | ✅ |
| Type-boosting items | 属性 1.2x | :3033+ | ✅ |
| Loaded Dice | 多段攻击 4-5次 | - | ✅ |
| Thick Club | Cubone/Marowak ATK 2x | :3004 | ✅ |
| Light Ball | Pikachu ATK/SPA 2x | :3007 | ✅ |
| Eviolite | NFE DEF/SPD 1.5x | :3047 | ✅ |
| Assault Vest | SPD 1.5x | :3052 | ✅ |
| 半减果 (抵抗果) | 超效 0.5x | :3188 | ❌ |
| Metronome | 连续使用 1.2x/次 | :3038 | ❌ |

---

## Positive 评分

| 效果类型 | 描述 | 状态 |
|----------|------|------|
| 击杀奖励 | KO bonus | ✅ |
| 高伤害奖励 | Damage% bonus | ✅ |
| STAB 奖励 | 本系加成 | ✅ |
| 克制奖励 | Super effective | ✅ |
| 先制击杀 | Priority KO | ✅ |
| 睡眠招式 | Sleep moves | ✅ |
| 麻痹招式 | Paralysis moves | ✅ |
| 灼伤招式 | Burn moves | ✅ |
| 剧毒招式 | Toxic moves | ✅ |
| 强化招式 | Setup moves | ✅ |
| 防御强化 | Defensive setup | ✅ |
| 入场伤害 | Entry hazards | ✅ |
| 回复招式 | Recovery moves | ✅ |
| 光墙/反射壁 | Screens | ✅ |
| 戏法空间 | Trick Room | ✅ |
| 挑衅 | Taunt | ✅ |
| 交换招式 | U-turn/Volt Switch | ✅ |
| 双打扩散招式 | Spread move partner check | ✅ |
| 天气/地形 | Weather/Terrain 队伍受益 | ✅ |
| 顺风 | Tailwind 速度劣势时 | ✅ |
| 梦话/打鼾 | Sleep Talk/Snore 睡眠时 | ✅ v1.2.13 |

---

## 统计

- **M1 工具函数**: 已实现 31 个，遗漏 ~18 个 (~75%)
  - v1.1.9: 新增重量招式计算 (getActualWeight, getWeightBasedPower, getWeightRatioPower)
  - v1.2.10: 新增 Spread Move 伤害递减
  - v1.2.21: 新增固定伤害招式（Seismic Toss / Night Shade / Dragon Rage / Sonic Boom / Super Fang / Endeavor / Final Gambit / Psywave / Counter / Mirror Coat / Metal Burst）
  - 遗漏: 攻击特性 10 个, 防御特性 6 个, 道具 2 个
- **M2 Negative 评分**: 已实现 ~56 个，遗漏 ~3 个 (~98%)
  - v1.2.21: Sucker Punch 简化版（lastMove 近似，未等 M7 招式预测）
- **M3 Positive 评分**: 已实现 19 个，遗漏 0 个 (~100%)

### P0 级别遗漏 (高优先级修复)

| 功能 | 模块 | 影响 | 状态 |
|------|------|------|------|
| 双打队友检查 | M2 | 阻止 AI 攻击自己队友 | ✅ 已完成 |
| 光墙/反射壁重复检查 | M2 | 避免浪费回合 | ✅ 已完成 |
| GetSecondaryEffectDamage | M1 | 准确评估击杀能力 | ✅ 已完成 |
| 双打目标选择 | M3 | 双打 AI 基本功能 | ✅ 已完成 |
| 固定伤害招式计算 | M1 | Super Fang/Dragon Rage 等返回 0 伤害 | ✅ v1.2.21 |

### P1 级别遗漏

| 功能 | 模块 | 影响 | 状态 |
|------|------|------|------|
| 接触招式风险 | M2 | 避免触发铁刺/静电等 | ✅ 已完成 |
| 防御强化评估 | M3 | 合理使用 Iron Defense 等 | ✅ 已完成 |
| 吸血招式加分 | M3 | 考虑 Drain Punch 回复价值 | ✅ 已完成 |
| 控制招式评分 | M3 | 合理使用 Encore/Disable | ✅ 已完成 |
| Counter/Mirror Coat | M2 | 避免错误使用反击招式 | ✅ 已完成 |
| Belly Drum HP 检查 | M2 | <50% HP 时不用腹鼓 | ✅ 已完成 |
| Sucker Punch 评分 | M2 | 对手无攻击招式/用状态招式时误用突袭 | ✅ v1.2.21（lastMove 近似版） |

### P2 级别遗漏 - 伤害计算特性/道具 (待实现)

| 功能 | 模块 | 影响 | 优先级 |
|------|------|------|--------|
| Filter/Solid Rock/Prism Armor | M1 | 超效伤害高估 25% | 高 |
| Adaptability | M1 | STAB 伤害低估 33% | 高 |
| Tinted Lens | M1 | 抵抗伤害低估 50% | 高 |
| Fluffy | M1 | 火伤害低估/接触伤害高估 | 中 |
| Ice Scales | M1 | 特攻伤害高估 50% | 中 |
| Neuroforce | M1 | 超效伤害低估 20% | 中 |
| Friend Guard | M1 | 双打伤害高估 25% | 中 |
| Water Bubble (攻击) | M1 | 水系伤害低估 50% | 低 |
| Punk Rock | M1 | 声音招式伤害偏差 | 低 |
| Steelworker/Transistor/Dragon's Maw | M1 | 特定属性伤害低估 | 低 |
| Analytic | M1 | 后手伤害低估 | 低 |
| 半减果 | M1 | 超效伤害高估 | 低 |

> 详细遗漏功能列表见 [CFRU-Review-Report.md](./CFRU-Review-Report.md)

---

## 迁移流程

1. **列出 CFRU 功能**
   ```bash
   grep -n "case ABILITY_" ai_negatives.c
   grep -n "case EFFECT_" ai_negatives.c
   ```

2. **逐个对照实现**，记录 CFRU 源码行号

3. **在本清单中标记状态**
   - ✅ 已实现
   - ❌ 待实现
   - ⚠️ 部分实现

---

*最后更新: 2026-10-05 (v1.2.21 固定伤害招式 + Counter/Mirror Coat/Metal Burst + Sucker Punch 简化)*

**相关文档**:
- Bug 详情见 [troubleshooting/known-issues.md](../npc-battle/troubleshooting/known-issues.md)
- 开发原则见 [CLAUDE.md](../../CLAUDE.md)

---

## 待迁移模块

### M5: 切换决策 (ai_switching.c)

**CFRU 主要函数**:
- `ShouldSwitch()` - 判断是否应该切换
- `GetMostSuitableMonToSwitchInto()` - 选择最佳换入

**切换条件** (待实现):
| 条件 | 说明 | 状态 |
|------|------|------|
| 灭亡之歌倒计时=1 | 必须切换 | ⏳ |
| 神奇守护无克制招式 | 应该切换 | ⏳ |
| 特性吸收 (蓄电/储水/引火) | 可以换入吸收 | ⏳ |
| 自然回复/再生力 | 有状态/低血量时切换 | ⏳ |
| 哈欠且无保护 | 可以切换 | ⏳ |
| 即将被击杀 | 有更好替换时切换 | ⏳ |

**切换评分权重** (来自 CFRU):
```c
Pokemon_CAN_KO = 31
POKEMON_OUTSPEEDS = 14
POKEMON_RESISTS_ALL = 17
POKEMON_WALLS_FOE = 2
POKEMON_CAN_2HKO = 2
POKEMON_FAINTS_FROM_FOE = -39
```

---

### M6: 战斗风格识别 (ai_advanced.c)

**单打风格** (11 种):
| 风格 | 说明 |
|------|------|
| FIGHTING_STYLE_SWEEPER_PHYS | 物攻清扫 |
| FIGHTING_STYLE_SWEEPER_SPEC | 特攻清扫 |
| FIGHTING_STYLE_WALL_PHYS | 物防墙 |
| FIGHTING_STYLE_WALL_SPEC | 特防墙 |
| FIGHTING_STYLE_TANK_PHYS | 物攻坦克 |
| FIGHTING_STYLE_TANK_SPEC | 特攻坦克 |
| FIGHTING_STYLE_STALL | 耗血 |
| FIGHTING_STYLE_SETUP | 强化 |
| FIGHTING_STYLE_SUPPORT | 辅助 |
| FIGHTING_STYLE_REVENGE_KILLER | 复仇杀手 |
| FIGHTING_STYLE_TRAPPER | 陷阱 |

---

### M7: 招式预测 (ai_advanced.c)

**预测内容**:
- 对手下回合招式预测
- 对手切换预测
- 预测影响评分权重

**基础设施** (v1.1.6 已完成):
| 组件 | CFRU 对应 | 状态 |
|------|-----------|------|
| lastMove 追踪 | `gLastUsedMoves[bankDef]` | ✅ 已完成 |
| getOpponentLastMove API | - | ✅ 已完成 |

> `lastMove` 追踪是招式预测的基础，已在 v1.1.6 为 Encore/Disable 实现。

---

### M8: HardAI 整合

**整合内容**:
- 整合 M5 (切换决策) + M6 (战斗风格) + M7 (招式预测)
- 调优评分权重
- 测试与调试

---

### M9: 双打协作 (ai_partner.c)

**协作逻辑**:
| 功能 | 说明 | 状态 |
|------|------|------|
| 队友保护 | 保护濒死队友 | ⏳ |
| 扩散招式评估 | 地震/冲浪不伤队友 | ⏳ |
| 帮助之手 | 给队友加成 | ⏳ |
| 协同攻击 | 集火同一目标 | ⏳ |
| 跟我来 | 吸引攻击保护队友 | ⏳ |

---

### M10: ExpertAI 整合

**整合内容**:
- 整合 M9 双打协作逻辑
- 完整信息模式可选
- 高级策略 (团队构筑识别、胜率计算)
- 长期规划 (多回合策略)
