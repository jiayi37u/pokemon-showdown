# v1.1 设计文档

## 架构概览

```
NormalAI
    │
    ├─ handleMoveRequest()
    │   │
    │   ├─ buildBattleState()      # 构建战斗状态
    │   │   ├─ 从 request 读取己方信息
    │   │   ├─ 从 BattleTracker 读取对手信息
    │   │   └─ 从 BattleTracker 读取场地状态
    │   │
    │   ├─ evaluateSwitching()     # 评估是否换人
    │   │
    │   └─ scoreMove()             # 为每个招式评分
    │       │
    │       ├─ calculateDamage()   # 伤害计算
    │       ├─ negativeScoring()   # 负面评分（扣分）
    │       └─ positiveScoring()   # 正面评分（加分）
    │
    └─ choose()                    # 发送选择给服务端
```

---

## 核心组件设计

### 1. BattleTracker - 对手状态追踪器

**设计目标**: 解决服务端架构限制，通过协议消息追踪对手信息。

#### 数据结构

```typescript
interface TrackedPokemon {
    species: string;          // 种类
    types: string[];          // 属性
    level: number;            // 等级
    hp: number;               // 当前 HP
    maxhp: number;            // 最大 HP
    ability?: string;         // 特性（暴露后）
    item?: string;            // 道具（暴露后）
    itemLost: boolean;        // 道具是否已失去
    boosts: BoostsTable;      // 能力变化
    status?: string;          // 异常状态
    volatiles: Set<string>;   // 临时状态
    lastMove?: string;        // 上一回合使用的招式
    hasRevealedInfo: boolean; // 是否有信息暴露
}

interface BattleState {
    weather?: string;         // 天气
    terrain?: string;         // 地形
    sideConditions: {         // 场地状态
        [side: string]: Set<string>;
    };
}
```

#### 协议消息处理

| 消息类型 | 格式 | 处理逻辑 |
|---------|------|----------|
| `switch` | `\|switch\|p1a: Name\|Species, L50\|100/100` | 记录种类、属性、HP |
| `move` | `\|move\|p1a: Name\|Earthquake\|p2a: Target` | 记录 lastMove |
| `-ability` | `\|-ability\|p1a: Name\|Levitate` | 记录特性 |
| `-item` | `\|-item\|p1a: Name\|Air Balloon` | 记录道具 |
| `-enditem` | `\|-enditem\|p1a: Name\|Air Balloon` | 标记道具已失去 |
| `-boost` | `\|-boost\|p1a: Name\|atk\|2` | 更新 boosts |
| `-unboost` | `\|-unboost\|p1a: Name\|def\|1` | 更新 boosts |
| `-status` | `\|-status\|p1a: Name\|slp` | 记录异常状态 |
| `-weather` | `\|-weather\|Sandstorm` | 记录天气 |
| `-terrain` | `\|-terrain\|Electric Terrain` | 记录地形 |
| `-sidestart` | `\|-sidestart\|p1: Player\|Stealth Rock` | 记录场地状态 |

#### 关键实现

**切换后清除状态**:
```typescript
handleSwitch(position: string, details: string, hpStatus: string) {
    // 切换时清除 boosts、volatiles、lastMove
    const pokemon = this.getOrCreatePokemon(position);
    pokemon.boosts = { /* 全部归零 */ };
    pokemon.volatiles.clear();
    pokemon.lastMove = undefined;
    // 保留 species, ability, item 等永久信息
}
```

**道具追踪**:
```typescript
// v1.1.30 优化: 区分"未知"和"已失去"
handleItem(position: string, item: string) {
    const pokemon = this.getOrCreatePokemon(position);
    pokemon.item = item;
    pokemon.itemLost = false;  // 道具已知，未失去
}

handleEndItem(position: string) {
    const pokemon = this.getOrCreatePokemon(position);
    pokemon.item = '';
    pokemon.itemLost = true;   // 道具已确认失去
}
```

### 2. 伤害计算系统

基于 CFRU `damage_calc.c` 实现。

#### 完整伤害公式

```typescript
// 基础伤害
baseDamage = floor(floor(floor(2 * level / 5 + 2) * power * atk / def) / 50) + 2;

// 最终伤害
finalDamage = baseDamage
    × targets      // 多目标修正 (双打群攻 0.75x)
    × weather      // 天气修正
    × critical     // 会心 (2.0x)
    × random       // 随机 (0.85 ~ 1.0)
    × stab         // 本系 (1.5x 或 2.0x 适应力)
    × type         // 属性克制 (0x, 0.25x, 0.5x, 1x, 2x, 4x)
    × burn         // 灼伤 (物理招式 0.5x)
    × other        // 其他修正
```

#### 攻击/防御能力值计算

```typescript
// 基础能力值（估算）
baseAtk = floor((2 * baseStat + 31 + floor(85/4)) * level / 100) + 5;

// 应用能力变化阶段
const stage = pokemon.boosts.atk || 0;
const multiplier = stage >= 0
    ? (2 + stage) / 2
    : 2 / (2 - stage);
finalAtk = floor(baseAtk * multiplier);

// 特性修正
if (ability === 'Huge Power') finalAtk *= 2;
if (ability === 'Guts' && hasStatus) finalAtk *= 1.5;
// ... 其他特性
```

#### 威力修正

```typescript
let power = move.basePower;

// 特性修正
if (ability === 'Technician' && power <= 60) power *= 1.5;
if (ability === 'Iron Fist' && move.flags['punch']) power *= 1.2;

// 道具修正
if (item === 'Choice Band' && move.category === 'Physical') power *= 1.5;
if (item === 'Life Orb') power *= 1.3;

// 天气修正
if (weather === 'Sun' && move.type === 'Fire') power *= 1.5;
if (weather === 'Rain' && move.type === 'Water') power *= 1.5;

// 地形修正
if (terrain === 'Electric' && move.type === 'Electric' && isGrounded) power *= 1.3;
```

#### 防御方特性修正

```typescript
// Multiscale / Shadow Shield
if ((ability === 'Multiscale' || ability === 'Shadow Shield')
    && targetHP === targetMaxHP) {
    damage *= 0.5;
}

// Filter / Solid Rock / Prism Armor
if ((ability === 'Filter' || ability === 'Solid Rock' || ability === 'Prism Armor')
    && effectiveness > 1) {
    damage *= 0.75;
}

// Thick Fat
if (ability === 'Thick Fat' && (moveType === 'Fire' || moveType === 'Ice')) {
    damage *= 0.5;
}
```

#### 多段攻击

```typescript
function getExpectedHitCount(move, ability, item) {
    if (ability === 'Skill Link') return 5;
    if (item === 'Loaded Dice') return 4.5;

    // 固定次数
    if (move.id === 'surgingstrikes') return 3;
    if (move.id === 'watershuriken' && species === 'Greninja-Ash') return 3;

    // 2-5 次攻击
    if (move.multihit && Array.isArray(move.multihit)) return 3;

    return 1;
}
```

#### 重量招式威力

```typescript
// Low Kick / Grass Knot
function getWeightBasedPower(targetWeight: number): number {
    if (targetWeight >= 200) return 120;
    if (targetWeight >= 100) return 100;
    if (targetWeight >= 50) return 80;
    if (targetWeight >= 25) return 60;
    if (targetWeight >= 10) return 40;
    return 20;
}

// Heavy Slam / Heat Crash
function getWeightRatioPower(attackerWeight: number, targetWeight: number): number {
    const ratio = attackerWeight / targetWeight;
    if (ratio >= 5) return 120;
    if (ratio >= 4) return 100;
    if (ratio >= 3) return 80;
    if (ratio >= 2) return 60;
    return 40;
}

// 考虑特性和道具
function getActualWeight(pokemon): number {
    let weight = Dex.species.get(pokemon.species).weightkg;
    if (pokemon.ability === 'Light Metal') weight /= 2;
    if (pokemon.ability === 'Heavy Metal') weight *= 2;
    if (pokemon.item === 'Float Stone') weight /= 2;
    return weight;
}
```

### 3. 评分引擎

#### 评分流程

```typescript
function scoreMove(move, state) {
    let score = 100;  // 基础分

    // 1. 负面评分（扣分）
    score += checkTypeImmunity(move, state);       // -100
    score += checkAbilityImmunity(move, state);    // -20
    score += checkTypeResistance(move, state);     // -5/-20
    score += checkLowDamage(move, state);          // -3/-8/-20
    score += checkStatusFails(move, state);        // -10/-20
    score += checkSetupMaxed(move, state);         // -100
    score += checkRecoveryWaste(move, state);      // -2/-5/-20
    // ... 更多检查

    // 2. 正面评分（加分）
    score += rewardKO(move, state);                // +20~+28
    score += rewardHighDamage(move, state);        // +2~+10
    score += rewardSTAB(move, state);              // +3
    score += rewardSuperEffective(move, state);    // +4~+15
    score += rewardStatusMove(move, state);        // +12~+20
    score += rewardSetupMove(move, state);         // +8~+15
    // ... 更多奖励

    return score;
}
```

#### 负面评分规则

| 函数 | CFRU 对应 | 扣分 | 条件 |
|------|-----------|------|------|
| `checkTypeImmunity` | ai_negatives.c:98-118 | -100 | 地面 vs 飞行 |
| `checkAbilityImmunity` | ai_negatives.c:120-260 | -20 | 电系 vs 蓄电 |
| `checkTypeResistance` | ai_negatives.c:新增 | -5/-20 | 0.5x / 0.25x |
| `checkLowDamage` | ai_util.c:1021-1027 | -3/-8/-20 | <33% / 20% / 10% |
| `checkStatusFails` | ai_negatives.c:484-640 | -10/-20 | 已有状态/特性阻止 |
| `checkSetupMaxed` | ai_negatives.c:805-850 | -100 | 能力已 +6 |
| `checkRecoveryWaste` | ai_negatives.c:1153-1165 | -2/-5/-20 | HP > 60%/70%/80% |
| `checkProtectOveruse` | ai_negatives.c:1939-1962 | -20 | 上回合使用 Protect |
| `checkSleepClause` | battle_util.c:2018-2037 | -20 | 睡眠条款违规 |

#### 正面评分规则

| 函数 | CFRU 对应 | 加分 | 条件 |
|------|-----------|------|------|
| `rewardKO` | ai_positives.c:72-104 | +20/+23/+28 | 能击杀/先制击杀/保证击杀 |
| `rewardHighDamage` | ai_positives.c:106-136 | +2~+10 | 伤害 > 33% |
| `rewardSTAB` | ai_positives.c:141-145 | +3 | 本系招式 |
| `rewardSuperEffective` | ai_positives.c:147-161 | +4/+8/+15 | 2x / 4x 克制 |
| `rewardSleepMove` | ai_positives.c:619-657 | +12~+20 | 睡眠招式 |
| `rewardParalysisMove` | ai_positives.c:659-704 | +12~+16 | 麻痹招式 |
| `rewardBurnMove` | ai_positives.c:706-743 | +10~+15 | 灼伤招式 |
| `rewardSetupMove` | ai_positives.c:769-853 | +8~+15 | 强化招式 |
| `rewardEntryHazard` | ai_positives.c:855-912 | +10~+15 | 隐形岩/撒菱 |
| `rewardKnockOff` | 新增（基于竞技经验） | +5~+8 | 拍落道具 |

### 4. 换人决策

#### v1.1 简化版换人逻辑

```typescript
function evaluateSwitching(state) {
    // 1. 检查是否应该换人（动态阈值）
    const maxAttackScore = Math.max(...attackMoveScores);
    const maxStatusScore = Math.max(...statusMoveScores);

    if (maxAttackScore <= 95 && maxStatusScore <= 90) {
        // 2. 评估所有可换入精灵
        const switchOptions = availableSwitches.map(p => ({
            pokemon: p,
            score: scoreSwitchOption(p, state)
        }));

        // 3. 选择得分最高的换入
        const best = switchOptions.sort((a, b) => b.score - a.score)[0];

        if (best.score > maxAttackScore && best.score > maxStatusScore) {
            return `switch ${best.pokemon.position}`;
        }
    }

    return null;  // 不换人
}
```

#### 换人评分

```typescript
function scoreSwitchOption(pokemon, state) {
    let score = 0;

    // 属性优势
    if (isImmuneToOpponentMove(pokemon)) score += 12;
    if (resistsOpponentMove(pokemon)) score += 6;  // 每个抵抗招式 +6（最多 2 个）

    // 攻击优势
    if (hasSTABSuperEffectiveMove(pokemon)) score += 8;
    if (hasSuperEffectiveMove(pokemon)) score += 4;

    // 生存能力
    score += pokemon.hp / pokemon.maxhp * 10;  // 0-10 分

    // 危险惩罚
    if (weakToOpponentMove(pokemon)) score -= 5;
    if (weakToOpponentSTAB(pokemon)) score -= 3;

    return score;
}
```

**阈值设计理由**:

| 场景 | 攻击分 | 状态分 | 是否换人 |
|------|-------|-------|---------|
| 本系技能 + <20%伤害 | 95 | - | ✅ 换人 (<= 95) |
| 对手已有状态 | - | 85 | ✅ 换人 (< 90) |
| 正常状态招式 | - | 100+ | ❌ 不换 (≥ 90) |

### 5. 双打支持

#### 多目标评估

```typescript
function chooseBestMoveWithScores(state) {
    const opponents = getActiveOpponents();
    const results = [];

    for (const move of availableMoves) {
        if (isSpreadMove(move)) {
            // 群攻招式：只评估一次，不指定目标
            const score = scoreMove(move, state);
            results.push({ move, score, targetPos: undefined });
        } else {
            // 单体招式：针对每个对手评分
            for (const opponent of opponents) {
                const score = scoreMove(move, state, opponent);
                results.push({ move, score, targetPos: opponent.slot });
            }
        }
    }

    // 选择得分最高的 move + target 组合
    const best = results.sort((a, b) => b.score - a.score)[0];
    return { move: best.move, targetPos: best.targetPos };
}
```

#### 队友保护

```typescript
// 检查伤害招式是否误伤队友
function checkTargetingPartnerDamage(move, state) {
    if (!isTargetingPartner(move, state)) return 0;

    const damage = calculateDamage(move, state.self.active[0], state.partner);
    const damagePercent = damage / state.partner.maxhp;

    if (damagePercent >= 1.0) return -25;  // 击杀队友
    if (damagePercent >= 0.5) return -15;  // 重伤队友
    if (damagePercent >= 0.25) return -10; // 中等伤害
    return -5;  // 低伤害
}

// 检查群攻招式打队友
function checkSpreadMoveHitsPartner(move, state) {
    if (!isSpreadMove(move)) return 0;

    // 检查队友吸收特性
    if (partnerAbsorbsMove(move, state)) {
        return rewardPartnerAbsorption(move, state);  // +6~+10
    }

    // 计算对队友的伤害（×0.75 群攻衰减）
    const damage = calculateDamage(move, attacker, state.partner) * 0.75;
    const damagePercent = damage / state.partner.maxhp;

    if (damagePercent >= 1.0) return -25;
    if (damagePercent >= 0.5) return -15;
    if (damagePercent >= 0.25) return -10;
    return -5;
}
```

#### 群攻招式多目标奖励

```typescript
function rewardSpreadMove(move, state) {
    if (!isSpreadMove(move)) return 0;

    const opponents = getActiveOpponents();
    if (opponents.length < 2) return 0;

    let score = 0;
    let effectiveAgainstOthers = false;

    // 检查是否对其他对手有效
    for (let i = 1; i < opponents.length; i++) {
        const effectiveness = getEffectiveness(move, opponents[i]);
        const damage = calculateDamage(move, attacker, opponents[i]) * 0.75;
        if (effectiveness > 0 && damage >= 0.15 * opponents[i].maxhp) {
            effectiveAgainstOthers = true;

            // 额外 KO 奖励
            if (damage >= opponents[i].hp) {
                score += 20;  // 击杀额外对手
                if (isFasterThan(attacker, opponents[i])) score += 5;  // 先手击杀
            }
            // 额外伤害奖励
            else if (damage >= 0.5 * opponents[i].maxhp) score += 6;   // 2HKO
            else if (damage >= 0.3 * opponents[i].maxhp) score += 3;   // 中等伤害
        }
    }

    // 基础群攻奖励（仅当对其他对手有效时）
    if (effectiveAgainstOthers) score += 6;

    return score;
}
```

---

## 关键技术决策

### 决策 1: 对手能力值估算

**问题**: AI 无法获取对手的 IV、EV、性格。

**方案**:
```typescript
IV = 31         // 满个体值（竞技标准）
EV = 85         // 平均努力值（510/6）
Nature = 1.0    // 中性性格
```

**理由**:
- 竞技对战都是满 IV
- 平均 EV 适用于随机对战情况

**误差分析**:
```
真实胡地 (Timid, 252 Spe): 189 速度
估算胡地 (Neutral, 85 EV): 151 速度
误差: 38 / 189 = 20%
```

**未来优化**: 使用率数据系统（v2.0）可以改进估算。

### 决策 2: 换人阈值设计

**问题**: 什么时候应该换人？

**CFRU 方案**: 复杂的切换评估（ai_switching.c）

**v1.1 简化方案**: 基于评分阈值

```
maxAttackScore <= 95 && maxStatusScore <= 90
```

**阈值选择理由**:

| 阈值 | 触发场景 | 理由 |
|------|---------|------|
| 95 | 本系 + 较低伤害 | 留场价值低 |
| 90 | 对手已有状态 | 状态招式无效 |

**测试验证**:
- 被克制且低伤害 → 正确换人
- 本系招式且正常伤害 → 不换人
- 对手已睡眠 → 不使用催眠粉

### 决策 3: 双打目标位置格式

**PS 格式**:
```
1, 2    = 对手位置
-1, -2  = 己方位置
```

**选择理由**:
1. PS 官方格式，无需转换
2. 正负号区分敌我，清晰直观
3. 数字对应场上位置（左/右）

**实现注意事项**:
- 使用 `target.slot` 而非数组索引
- 队友判断使用对象引用比较
- 扩散招式不指定目标位置

---

## 性能优化

### 1. Dex 查询缓存

PS 的 `Dex.moves.get()` 内部已有缓存，无需额外优化。

### 2. 伤害计算优化

```typescript
// 避免重复计算
const damageCache = new Map<string, number>();

function calculateDamageWithCache(move, attacker, target) {
    const key = `${move.id}-${attacker.species}-${target.species}`;
    if (damageCache.has(key)) return damageCache.get(key);

    const damage = calculateDamage(move, attacker, target);
    damageCache.set(key, damage);
    return damage;
}
```

实测：单次决策时间 < 50ms，无需缓存。

### 3. 评分函数优先级

将快速检查放在前面（如免疫检查），避免不必要的计算：

```typescript
// ✅ 好的顺序
if (checkTypeImmunity()) return -100;  // 快速检查
if (checkAbilityImmunity()) return -20;
// ... 复杂计算

// ❌ 差的顺序
const damage = calculateDamage();  // 昂贵计算
if (checkTypeImmunity()) return -100;  // 计算浪费
```

---

## 测试策略

### 单元测试

| 模块 | 测试文件 | 覆盖率目标 |
|------|---------|-----------|
| 伤害计算 | damage-calc.test.js | > 95% |
| 类型相克 | type-effectiveness.test.js | 100% |
| BattleTracker | battle-tracker.test.js | > 90% |
| 负面评分 | negatives.test.js | > 95% |
| 正面评分 | positives.test.js | > 95% |
| 换人逻辑 | switching.test.js | > 90% |

### 集成测试

场景测试：
1. 完整对战流程（单打/双打）
2. 特殊场景（天气队、入场伤害队）
3. 边界情况（满强化、濒死换人）

### CFRU 对照测试

对照 CFRU 源码验证评分逻辑：
```bash
# 搜索 CFRU 中的扣分阈值
grep -n "score -=" ai_negatives.c

# 对比 PS 实现
grep -n "score +=" negatives.ts
```

---

## 限制与已知问题

### v1.1 限制

1. **换人决策简化**: 未实现 CFRU 的完整切换评估（M5）
2. **无招式预测**: 不预测对手下一步行动（M7）
3. **对手能力估算**: 使用固定值，不进行动态推断
4. **战斗风格识别**: 不识别对手风格（M6）

### 已知问题

见 [troubleshooting/known-issues.md](../../troubleshooting/known-issues.md)。

---

## 后续版本规划

### v1.3 (M5-M8)

1. **M5: 切换决策系统** - 完整实现 CFRU ai_switching.c
2. **M6: 战斗风格识别** - 11 种单打风格、8 种双打风格
3. **M7: 招式预测** - 预测对手下一步行动
4. **M8: HardAI 整合** - 整合 M5-M7 功能

### v1.4 (M9-M10)

1. **M9: 双打协作** - 完整实现 CFRU ai_partner.c
2. **M10: ExpertAI 整合** - 最高难度 AI

---

*最后更新: 2026-01-24*

