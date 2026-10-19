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

`timesAttacked` 从公开攻击结算累计，按精灵身份保存，跨换人及变身保留；替身完全吸收的攻击不计数，多段攻击以引擎公开命中记录校准。愤怒之拳读取该计数计算威力。`toxicCounter` 表示本次登场已经结算的毒伤次数，下一次剧毒伤害使用计数加一，换人重置。这些计数及本次登场的行动记录在生成 preset 候选之前合并，候选只改变推测配置，不改变公开历史。

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

`compareActionOrder` 统一返回预计先手（1）、同速（0）、预计后手（-1），Normal 和 Hard 共用优先级、有效速度和戏法空间判断。Normal 的先手奖励不包含同速；Hard 将同速作为 0.5 处理。不同难度可以选择不同的对手配置或候选招式，但不能使用不同的顺序规则。

普通速度比较使用 `compareSpeedOrder`，考虑强化、特性、道具、麻痹、顺风和戏法空间；提速、麻痹、顺风的速度收益不读取对手招式先制度。攻击评分与先手击杀留场使用 `attacksFirst`，比较对手攻击候选的先制度，不将守住等变化招式作为攻击竞速对象。再来一次等需要准确打断行动的招式仍使用完整的 `actsBeforeTarget`。

突袭、迅雷只有在预计普通攻击后手且对手上一招为攻击招式时，才获得正常攻击奖励；否则按统一策略上限降到 60 分并跳过正面加分，仍可作为锁招等情况下的合法选择。先制招式与普通攻击使用相同的低伤害扣分；只有预计普通速度严格后手、借助先制度抢先且平均伤害能够击杀时，才获得先制击杀额外奖励。先制本身不提供两击击杀的速度奖励。

强化奖励通过统一函数覆盖 -6 到 +6 的全部阶段，在原有 0、+2、+4 奖励之间插值，奇数阶段不会遗漏。强化上限检查读取当前规则 Dex 的自我能力变化，考虑单纯、唱反调和生长的天气条件。纯强化招式的所有能力变化均已达到上限时记 0 分；部分能力满级时保留其余提升的价值，有清场等额外效果的招式不直接判整体无效。

策略性不推荐的招式使用统一常量 `DISCOURAGED_SCORE = 60`，跳过正面奖励，其他扣分仍可继续降低评分。覆盖血量不高于 40% 的自我强化、已能先手时的纯速度强化、高血量回复、连续守住，以及黑雾无净收益、唱反调导致能力下降、对队友施加有害状态等情况。确定免疫、无法执行或强化已满的招式仍为 0 分。回复和大扫除等兼有独立用途的招式不受这一血量规则限制。纯进攻强化没有可受益的攻击招式、定身法没有观察到上一招、精神香草会立即解除定身法或挑衅、完整公开的四个技能均为攻击时使用挑衅、帮助的队友没有可增幅攻击时，也使用这一保守评分。未知技能不作为技能不存在的证据；确定无效仍按无效规则扣分。这些规则只降低出招意愿，不将合法招式标记为无效。公开确认对手没有后备时铺钉、支付血量后无法承受已知回合末伤害时替身、没有清场收益或强化闪避可处理时清除浓雾，同样降至 60 分并停止正面奖励。后备数量未知时不按零处理。守住类招式无法避免已知回合末致死伤害时同样降至 60 分，考虑剩饭、回血特性和当回合将结算的许愿。

`resolveMove` 统一解析道具、特性、当前属性、天气和场地引起的招式变化，供伤害、免疫和评分共用。己方与对手的公开形态变化都进入共享状态，临时形态覆盖 request 中保留的初始 details，换人清理、位置交换迁移。棘藤棒、怒牛、气场轮由公开形态决定属性；光子喷涌按强化后的攻击和特攻确定类别，不将道具或特性增幅计入类别比较；青草滑梯的场地先制由公共 `effectivePriority` 计算。避雷针与引水的重定向读取双方全部场上成员，供出招、伤害与换人威胁计算共用，群攻与重定向豁免分别处理。自然之力保留选择的招式 ID 和槽位，以 `calledMove` 标识实际攻击；攻击伤害与外层招式的恶作剧之心等条件分别保留，不将展开后的攻击当作玩家选择的招式。

队友专属招式按实际队友检查生效条件，不使用敌人的属性、特性作免疫判断。轮转奖励要求使用者所属训练家拥有存活且不在场的后备；复生祈祷要求本训练家有倒下的队员，无合法对象时记 0 分。Multi 队友的后备不能计入这两类招式。

再来一次通常为 60 分；按生效优先级、速度、顺风和戏法空间判断先手，只有能够先手锁定对手上一招变化招式时才加到 120 分。同速不算可靠先手。确定无法生效时记 0 分。

回复招式的正负评分共用 `isImmediateRecovery`，睡觉包含在内，低血量获得回复奖励；延迟回复、牺牲和复活招式分别判断。睡觉的睡眠限制通过公共状态生效检查处理。公开 Rest 计数确认本回合仍在睡眠时，普通招式记 0 分，梦话获得 30 分奖励（通常合计 130 分）。确定醒来的回合，梦话记 0 分，普通招式正常评分。早起使用同一睡眠计数；随机睡眠时长未知时，不假定仍会睡眠。

伤害计算使用当前规则 Dex 的攻防能力值覆盖字段，扑击取防御和防御强化，欺诈取目标的攻击及强化，但道具和特性修正仍归出招者。纯朴按攻防方向忽略相应强化，并遵守破格与特性压制；强化评分不奖励被纯朴忽略的进攻收益。三旋击、三连踢逐击计算递增威力。太晶甲壳根据当前形态、满血状态及有效特性改变整次攻击的克制倍率；公开形态引起的特性替换同步到随机配置候选。硬撑不因睡眠翻倍；宝石按当前规则增伤，并考虑杂技在宝石消耗后的空道具威力，道具被压制时不触发。固定伤害保留免疫判断，不获得克制或本系奖励，也不受抵抗扣分。电光双击、燃尽根据使用者当前公开属性检查生效条件，换人恢复属性后重新判断。

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
rewardEncore(ctx): number;             // +60（先手锁定上一招变化招式，总分120）
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
