# NormalAI 技术实现

## 共享信息层

Normal 和 Hard 共用信息层。单打、双打、Multi 均由 `buildBattleStateFromRequests` 构建状态；`multi-manager.ts` 只负责收齐请求、分配控制权和提交选择。

| 模块 | 职责 |
| --- | --- |
| `cfru/util/battle-tracker.ts` | 记录公开协议事实、己方请求中的必要事实，以及切换、变身、效果结束时的生命周期；不保存 preset 推测结果。 |
| `cfru/state-builder.ts` | 合并请求和 tracker，统一场地名称、场上位置和双方队伍信息，应用公开效果及对手配置估计。 |
| `cfru/util/opponent-presets.ts`、`random-presets.ts`、`hard/opponent-model.ts` | 管理配置候选与推断；已观察事实优先于候选，未知槽位不等于不存在招式。 |
| `cfru/util/damage-calc.ts`、`type-calc.ts`、`speed.ts` | 集中维护共享机制估算；缓存区分状态快照和计算条件，不能只按敌我可能重复的槽位编号区分精灵。 |
| `cfru/util/mechanics.ts` | 统一特性是否生效、道具是否生效、接地和优先级；按真实或假设的场上阵容计算全场压制。 |
| `cfru/util/items.ts`、`move-effects.ts` | 判断道具操作、状态附加、场地及位置效果是否可生效；评分器只负责把结果转换为分数。 |
| `cfru/scoring/`、`hard/evaluation.ts` | 根据同一状态做策略评分；评分上下文的 `dex` 对应当前 format。 |

新增机制时，先区分其作用范围：精灵本身、场上位置、整队或全场。例如变身随精灵离场清除，Gen5 起已消耗道具的回收记录随精灵跨换人保留（Gen3–4 按 PS 随位置转交），Wish 留在施放位置，Future Sight / Doom Desire 占用目标位置，Reflect 属于队伍，Gravity 属于全场。共享机制不分别写在 Normal、Hard 或 Multi 控制器中，也不按单个招式拆文件。

`swap` 交换两只精灵的在场观察、强化、行动记录和身份记忆，位置效果保持原位。换人是否传递状态以 `switch` 的公开来源为准，不根据上一招猜测：Baton Pass 复制强化及当前 format 未标记 `noCopy` 的效果，Shed Tail 只复制替身；新登场者的行动记录重新开始。接收者的特性会影响部分复制效果，例如不能被压制的特性不会继承胃液。Ally Switch 在单打、Multi 中无效，失败判断与成功后的状态交换分开处理。

道具的持有、效果失效、被移除和被消耗是不同状态。`items.ts` 通过只提供公开物种和招式的投影调用当前 format 的 `onTakeItem` 纯判断，回归测试约束其读取范围；不传入真实 Battle/Pokemon。投掷和自然之恩的威力读取当前 format 的道具数据。拍落的威力加成与移除收益分别判断。`recyclableItem` 的空字符串表示没有可回收道具，`undefined` 表示公开信息不足；例如对手使用自然之恩不暴露具体树果，己方则可用下一次授权请求确认消耗。

特性身份与特性生效分开保存和计算：`ability` 保留当前持有或推测的特性，`observedAbility` 保存原生特性的公开证据，胃液记录为临时状态。评分和伤害等消费者使用 `effectiveAbility`，不能用空特性同时表示“未知”和“被压制”。规则读取当前 format 的特性标记，处理化学变化气体、特性护具与变身限制；假设换人、Mega 或配置候选时，重算场上阵容的压制效果。早起按每次睡眠判定发生时的生效特性扣减已知 Rest 计数。`weatherId` 保留公开天气身份，`weather` 表示当前生效的天气；天气被无关天气／气闸压制时保留身份，退场后恢复。始源之海、终结之地和德尔塔气流的特殊规则不丢失。

`-singleturn` 效果在回合结束时清理，`-singlemove` 效果保留到持有者下一次行动（包括不能行动）。普通换人清理两者。连续同命的失败判断使用当前规则：MMO 和 Gen7 起限制连续使用，Gen6 不限制。消耗道具后的回血或发动消息只说明效果来源，不代表重新获得道具；只有明确的获得事件或授权请求才能恢复持有状态。

Multi 中，`self.team` 包含己方两名玩家的精灵；每个控制器的 `self.reserve` 只包含自己可以换入的后备。场上 `slot` 表示位置，后备 `slot` 表示所属玩家的队伍序号，不能拿它充当全局精灵身份。

Tracker 分别维护队员历史、本次登场的观察、场上位置效果。Illusion 的 `replace` 只纠正身份归属，保留强化、替身、行动记录等在场状态；本次观察与真身历史合并，被伪装队友的历史单独保留。睡眠来源、Rest 计数和道具消耗记录使用同一身份记忆结构，两个同名的场上位置不会共用本次观察。己方真实身份来自授权请求，对方真实身份以公开揭露为准。原始 PS 日志中的 `split` 事件只消费公开分支。

信息消费者通过 `effectiveItem`、`effectiveAbility` 和当前 format 的 Dex 判断效果；直接读取道具、特性身份只用于配置匹配、持有／移除关系、角色分类和日志。评分、即时击杀判断、状态收益、接触风险和回合末伤害不能把失效道具算作有效。伤害及概率仍是估算，不读取对手的真实能力值、隐藏配置或待执行指令。

假设配置、换人和 Mega 使用 `replaceActivePokemon` 投影阵容并重算全场压制与生效天气，不修改 tracker。Hard 的伤害、出手顺序和基础评分使用同一投影；换人前保留的预测对象通过 `ownerSide` 识别阵营，不能仅靠对象引用或可能重号的 `slot` 选择光墙、顺风等队伍效果。

招式能否选择目标以 PS 请求为准；锁定招式省略 `target` 时，不能从 Dex 补回目标类型。没有存活队友的 `adjacentAlly` 招式在共用有效性判断中扣分；如果所有可用动作都无效，提交的指令仍须包含合法的位置编号。

`test/server/npc/battle-state-mechanics.js` 用真实 PS 战斗产生公开事件，再核对 AI 状态；`multi-decisions.js` 验证生产 Multi 控制器。涉及位置和信息生命周期的改动应覆盖单打、双打、Multi。模拟器内部状态仅用于测试断言，AI 输入来自授权请求和公开协议。

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
    formatId: string;         // 当前对战规则
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
// 所有模式共用的状态构建入口
function buildBattleStateFromRequests(
    requests: { side: string; request: AnyObject }[],
    tracker: BattleTracker,
    config: CFRUAIConfig,
    turn?: number
): BattleState;

// 单控制器适配入口；battle 只提供公开回合数
function buildBattleStateWithTracker(
    request: AnyObject,
    battle: AnyObject | null,
    tracker: BattleTracker,
    config: CFRUAIConfig
): BattleState;
```

### 对手能力值估算

AI 不读取对手隐藏配置。Normal 使用默认 preset，random battle 使用项目内公开配置候选；Hard 在有对应分级配置时进一步推断。缺失具体精灵配置时回退到默认 preset，默认 preset 也缺失时才使用以下估算：

```typescript
// state-builder.ts: trackedPokemonToAIPokemon()
const IV = 31;   // 满个体值
const EV = 85;   // 平均努力值 (510 总努力值 / 6 项 ≈ 85)
// 性格修正: 不应用 (假设中性性格)
```

**计算公式**:
```
HP = floor((2 × base + IV + floor(EV/4)) × level / 100) + level + 10
其他 = floor((floor((2 × base + IV + floor(EV/4)) × level / 100) + 5) × 1.0)
```

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
├── hard.ts               # HardAI 控制器
├── hard/                 # Hard 配置推断与策略
├── multi-manager.ts      # Multi 请求与控制权协调
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
