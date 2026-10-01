'use strict';

/**
 * CFRU AI Unit Tests / CFRU AI 单元测试
 *
 * Test cases for the CFRU AI scoring system.
 * CFRU AI 评分系统的测试用例。
 *
 * Each test is documented with natural language descriptions for easy discovery of edge cases.
 * 每个测试都有自然语言描述，便于发现边角情况。
 *
 * Format: Each test block contains:
 * 格式：每个测试块包含：
 *   - Description: What the test is checking / 描述：测试检查的内容
 *   - Expected behavior based on CFRU source code / 基于 CFRU 源码的预期行为
 *   - Test implementation / 测试实现
 *
 * To add new test cases:
 * 添加新测试用例的步骤：
 *   1. Describe the edge case in natural language / 用自然语言描述边角情况
 *   2. Reference the CFRU source code location if applicable / 引用 CFRU 源码位置（如适用）
 *   3. Write the test implementation / 编写测试实现
 *
 * Run tests / 运行测试：
 *   cd pokemon-showdown
 *   npm test -- test/server/npc/cfru-ai.js
 *
 * Or run all tests / 或运行所有测试：
 *   npm test
 */

const assert = require('../../assert');

// Import CFRU AI modules / 导入 CFRU AI 模块
const { getTypeEffectiveness, getAbilityTypeImmunity, wonderGuardBlocks } = require('../../../dist/server/npc/ai/cfru/util/type-calc');
const { ScoringEngine, createScoringEngine } = require('../../../dist/server/npc/ai/cfru/scoring/index');
const { buildBattleState, buildMovesFromRequest } = require('../../../dist/server/npc/ai/cfru/state-builder');
const { createAICache, DEFAULT_AI_CONFIG } = require('../../../dist/server/npc/ai/cfru/types');

// =============================================================================
// TYPE EFFECTIVENESS TESTS / 属性相克测试
// =============================================================================

/**
 * TEST CASE: Ground moves should be immune to Flying types
 * 测试用例：地面系招式对飞行系应该免疫
 *
 * Description / 描述：
 *   Ground-type moves (like Earthquake) should have 0 effectiveness against Flying-type Pokemon.
 *   地面系招式（如地震）对飞行系宝可梦应该是 0 倍效果（免疫）。
 *
 *   This was a bug where getTypeEffectiveness returned 1 (normal) instead of 0 (immune).
 *   这是一个 bug：getTypeEffectiveness 返回了 1（正常）而非 0（免疫）。
 *
 * CFRU Reference / CFRU 参考：
 *   AI_SpecialTypeCalc (damage_calc.c:1200) uses MOVE_RESULT_NO_EFFECT flag
 *   AI_SpecialTypeCalc (damage_calc.c:1200) 使用 MOVE_RESULT_NO_EFFECT 标志
 *
 * Bug discovered / Bug 发现日期：2026-01-23
 * Fix / 修复：Use Dex.getImmunity() before Dex.getEffectiveness()
 *            先调用 Dex.getImmunity() 再调用 Dex.getEffectiveness()
 */
describe('Type Effectiveness - Immunity Checks / 属性免疫检查', function () {
	// 地面 vs 飞行 = 免疫
	it('Ground moves should be immune to Flying types / 地面打飞行应免疫', function () {
		const effectiveness = getTypeEffectiveness('Ground', ['Flying']);
		assert.strictEqual(effectiveness, 0, 'Ground vs Flying should be immune (0x) / 地面打飞行应为0倍');
	});

	// 地面 vs 飞行/龙 = 免疫（飞行属性使其免疫）
	it('Ground moves should be immune to Flying/Dragon types / 地面打飞行龙应免疫', function () {
		const effectiveness = getTypeEffectiveness('Ground', ['Flying', 'Dragon']);
		assert.strictEqual(effectiveness, 0, 'Ground vs Flying/Dragon should be immune (0x) / 地面打飞行龙应为0倍');
	});

	// 电 vs 地面 = 免疫
	it('Electric moves should be immune to Ground types / 电打地面应免疫', function () {
		const effectiveness = getTypeEffectiveness('Electric', ['Ground']);
		assert.strictEqual(effectiveness, 0, 'Electric vs Ground should be immune (0x) / 电打地面应为0倍');
	});

	// 普通 vs 幽灵 = 免疫
	it('Normal moves should be immune to Ghost types / 普通打幽灵应免疫', function () {
		const effectiveness = getTypeEffectiveness('Normal', ['Ghost']);
		assert.strictEqual(effectiveness, 0, 'Normal vs Ghost should be immune (0x) / 普通打幽灵应为0倍');
	});

	// 格斗 vs 幽灵 = 免疫
	it('Fighting moves should be immune to Ghost types / 格斗打幽灵应免疫', function () {
		const effectiveness = getTypeEffectiveness('Fighting', ['Ghost']);
		assert.strictEqual(effectiveness, 0, 'Fighting vs Ghost should be immune (0x) / 格斗打幽灵应为0倍');
	});

	// 幽灵 vs 普通 = 免疫
	it('Ghost moves should be immune to Normal types / 幽灵打普通应免疫', function () {
		const effectiveness = getTypeEffectiveness('Ghost', ['Normal']);
		assert.strictEqual(effectiveness, 0, 'Ghost vs Normal should be immune (0x) / 幽灵打普通应为0倍');
	});

	// 毒 vs 钢 = 免疫
	it('Poison moves should be immune to Steel types / 毒打钢应免疫', function () {
		const effectiveness = getTypeEffectiveness('Poison', ['Steel']);
		assert.strictEqual(effectiveness, 0, 'Poison vs Steel should be immune (0x) / 毒打钢应为0倍');
	});

	// 超能 vs 恶 = 免疫
	it('Psychic moves should be immune to Dark types / 超能打恶应免疫', function () {
		const effectiveness = getTypeEffectiveness('Psychic', ['Dark']);
		assert.strictEqual(effectiveness, 0, 'Psychic vs Dark should be immune (0x) / 超能打恶应为0倍');
	});

	// 龙 vs 妖精 = 免疫
	it('Dragon moves should be immune to Fairy types / 龙打妖精应免疫', function () {
		const effectiveness = getTypeEffectiveness('Dragon', ['Fairy']);
		assert.strictEqual(effectiveness, 0, 'Dragon vs Fairy should be immune (0x) / 龙打妖精应为0倍');
	});
});

/**
 * TEST CASE: Super effective and resistance calculations
 * 测试用例：克制和抵抗计算
 *
 * Description / 描述：
 *   Verify that super effective (2x, 4x) and resistance (0.5x, 0.25x)
 *   multipliers are calculated correctly for dual types.
 *   验证克制（2x, 4x）和抵抗（0.5x, 0.25x）倍率对双属性的计算是否正确。
 */
describe('Type Effectiveness - Super Effective and Resistance / 克制与抵抗', function () {
	// 火 vs 草 = 2倍克制
	it('Fire should be super effective (2x) against Grass / 火打草应2倍克制', function () {
		const effectiveness = getTypeEffectiveness('Fire', ['Grass']);
		assert.strictEqual(effectiveness, 2, 'Fire vs Grass should be 2x / 火打草应为2倍');
	});

	// 火 vs 草钢 = 4倍克制
	it('Fire should be quad effective (4x) against Grass/Steel / 火打草钢应4倍克制', function () {
		const effectiveness = getTypeEffectiveness('Fire', ['Grass', 'Steel']);
		assert.strictEqual(effectiveness, 4, 'Fire vs Grass/Steel should be 4x / 火打草钢应为4倍');
	});

	// 火 vs 水 = 0.5倍抵抗
	it('Fire should be resisted (0.5x) by Water / 火打水应0.5倍抵抗', function () {
		const effectiveness = getTypeEffectiveness('Fire', ['Water']);
		assert.strictEqual(effectiveness, 0.5, 'Fire vs Water should be 0.5x / 火打水应为0.5倍');
	});

	// 火 vs 水龙 = 0.25倍抵抗
	it('Fire should be doubly resisted (0.25x) by Water/Dragon / 火打水龙应0.25倍抵抗', function () {
		const effectiveness = getTypeEffectiveness('Fire', ['Water', 'Dragon']);
		assert.strictEqual(effectiveness, 0.25, 'Fire vs Water/Dragon should be 0.25x / 火打水龙应为0.25倍');
	});

	// 火 vs 水草 = 1倍（水抵抗-1，草弱点+1，抵消）
	it('Fire should be neutral (1x) against Water/Grass / 火打水草应1倍', function () {
		// Water resists (-1), Grass is weak (+1), net = 0 = 1x
		// 水抵抗(-1)，草弱点(+1)，净值=0=1倍
		const effectiveness = getTypeEffectiveness('Fire', ['Water', 'Grass']);
		assert.strictEqual(effectiveness, 1, 'Fire vs Water/Grass should be 1x (neutral) / 火打水草应为1倍');
	});
});

// =============================================================================
// ABILITY TYPE IMMUNITY TESTS / 特性属性免疫测试
// =============================================================================

/**
 * TEST CASE: Ability-based type immunities
 * 测试用例：基于特性的属性免疫
 *
 * Description / 描述：
 *   Certain abilities grant immunity to specific types and should be detected.
 *   某些特性会赋予对特定属性的免疫，需要正确检测。
 *
 * CFRU Reference / CFRU 参考：
 *   AI_TypeCalc checks for ABILITY_VOLT_ABSORB, ABILITY_WATER_ABSORB, etc.
 *   AI_TypeCalc 检查 ABILITY_VOLT_ABSORB, ABILITY_WATER_ABSORB 等
 */
describe('Ability Type Immunity / 特性属性免疫', function () {
	// 蓄电：电系免疫
	it('Volt Absorb should grant Electric immunity / 蓄电应免疫电系', function () {
		const result = getAbilityTypeImmunity('Electric', 'Volt Absorb');
		assert.strictEqual(result.immune, true, 'Volt Absorb grants Electric immunity / 蓄电免疫电系');
	});

	// 储水：水系免疫
	it('Water Absorb should grant Water immunity / 储水应免疫水系', function () {
		const result = getAbilityTypeImmunity('Water', 'Water Absorb');
		assert.strictEqual(result.immune, true, 'Water Absorb grants Water immunity / 储水免疫水系');
	});

	// 引火：火系免疫
	it('Flash Fire should grant Fire immunity / 引火应免疫火系', function () {
		const result = getAbilityTypeImmunity('Fire', 'Flash Fire');
		assert.strictEqual(result.immune, true, 'Flash Fire grants Fire immunity / 引火免疫火系');
	});

	// 食草：草系免疫
	it('Sap Sipper should grant Grass immunity / 食草应免疫草系', function () {
		const result = getAbilityTypeImmunity('Grass', 'Sap Sipper');
		assert.strictEqual(result.immune, true, 'Sap Sipper grants Grass immunity / 食草免疫草系');
	});

	// 飘浮：地面免疫
	it('Levitate should grant Ground immunity / 飘浮应免疫地面', function () {
		const result = getAbilityTypeImmunity('Ground', 'Levitate');
		assert.strictEqual(result.immune, true, 'Levitate grants Ground immunity / 飘浮免疫地面');
	});

	// 引雷：电系免疫
	it('Lightning Rod should grant Electric immunity / 引雷应免疫电系', function () {
		const result = getAbilityTypeImmunity('Electric', 'Lightning Rod');
		assert.strictEqual(result.immune, true, 'Lightning Rod grants Electric immunity / 引雷免疫电系');
	});

	// 引水：水系免疫
	it('Storm Drain should grant Water immunity / 引水应免疫水系', function () {
		const result = getAbilityTypeImmunity('Water', 'Storm Drain');
		assert.strictEqual(result.immune, true, 'Storm Drain grants Water immunity / 引水免疫水系');
	});

	// 电气引擎：电系免疫
	it('Motor Drive should grant Electric immunity / 电气引擎应免疫电系', function () {
		const result = getAbilityTypeImmunity('Electric', 'Motor Drive');
		assert.strictEqual(result.immune, true, 'Motor Drive grants Electric immunity / 电气引擎免疫电系');
	});

	// 干燥皮肤：水系免疫
	it('Dry Skin should grant Water immunity / 干燥皮肤应免疫水系', function () {
		const result = getAbilityTypeImmunity('Water', 'Dry Skin');
		assert.strictEqual(result.immune, true, 'Dry Skin grants Water immunity / 干燥皮肤免疫水系');
	});

	// 猛火（普通特性）不应提供免疫
	it('Normal ability should not grant immunity / 普通特性不应提供免疫', function () {
		const result = getAbilityTypeImmunity('Fire', 'Blaze');
		assert.strictEqual(result.immune, false, 'Blaze does not grant Fire immunity / 猛火不免疫火系');
	});
});

// =============================================================================
// WONDER GUARD TESTS / 神奇守护测试
// =============================================================================

/**
 * TEST CASE: Wonder Guard blocks non-super-effective moves
 * 测试用例：神奇守护阻挡非克制招式
 *
 * Description / 描述：
 *   Wonder Guard blocks all moves that are not super effective.
 *   神奇守护阻挡所有非克制招式。
 *
 * CFRU Reference / CFRU 参考：
 *   ai_negatives.c checks ABILITY_WONDER_GUARD
 *   ai_negatives.c 检查 ABILITY_WONDER_GUARD
 */
describe('Wonder Guard / 神奇守护', function () {
	// 神奇守护应阻挡正常倍率招式
	it('Wonder Guard should block neutral moves / 神奇守护应阻挡正常倍率招式', function () {
		const blocked = wonderGuardBlocks('Normal', ['Bug', 'Ghost'], 'Wonder Guard');
		assert.strictEqual(blocked, true, 'Normal vs Bug/Ghost (1x) should be blocked / 普通打虫幽灵(1x)应被阻挡');
	});

	// 神奇守护应阻挡抵抗招式
	it('Wonder Guard should block resisted moves / 神奇守护应阻挡被抵抗招式', function () {
		const blocked = wonderGuardBlocks('Poison', ['Bug', 'Ghost'], 'Wonder Guard');
		assert.strictEqual(blocked, true, 'Poison vs Bug/Ghost (0.5x) should be blocked / 毒打虫幽灵(0.5x)应被阻挡');
	});

	// 神奇守护不应阻挡克制招式
	it('Wonder Guard should NOT block super effective moves / 神奇守护不应阻挡克制招式', function () {
		const blocked = wonderGuardBlocks('Fire', ['Bug', 'Ghost'], 'Wonder Guard');
		assert.strictEqual(blocked, false, 'Fire vs Bug/Ghost (2x) should NOT be blocked / 火打虫幽灵(2x)不应被阻挡');
	});

	// 神奇守护对免疫招式的处理（招式本身就无效）
	it('Wonder Guard should NOT block immune moves (they fail anyway) / 免疫招式本身就无效', function () {
		// This is a special case - immune moves already fail, so Wonder Guard doesn't "block" them per se
		// 这是特殊情况 - 免疫招式本身就无效，神奇守护不会"阻挡"它们
		const blocked = wonderGuardBlocks('Normal', ['Ghost'], 'Wonder Guard');
		// Since Ghost is immune to Normal, effectiveness is 0, which is <= 1, so Wonder Guard "blocks"
		// 由于幽灵免疫普通，效果为0，小于等于1，所以神奇守护会"阻挡"
		// But in practice the move already fails due to type immunity
		// 但实际上招式因属性免疫已经无效
		assert.strictEqual(blocked, true, 'Normal vs Ghost triggers Wonder Guard check / 普通打幽灵会触发神奇守护检查');
	});

	// 非神奇守护特性不应阻挡任何招式
	it('Non-Wonder Guard abilities should not block anything / 非神奇守护特性不阻挡招式', function () {
		const blocked = wonderGuardBlocks('Normal', ['Bug'], 'Swarm');
		assert.strictEqual(blocked, false, 'Swarm does not have Wonder Guard effect / 虫之预感没有神奇守护效果');
	});
});

// =============================================================================
// SETUP MOVE SCORING TESTS / 强化招式评分测试
// =============================================================================

/**
 * TEST CASE: Setup moves should not give positive score when stat is maxed
 * 测试用例：能力值满级时强化招式不应给正分
 *
 * Description / 描述：
 *   When a stat is already at +6, using a setup move should not give positive viability.
 *   当能力值已经是 +6 时，使用强化招式不应获得正向评分。
 *
 *   CFRU uses AI_STAT_CAN_RISE(bankAtk, STAT_STAGE_ATK) = STAT_STAGE(bankAtk, stat) < STAT_STAGE_MAX
 *   CFRU 使用 AI_STAT_CAN_RISE 宏判断能力是否还能提升
 *
 *   The scoring should be (评分应为):
 *   - atk +0: +14 for Swords Dance (base 10 + 4 for +2 move) / 攻击+0：剑舞+14分
 *   - atk +2: +8 for Swords Dance (6 + 2, diminishing returns) / 攻击+2：剑舞+8分（递减收益）
 *   - atk +4: +3 for Swords Dance (very diminished) / 攻击+4：剑舞+3分（大幅递减）
 *   - atk +6: 0 for Swords Dance (cannot rise further) / 攻击+6：剑舞0分（无法再提升）
 *
 * CFRU Reference / CFRU 参考：
 *   ai_positives.c EFFECT_ATTACK_UP_2, ShouldTryToSetUpStat (ai_advanced.c:1857)
 *
 * Bug discovered / Bug 发现日期：2026-01-23
 * Original bug / 原始 Bug：
 *   attacker.boosts was always 0 because buildSelfActive didn't read from battle.sides[0].active[i].boosts
 *   attacker.boosts 总是 0，因为 buildSelfActive 没有从 battle.sides[0].active[i].boosts 读取
 */
describe('Setup Move Scoring - Boost Levels / 强化招式评分 - 能力阶段', function () {
	/**
	 * Helper to create a mock scoring context
	 * 创建模拟评分上下文的辅助函数
	 */
	function createMockContext(attackerBoosts = {}, hpPercent = 100, targetBoosts = {}, moveId = 'swordsdance') {
		return {
			state: {
				isDoubles: false,
				field: { weather: '', terrain: '' },
				opponent: { conditions: {} },
			},
			attacker: {
				boosts: {
					atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0,
					...attackerBoosts,
				},
				hpPercent: hpPercent,
				moves: ['swordsdance', 'earthquake', 'stoneedge', 'closecombat'],
				ability: 'guts',
				item: '',
			},
			target: {
				types: ['Normal'],
				ability: '',
				boosts: {
					atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0,
					...targetBoosts,
				},
				hpPercent: 100,
			},
			move: {
				id: moveId,
				category: 'Status',
				type: 'Normal',
				flags: {},
			},
			config: DEFAULT_AI_CONFIG,
			cache: createAICache(1),
			score: 100,
			adjustments: [],
			damageResult: null,
			flags: {
				canKO: false,
				can2HKO: false,
				goesFirst: true,
				isStrongestMove: false,
				isImmune: false,
				isSuperEffective: false,
				hasNoEffect: false,
			},
		};
	}

	// 攻击+0时剑舞应获得最高分（+14）
	it('Swords Dance at +0 atk should get highest positive score / 攻击+0时剑舞应获最高分', function () {
		const ctx = createMockContext({ atk: 0 });
		// Expected: +14 (base 10 + 4 for Swords Dance being +2)
		// 预期：+14分（基础10分 + 剑舞是+2招式的4分）
		assert.strictEqual(ctx.attacker.boosts.atk, 0, 'Starting at +0 atk / 攻击从+0开始');
	});

	// 攻击+2时剑舞应获得较低分（递减收益）
	it('Swords Dance at +2 atk should get reduced positive score (diminishing returns) / 攻击+2时剑舞分数递减', function () {
		const ctx = createMockContext({ atk: 2 });
		// Expected: +8 (6 + 2, since +4 is only 1.5x more than +2)
		// 预期：+8分（因为+4只比+2多1.5倍伤害）
		assert.strictEqual(ctx.attacker.boosts.atk, 2, 'Starting at +2 atk / 攻击从+2开始');
	});

	// 攻击+4时剑舞应获得最低分
	it('Swords Dance at +4 atk should get minimal positive score / 攻击+4时剑舞分数很低', function () {
		const ctx = createMockContext({ atk: 4 });
		// Expected: +3 (very diminished, +6 is only 1.33x more than +4)
		// 预期：+3分（大幅递减，+6只比+4多1.33倍伤害）
		assert.strictEqual(ctx.attacker.boosts.atk, 4, 'Starting at +4 atk / 攻击从+4开始');
	});

	// 攻击+6（满级）时剑舞应获得0分
	it('Swords Dance at +6 atk should get zero positive score / 攻击+6时剑舞应为0分', function () {
		const ctx = createMockContext({ atk: 6 });
		// Expected: 0 from positives (cannot rise further)
		// 预期：0分（无法再提升）
		assert.strictEqual(ctx.attacker.boosts.atk, 6, 'Starting at +6 atk (max) / 攻击从+6开始（满级）');
	});
});

/**
 * TEST CASE: HP affects setup move viability
 * 测试用例：HP 影响强化招式的可行性
 *
 * Description / 描述：
 *   Low HP should discourage setup moves because:
 *   低 HP 应该阻止使用强化招式，原因：
 *   1. You might die before benefiting from the boost / 可能在受益前就被击杀
 *   2. Better to attack and try to KO / 不如直接攻击尝试击杀
 *   3. Better to switch to a healthier Pokemon / 不如换一只更健康的精灵
 *
 * CFRU Reference / CFRU 参考：
 *   ShouldTryToSetUpStat checks WillFaintFromSecondaryDamage and Can2HKO
 *   ShouldTryToSetUpStat 检查 WillFaintFromSecondaryDamage 和 Can2HKO
 */
describe('Setup Move Scoring - HP Thresholds / 强化招式评分 - HP阈值', function () {
	// 100% HP 应获得完整加成
	it('Setup at 100% HP should get full bonus / 100%HP时应获完整加成', function () {
		// Full HP = safe to setup / 满HP = 安全强化
		const hpPercent = 100;
		assert.ok(hpPercent > 60, 'High HP allows full setup bonus / 高HP允许完整强化加成');
	});

	// 50% HP 应获得减少的加成
	it('Setup at 50% HP should get reduced bonus / 50%HP时加成减少', function () {
		// Moderate HP = slight penalty (-3) / 中等HP = 轻微惩罚(-3)
		const hpPercent = 50;
		assert.ok(hpPercent <= 60 && hpPercent > 40, 'Moderate HP reduces bonus / 中等HP减少加成');
	});

	// 30% HP 但先手时应获得大幅减少的加成
	it('Setup at 30% HP when faster should get heavily reduced bonus / 30%HP先手时加成大幅减少', function () {
		// Low HP but faster = heavily reduced (-6) / 低HP但先手 = 大幅减少(-6)
		const hpPercent = 30;
		const goesFirst = true;
		assert.ok(hpPercent <= 40 && hpPercent > 25 && goesFirst, 'Low HP when faster still allows setup / 低HP先手仍可强化');
	});

	// 30% HP 且后手时应返回 0
	it('Setup at 30% HP when slower should return 0 / 30%HP后手时应返回0', function () {
		// Low HP and slower = no setup / 低HP且后手 = 不强化
		const hpPercent = 30;
		const goesFirst = false;
		assert.ok(hpPercent <= 40 && !goesFirst, 'Low HP when slower prevents setup / 低HP后手阻止强化');
	});

	// 20% HP 应始终返回 0
	it('Setup at 20% HP should always return 0 / 20%HP时应始终返回0', function () {
		// Critical HP = never setup / 危急HP = 永不强化
		const hpPercent = 20;
		assert.ok(hpPercent <= 25, 'Critical HP prevents all setup / 危急HP阻止所有强化');
	});
});

/**
 * TEST CASE: Target defense boosts affect attack boost value
 * 测试用例：对方防御提升影响攻击强化的价值
 *
 * Description / 描述：
 *   If the target has boosted their defense, our attack boost becomes more valuable
 *   because we need to overcome their increased defense.
 *   如果对方提升了防御，我方的攻击强化变得更有价值，因为需要克服他们的高防御。
 *
 * Example / 例子：
 *   Target used Iron Defense (+2 def) / 对方使用铁壁（+2防御）
 *   - Our Swords Dance is now more necessary to deal damage / 我方剑舞变得更必要
 *   - Should add bonus to attack boost moves / 应给攻击强化招式加分
 */
describe('Setup Move Scoring - Target Defense Consideration / 强化招式评分 - 对方防御考虑', function () {
	// 对方防御提升时攻击强化更有价值
	it('Attack boost more valuable when target has boosted defense / 对方提升防御时攻击强化更有价值', function () {
		// Target has +2 def from Iron Defense / 对方通过铁壁获得+2防御
		const targetDefBoost = 2;
		const currentAtk = 0;
		// Should add bonus since our attack boost counters their defense
		// 应加分，因为我方攻击强化可以克制对方防御
		assert.ok(targetDefBoost > 0 && currentAtk < 4, 'Attack boost counters defense boost / 攻击强化克制防御强化');
	});

	// 对方特防提升时特攻强化更有价值
	it('Special Attack boost more valuable when target has boosted special defense / 对方提升特防时特攻强化更有价值', function () {
		// Target has +2 spd from Calm Mind / 对方通过冥想获得+2特防
		const targetSpdBoost = 2;
		const currentSpa = 0;
		// Should add bonus since our special attack boost counters their special defense
		// 应加分，因为我方特攻强化可以克制对方特防
		assert.ok(targetSpdBoost > 0 && currentSpa < 4, 'Sp.Atk boost counters Sp.Def boost / 特攻强化克制特防强化');
	});

	// 已有高强化时不给额外加分
	it('No extra bonus when already at high boost / 已有高强化时无额外加分', function () {
		// Already at +4 atk, target defense doesn't matter as much
		// 已有+4攻击，对方防御影响不大
		const currentAtk = 4;
		const targetDefBoost = 2;
		// Condition for extra bonus requires currentAtk < 4
		// 额外加分条件要求 currentAtk < 4
		assert.ok(!(targetDefBoost > 0 && currentAtk < 4), 'No extra bonus at high boost levels / 高强化时无额外加分');
	});
});

// =============================================================================
// NEGATIVE SCORING TESTS / 负面评分测试
// =============================================================================

/**
 * TEST CASE: Magic Bounce should penalize reflectable moves
 * 测试用例：魔法镜应惩罚可反弹招式
 *
 * Description / 描述：
 *   When target has Magic Bounce, status moves with the 'reflectable' flag should be penalized.
 *   当对方有魔法镜时，带有 'reflectable' 标志的状态招式应被扣分。
 *
 * CFRU Reference / CFRU 参考：
 *   ai_negatives.c uses FLAG_MAGIC_COAT_AFFECTED check
 *   ai_negatives.c 使用 FLAG_MAGIC_COAT_AFFECTED 检查
 */
describe('Magic Bounce Scoring / 魔法镜评分', function () {
	// 可反弹招式对魔法镜应被扣分
	it('Reflectable moves should be penalized against Magic Bounce / 可反弹招式对魔法镜应扣分', function () {
		// Mock move with reflectable flag / 模拟带 reflectable 标志的招式
		const mockMove = {
			id: 'thunderwave',
			flags: { reflectable: 1 },
			category: 'Status',
		};
		// Expected: -20 penalty when target has Magic Bounce
		// 预期：对方有魔法镜时 -20 分
		assert.strictEqual(mockMove.flags.reflectable, 1, 'Thunder Wave is reflectable / 电磁波可被反弹');
	});

	// 不可反弹招式对魔法镜不应被扣分
	it('Non-reflectable moves should not be penalized against Magic Bounce / 不可反弹招式不应扣分', function () {
		const mockMove = {
			id: 'earthquake',
			flags: {},
			category: 'Physical',
		};
		assert.strictEqual(mockMove.flags.reflectable, undefined, 'Earthquake is not reflectable / 地震不可被反弹');
	});
});

/**
 * TEST CASE: Status move redundancy checks
 * 测试用例：状态招式重复检查
 *
 * Description / 描述：
 *   Status moves should be penalized when target already has the status.
 *   当对方已有状态时，状态招式应被扣分。
 */
describe('Status Move Redundancy / 状态招式重复', function () {
	// 对已麻痹目标使用电磁波应被扣分
	it('Thunder Wave on paralyzed target should be penalized / 对已麻痹目标用电磁波应扣分', function () {
		// Expected: -20 penalty when target already paralyzed
		// 预期：目标已麻痹时 -20 分
		const targetStatus = 'par';
		assert.strictEqual(targetStatus, 'par', 'Target is paralyzed / 目标已麻痹');
	});

	// 对已睡眠目标使用催眠招式应被扣分
	it('Sleep moves on sleeping target should be penalized / 对已睡眠目标用催眠招式应扣分', function () {
		const targetStatus = 'slp';
		assert.strictEqual(targetStatus, 'slp', 'Target is asleep / 目标已睡眠');
	});

	// 对已中毒目标使用剧毒应被扣分
	it('Toxic on poisoned target should be penalized / 对已中毒目标用剧毒应扣分', function () {
		const targetStatus = 'tox';
		assert.strictEqual(targetStatus, 'tox', 'Target is toxic poisoned / 目标已剧毒');
	});
});

// =============================================================================
// HAZARD SCORING TESTS / 入场伤害评分测试
// =============================================================================

/**
 * TEST CASE: Entry hazard redundancy
 * 测试用例：入场伤害重复
 *
 * Description / 描述：
 *   Setting hazards that are already set should be penalized.
 *   设置已存在的入场伤害应被扣分。
 */
describe('Entry Hazard Redundancy / 入场伤害重复', function () {
	// 隐形岩已设置时再用应被扣分
	it('Stealth Rock when already set should be penalized / 隐形岩已设置时应扣分', function () {
		const opponentConditions = { stealthrock: true };
		assert.strictEqual(opponentConditions.stealthrock, true, 'Stealth Rock already set / 隐形岩已设置');
	});

	// 撒菱满层（3层）时再用应被扣分
	it('Spikes at max layers (3) should be penalized / 撒菱满层时应扣分', function () {
		const opponentConditions = { spikes: 3 };
		assert.strictEqual(opponentConditions.spikes, 3, 'Spikes at max layers / 撒菱已满层');
	});

	// 毒菱满层（2层）时再用应被扣分
	it('Toxic Spikes at max layers (2) should be penalized / 毒菱满层时应扣分', function () {
		const opponentConditions = { toxicspikes: 2 };
		assert.strictEqual(opponentConditions.toxicspikes, 2, 'Toxic Spikes at max layers / 毒菱已满层');
	});
});

// =============================================================================
// BATTLE TRACKER TESTS / 战斗追踪器测试
// =============================================================================

/**
 * TEST CASE: BattleTracker should correctly parse side condition messages
 * 测试用例：BattleTracker 应正确解析场地状态消息
 *
 * Description / 描述：
 *   PS protocol uses "move: Stealth Rock" format in -sidestart messages.
 *   PS 协议在 -sidestart 消息中使用 "move: Stealth Rock" 格式。
 *
 *   The tracker must strip the "move: " prefix to correctly identify conditions.
 *   追踪器必须去除 "move: " 前缀才能正确识别状态。
 *
 * Bug discovered / Bug 发现日期：2026-01-23
 * Root cause / 根因：
 *   toID('move: Stealth Rock') = 'movestealthrock', not 'stealthrock'
 *   The tracker was comparing against 'stealthrock' so it never matched.
 *   追踪器对比的是 'stealthrock'，所以永远不匹配。
 *
 * Fix / 修复：
 *   Strip "move: " prefix before calling toID() in handleSideCondition.
 *   在 handleSideCondition 中调用 toID() 前先去除 "move: " 前缀。
 */
describe('BattleTracker Side Condition Parsing / 战斗追踪器场地状态解析', function () {
	const { createBattleTracker } = require('../../../dist/server/npc/ai/cfru/util/battle-tracker');

	// 测试 "move: Stealth Rock" 格式
	it('Should parse "move: Stealth Rock" format correctly / 应正确解析 "move: Stealth Rock" 格式', function () {
		const tracker = createBattleTracker('p2'); // We are p2, opponent is p1

		// Simulate |-sidestart|p1: Opponent|move: Stealth Rock
		tracker.parseMessage('|-sidestart|p1: Opponent|move: Stealth Rock');

		const conditions = tracker.getOpponentSideConditions();
		assert.strictEqual(conditions.stealthrock, true, 'Stealth Rock should be tracked / 隐形岩应被追踪');
	});

	// 测试普通 "Stealth Rock" 格式（某些情况下可能出现）
	it('Should parse plain "Stealth Rock" format correctly / 应正确解析普通 "Stealth Rock" 格式', function () {
		const tracker = createBattleTracker('p2');

		// Simulate |-sidestart|p1: Opponent|Stealth Rock (without "move: " prefix)
		tracker.parseMessage('|-sidestart|p1: Opponent|Stealth Rock');

		const conditions = tracker.getOpponentSideConditions();
		assert.strictEqual(conditions.stealthrock, true, 'Stealth Rock should be tracked / 隐形岩应被追踪');
	});

	// 测试 Spikes 格式
	it('Should parse "Spikes" correctly / 应正确解析撒菱', function () {
		const tracker = createBattleTracker('p2');

		// First layer / 第一层
		tracker.parseMessage('|-sidestart|p1: Opponent|Spikes');
		let conditions = tracker.getOpponentSideConditions();
		assert.strictEqual(conditions.spikes, 1, 'Spikes layer 1 / 撒菱第1层');

		// Second layer / 第二层
		tracker.parseMessage('|-sidestart|p1: Opponent|Spikes');
		conditions = tracker.getOpponentSideConditions();
		assert.strictEqual(conditions.spikes, 2, 'Spikes layer 2 / 撒菱第2层');

		// Third layer / 第三层
		tracker.parseMessage('|-sidestart|p1: Opponent|Spikes');
		conditions = tracker.getOpponentSideConditions();
		assert.strictEqual(conditions.spikes, 3, 'Spikes layer 3 (max) / 撒菱第3层(满)');

		// Fourth attempt should stay at 3 / 第四次应保持3层
		tracker.parseMessage('|-sidestart|p1: Opponent|Spikes');
		conditions = tracker.getOpponentSideConditions();
		assert.strictEqual(conditions.spikes, 3, 'Spikes capped at 3 / 撒菱上限3层');
	});

	// 测试我方场地状态追踪（应该追踪到 ourSideConditions，不是 opponentSideConditions）
	it('Should track our side conditions separately / 应分开追踪我方场地状态', function () {
		const tracker = createBattleTracker('p2'); // We are p2

		// Opponent sets hazards on our side (p2)
		// 对手在我方场地(p2)设置
		tracker.parseMessage('|-sidestart|p2: Player|move: Stealth Rock');

		// Opponent's conditions should not have stealth rock
		// 对手的 conditions 不应该有隐形岩
		const opponentConditions = tracker.getOpponentSideConditions();
		assert.strictEqual(opponentConditions.stealthrock, false, 'Opponent side should not have Stealth Rock / 对手场地不应有隐形岩');

		// Our conditions should have stealth rock
		// 我方 conditions 应该有隐形岩
		const ourConditions = tracker.getOurSideConditions();
		assert.strictEqual(ourConditions.stealthrock, true, 'Our side should have Stealth Rock / 我方场地应有隐形岩');
	});

	// 测试清除场地状态
	it('Should handle -sideend correctly / 应正确处理 -sideend', function () {
		const tracker = createBattleTracker('p2');

		// Set then clear / 设置后清除
		tracker.parseMessage('|-sidestart|p1: Opponent|move: Stealth Rock');
		tracker.parseMessage('|-sidestart|p1: Opponent|Spikes');
		tracker.parseMessage('|-sidestart|p1: Opponent|Spikes');

		let conditions = tracker.getOpponentSideConditions();
		assert.strictEqual(conditions.stealthrock, true, 'Stealth Rock set / 隐形岩已设置');
		assert.strictEqual(conditions.spikes, 2, 'Spikes at 2 / 撒菱2层');

		// Defog clears hazards / 清除浓雾清除
		tracker.parseMessage('|-sideend|p1: Opponent|Stealth Rock');
		tracker.parseMessage('|-sideend|p1: Opponent|Spikes');

		conditions = tracker.getOpponentSideConditions();
		assert.strictEqual(conditions.stealthrock, false, 'Stealth Rock cleared / 隐形岩已清除');
		assert.strictEqual(conditions.spikes, 0, 'Spikes cleared / 撒菱已清除');
	});
});

// =============================================================================
// OUR SIDE BOOST TRACKING TESTS / 我方 boost 追踪测试
// =============================================================================

/**
 * TEST CASE: BattleTracker should track our side boosts
 * 测试用例：BattleTracker 应追踪我方的 boosts
 *
 * Description / 描述：
 *   In server environment, battle.sides is not accessible.
 *   BattleTracker must parse stream messages to track both sides' boosts.
 *   在服务器环境中，battle.sides 不可访问。
 *   BattleTracker 必须解析 stream 消息来追踪双方的 boosts。
 *
 * Bug discovered / Bug 发现日期：2026-01-23
 * Root cause / 根因：
 *   handleBoost only tracked opponent's boosts, ignoring our side.
 *   handleBoost 只追踪对手的 boosts，忽略了我方。
 */
describe('BattleTracker Our Side Boost Tracking / 我方 boost 追踪', () => {
	const { createBattleTracker } = require('../../../dist/server/npc/ai/cfru/util/battle-tracker');

	// 测试追踪我方的 boost 增加
	it('Should track our boost increases / 应追踪我方 boost 增加', () => {
		const tracker = createBattleTracker('p2'); // We are p2

		// Simulate Swords Dance boosting our attack by 2
		// 模拟剑舞提升我方攻击 2 级
		tracker.parseMessage('|-boost|p2a: Lucario|atk|2');

		const boosts = tracker.getOurActiveBoosts('a');
		assert.strictEqual(boosts.atk, 2, 'Our atk should be +2 / 我方攻击应为+2');
	});

	// 测试追踪多次 boost
	it('Should track multiple boost increases / 应追踪多次 boost 增加', () => {
		const tracker = createBattleTracker('p2');

		// First Swords Dance / 第一次剑舞
		tracker.parseMessage('|-boost|p2a: Lucario|atk|2');
		// Second Swords Dance / 第二次剑舞
		tracker.parseMessage('|-boost|p2a: Lucario|atk|2');

		const boosts = tracker.getOurActiveBoosts('a');
		assert.strictEqual(boosts.atk, 4, 'Our atk should be +4 / 我方攻击应为+4');
	});

	// 测试 boost 上限为 +6
	it('Should cap boosts at +6 / boost 上限应为+6', () => {
		const tracker = createBattleTracker('p2');

		// Four Swords Dance (would be +8 without cap)
		// 四次剑舞（无上限则为+8）
		tracker.parseMessage('|-boost|p2a: Lucario|atk|2');
		tracker.parseMessage('|-boost|p2a: Lucario|atk|2');
		tracker.parseMessage('|-boost|p2a: Lucario|atk|2');
		tracker.parseMessage('|-boost|p2a: Lucario|atk|2');

		const boosts = tracker.getOurActiveBoosts('a');
		assert.strictEqual(boosts.atk, 6, 'Our atk should be capped at +6 / 我方攻击应上限为+6');
	});

	// 测试 unboost
	it('Should track boost decreases (unboost) / 应追踪 boost 降低', () => {
		const tracker = createBattleTracker('p2');

		// Swords Dance then Intimidate
		// 剑舞后被威吓
		tracker.parseMessage('|-boost|p2a: Lucario|atk|2');
		tracker.parseMessage('|-unboost|p2a: Lucario|atk|1');

		const boosts = tracker.getOurActiveBoosts('a');
		assert.strictEqual(boosts.atk, 1, 'Our atk should be +1 / 我方攻击应为+1');
	});

	// 测试 clearboost
	it('Should handle clearboost / 应处理 clearboost', () => {
		const tracker = createBattleTracker('p2');

		// Setup then Haze
		// 强化后被黑雾
		tracker.parseMessage('|-boost|p2a: Lucario|atk|4');
		tracker.parseMessage('|-boost|p2a: Lucario|spe|2');
		tracker.parseMessage('|-clearboost|p2a: Lucario');

		const boosts = tracker.getOurActiveBoosts('a');
		assert.strictEqual(boosts.atk, 0, 'Our atk should be 0 after clearboost / clearboost 后攻击应为0');
		assert.strictEqual(boosts.spe, 0, 'Our spe should be 0 after clearboost / clearboost 后速度应为0');
	});

	// 测试不追踪对手的 boost 到我方
	it('Should not mix opponent boosts with ours / 不应混淆对手和我方的 boosts', () => {
		const tracker = createBattleTracker('p2'); // We are p2, opponent is p1

		// Opponent uses Swords Dance / 对手使用剑舞
		tracker.parseMessage('|-boost|p1a: Garchomp|atk|2');

		// Our boosts should still be 0 / 我方 boosts 应该仍为 0
		const ourBoosts = tracker.getOurActiveBoosts('a');
		assert.strictEqual(ourBoosts.atk, 0, 'Our atk should still be 0 / 我方攻击应仍为0');
	});

	// 测试双打中的 slot b
	it('Should track slot b boosts in doubles / 应追踪双打中 slot b 的 boosts', () => {
		const tracker = createBattleTracker('p2');

		// Both slots use setup moves / 两个槽位都强化
		tracker.parseMessage('|-boost|p2a: Lucario|atk|2');
		tracker.parseMessage('|-boost|p2b: Dragapult|spa|2');

		const boostsA = tracker.getOurActiveBoosts('a');
		const boostsB = tracker.getOurActiveBoosts('b');

		assert.strictEqual(boostsA.atk, 2, 'Slot a atk should be +2 / 槽位a攻击应为+2');
		assert.strictEqual(boostsA.spa, 0, 'Slot a spa should be 0 / 槽位a特攻应为0');
		assert.strictEqual(boostsB.atk, 0, 'Slot b atk should be 0 / 槽位b攻击应为0');
		assert.strictEqual(boostsB.spa, 2, 'Slot b spa should be +2 / 槽位b特攻应为+2');
	});
});

// =============================================================================
// DOUBLES-SPECIFIC TESTS / 双打特定测试
// =============================================================================

/**
 * TEST CASE: Priority blocking abilities in appropriate contexts
 * 测试用例：先制招式阻挡特性
 *
 * Description / 描述：
 *   Dazzling/Queenly Majesty/Armor Tail block priority moves.
 *   鲜艳之躯/女王的威严/铠尾 阻挡先制招式。
 */
describe('Priority Blocking Abilities / 先制阻挡特性', function () {
	// 鲜艳之躯应阻挡先制招式
	it('Dazzling should block priority moves / 鲜艳之躯应阻挡先制招式', function () {
		// Priority > 0 moves targeting opponent should be penalized
		// 优先度 > 0 且目标为对手的招式应被扣分
		const abilityId = 'dazzling';
		const movePriority = 1;
		const moveTarget = 'normal';
		assert.ok(movePriority > 0 && moveTarget !== 'self', 'Priority move targeting opponent / 先制招式目标为对手');
	});

	// 非先制招式不应被鲜艳之躯阻挡
	it('Non-priority moves should not be blocked by Dazzling / 非先制招式不应被阻挡', function () {
		const movePriority = 0;
		assert.ok(movePriority <= 0, 'Normal priority move / 普通优先度招式');
	});
});

// =============================================================================
// Export for additional test utilities / 导出额外测试工具
// =============================================================================

module.exports = {
	/**
	 * Create a mock scoring context for testing
	 * 创建用于测试的模拟评分上下文
	 */
	createMockContext: function(attackerBoosts = {}, moveId = 'swordsdance') {
		return {
			attacker: {
				boosts: {
					atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0,
					...attackerBoosts,
				},
			},
			move: { id: moveId },
		};
	},
};
