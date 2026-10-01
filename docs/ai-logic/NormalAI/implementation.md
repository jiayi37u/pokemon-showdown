# NormalAI 技术实现

## 类结构

```typescript
class NormalAI extends NPCBattleAI {
    readonly difficulty = 'normal';

    private cfruConfig: CFRUAIConfig;
    private scoringEngine: ScoringEngine;
    private aiCache: AICache;
    private battleState: BattleState | null;
    private battleRef: AnyObject | null;
    private battleTracker: BattleTracker | null;
    private logger: AIDecisionLogger;

    constructor(playerStream, options?: NormalAIOptions, debug?);

    setBattle(battle: AnyObject): void;
    getLogger(): AIDecisionLogger;

    protected makeDecision(active, moves, switches, flags): Decision;
    protected chooseBestMove(active, moves): MoveChoice;
    private evaluateSwitching(active, moves, switches): SwitchEvaluationResult;
}
```

## 配置类型

```typescript
interface CFRUAIConfig {
    useFullInfo: boolean;      // 是否使用完整对手信息
    usePrediction: boolean;    // 是否使用招式预测
    useFightingStyle: boolean; // 是否使用战斗风格分类
    isDoubles: boolean;        // 是否双打
}

interface NormalAIOptions {
    seed?: PRNG | PRNGSeed | null;
    cfruConfig?: Partial<CFRUAIConfig>;
    logging?: {
        console?: LogLevel;
        file?: LogLevel;
        logDir?: string;
    };
    battleId?: string;
}
```

## 评分引擎

### ScoringEngine 类

```typescript
class ScoringEngine {
    constructor(config: CFRUAIConfig, cache: AICache);

    scoreMoves(
        state: BattleState,
        attacker: AIPokemon,
        moves: AIMove[],
        target: AIPokemon
    ): MoveScore[];

    scoreMove(
        state: BattleState,
        attacker: AIPokemon,
        move: AIMove,
        target: AIPokemon
    ): MoveScore;
}
```

### MoveScore 结构

```typescript
interface MoveScore {
    move: AIMove;
    score: number;
    breakdown: {
        base: number;       // 100
        negatives: number;  // 扣分总计
        positives: number;  // 加分总计
        final: number;
        details: ScoreAdjustment[];
    };
    flags: {
        canKO: boolean;
        can2HKO: boolean;
        goesFirst: boolean;
        isImmune: boolean;
        isSuperEffective: boolean;
    };
}
```

## 评分函数

### Negatives (negatives.ts)

```typescript
type NegativeScoringFunction = (ctx: ScoringContext) => number;

// 免疫检查
checkTypeImmunity(ctx): number;           // -100
checkAbilityTypeImmunity(ctx): number;    // -20
checkItemTypeImmunity(ctx): number;       // -20 (Air Balloon)
checkWonderGuard(ctx): number;            // -100

// 特性相关
checkMagicBounce(ctx): number;            // -20
checkSoundproof(ctx): number;             // -10
checkBulletproof(ctx): number;            // -10
checkPriorityBlock(ctx): number;          // -10 (Dazzling等)
checkStatBoostOnHit(ctx): number;         // -1~-9 (Justified等)

// 能力下降相关
checkMirrorArmor(ctx): number;            // -20
checkClearBody(ctx): number;              // -10
checkDefiant(ctx): number;                // -10
checkCompetitive(ctx): number;            // -10
checkContraryStatLower(ctx): number;      // -20

// 状态招式
checkSleepMove(ctx): number;              // -10~-20
checkParalysisMove(ctx): number;          // -15~-20
checkBurnMove(ctx): number;               // -15~-20
checkPoisonMove(ctx): number;             // -15~-20
checkConfusionMove(ctx): number;          // -10

// 重复设置
checkHazardsRedundant(ctx): number;       // -10
checkWeatherRedundant(ctx): number;       // -10
checkTerrainRedundant(ctx): number;       // -10
checkLightScreenRedundant(ctx): number;   // -10
checkReflectRedundant(ctx): number;       // -10
checkAuroraVeilRedundant(ctx): number;    // -10

// 其他
checkStatBoostWasted(ctx): number;        // 0~-100
checkHealingUnnecessary(ctx): number;     // -3~-8
checkContactRisk(ctx): number;            // -1~-5 (铁刺等)
checkBellyDrum(ctx): number;              // -5~-100 (HP/Contrary检查)
checkCounterMirrorCoat(ctx): number;      // -3~-10 (物理/特殊招式检查)

// 双打相关
checkTargetingPartnerDamage(ctx): number; // -15
checkTargetingPartnerStatus(ctx): number; // -5~-100
checkSpreadMoveHitsPartner(ctx): number;  // -5~-10
```

### Positives (positives.ts)

```typescript
type PositiveScoringFunction = (ctx: ScoringContext) => number;

// 伤害相关
rewardKnockout(ctx): number;           // +20~+28
rewardHighDamage(ctx): number;         // +2~+10
rewardSTAB(ctx): number;               // +3
rewardSuperEffective(ctx): number;     // +4~+8
rewardPriorityKO(ctx): number;         // +10

// 状态招式
rewardSleepMove(ctx): number;          // +12~+20
rewardParalysisMove(ctx): number;      // +4~+10
rewardBurnMove(ctx): number;           // +4~+10
rewardToxic(ctx): number;              // +4~+15

// 强化招式
rewardSetupMove(ctx): number;          // +6~+18 (攻击/特攻/速度强化)
rewardDefensiveSetup(ctx): number;     // +6~+12 (防御/特防强化)

// 场地控制
rewardHazards(ctx): number;            // +4~+10
rewardScreens(ctx): number;            // +6~+10

// 回复相关
rewardDrainMove(ctx): number;          // +1~+11 (吸血招式)
rewardHealing(ctx): number;            // +4~+12

// 控制招式
rewardDisable(ctx): number;            // +2~+7
rewardEncore(ctx): number;             // +2~+5
rewardTaunt(ctx): number;              // +8~+12

// 其他
rewardPivotMove(ctx): number;          // +2~+8 (U-turn等)
rewardTrickRoom(ctx): number;          // +8~+14

// 双打相关
rewardSpreadMove(ctx): number;         // +6 (双打扩散招式)
rewardHelpingHand(ctx): number;        // +6
```

## 状态构建

### BattleState 结构

```typescript
interface BattleState {
    turn: number;
    isDoubles: boolean;
    self: {
        active: AIPokemon[];
        reserve: AIPokemon[];
        conditions: SideConditions;
    };
    opponent: {
        active: AIPokemon[];
        reserve: AIPokemon[];
        conditions: SideConditions;
    };
    field: FieldConditions;
}
```

### 构建函数

```typescript
// 使用 BattleTracker 构建状态
function buildBattleStateWithTracker(
    request: AnyObject,
    battle: AnyObject | null,
    tracker: BattleTracker,
    config: CFRUAIConfig
): BattleState;
```

### 对手能力值估算

由于 AI 无法直接访问对手的个体值、努力值和性格，使用以下默认值进行估算：

```typescript
// state-builder.ts: estimateOpponentStats()
const IV = 31;   // 满个体值
const EV = 85;   // 平均努力值 (510 总努力值 / 6 项 ≈ 85)
// 性格修正: 不应用 (假设中性性格)
```

**计算公式**:
```
HP = floor((2 × base + IV + floor(EV/4)) × level / 100) + level + 10
其他 = floor((floor((2 × base + IV + floor(EV/4)) × level / 100) + 5) × 1.0)
```

**设计理由**:
- **IV=31**: 竞技对战中几乎所有宝可梦都有满个体值
- **EV=85**: 保守估计，避免高估或低估对手
- **无性格修正**: 无法推断性格，使用中性假设

> 未来可通过 [使用率数据系统](../../npc-battle/ROADMAP.md#未来优化方向---使用率数据系统) 优化这一估算。

## 伤害计算

### calculateDamage

```typescript
function calculateDamage(
    attacker: AIPokemon,
    defender: AIPokemon,
    move: AIMove,
    field: FieldConditions,
    cache?: AICache
): DamageResult;

interface DamageResult {
    min: number;
    max: number;
    average: number;
    minPercent: number;
    maxPercent: number;
    averagePercent: number;
    effectiveness: number;
    canKO: boolean;
    guaranteedKO: boolean;
    hitsToKO: number;
}
```

### 多次攻击

```typescript
function getExpectedHitCount(
    move: AIMove,
    attackerAbility: string,
    attackerItem: string,
    attackerSpecies: string
): number;
```

### 额外伤害 (damage-calc.ts)

```typescript
// 各类额外伤害计算
function getPoisonDamage(pokemon: AIPokemon, forAI?: boolean): number;
function getBurnDamage(pokemon: AIPokemon): number;
function getSandstormDamage(pokemon: AIPokemon, weather: string): number;
function getHailDamage(pokemon: AIPokemon, weather: string): number;
function getLeechSeedDamage(pokemon: AIPokemon): number;

// 综合额外伤害
function getSecondaryEffectDamage(
    pokemon: AIPokemon,
    weather: string,
    terrain: string
): number;

// 判断是否会因额外伤害死亡
function willFaintFromSecondaryDamage(
    pokemon: AIPokemon,
    weather: string,
    terrain: string
): boolean;
```

## 文件结构

```
server/npc/ai/
├── normal.ts             # NormalAI 主文件
└── cfru/
    ├── types.ts          # 类型定义
    ├── state-builder.ts  # 状态构建
    ├── logger.ts         # 日志系统
    ├── scoring/
    │   ├── index.ts      # ScoringEngine
    │   ├── negatives.ts  # 扣分规则
    │   └── positives.ts  # 加分规则
    └── util/
        ├── battle-tracker.ts  # 状态追踪
        ├── damage-calc.ts     # 伤害计算
        ├── speed.ts           # 速度比较
        └── type-calc.ts       # 类型计算
```

## CFRU 源码对照

| PS 文件 | CFRU 文件 |
|---------|----------|
| negatives.ts | ai_negatives.c |
| positives.ts | ai_positives.c |
| damage-calc.ts | damage_calc.c |
| speed.ts | ai_util.c |

**CFRU 源码位置**: `/ssd3/lvjiawei01/projects/Complete-Fire-Red-Upgrade/src/Battle_AI/`

---

*最后更新: 2026-01-23 (v1.1.6 - 添加对手能力值估算说明)*
