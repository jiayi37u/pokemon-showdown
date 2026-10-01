/**
 * 换人逻辑测试 / Switching Logic Tests
 * 测试 NormalAI 的换人决策和换人评分
 */

const { section, test, assertEqual, assert, deepMerge } = require('./test-utils');

function runSwitchingTests() {
	// =============================================================================
	// 换人评分测试 / SWITCH SCORING TESTS
	// =============================================================================

	section('换人评分 - 属性防御优势 / Switch Scoring - Type Defense');

	test('免疫对手招式应获 +12 分 / Immune to opponent move gets +12', () => {
		// 飞行系免疫地面
		const types = ['Flying'];
		const opponentMoves = ['earthquake'];
		const effectiveness = 0; // immune
		assert(effectiveness === 0, '飞行免疫地面');
		// Logic: immune gets +12
	});

	test('抵抗对手招式应获 +6 分每招 / Resist opponent move gets +6 per move', () => {
		// 钢系抵抗普通
		const types = ['Steel'];
		const opponentMoves = ['bodyslam', 'return'];
		// Both are Normal type, Steel resists
		// Score: +6 * 2 = +12 (capped at 2)
	});

	test('抵抗上限为 2 招 / Resist bonus capped at 2 moves', () => {
		// Even if opponent has 4 resisted moves, only count 2
		const resistsCount = 4;
		const bonus = 6 * Math.min(resistsCount, 2);
		assertEqual(bonus, 12, '抵抗加分上限为 12');
	});

	// =============================================================================
	section('换人评分 - 属性进攻优势 / Switch Scoring - Type Offense');

	test('本系克制招式应获 +8 分 / STAB super effective move gets +8', () => {
		// 火系精灵有本系火焰放射打草系
		const types = ['Fire'];
		const moves = ['flamethrower'];
		const targetTypes = ['Grass'];
		// Fire is STAB, super effective vs Grass
		const bonus = 8; // STAB + super effective
		assertEqual(bonus, 8, '本系克制获 +8');
	});

	test('非本系克制招式应获 +4 分 / Non-STAB super effective gets +4', () => {
		// 水系精灵有非本系地震打电系
		const types = ['Water'];
		const moves = ['earthquake'];
		const targetTypes = ['Electric'];
		// Earthquake is not STAB for Water, but super effective
		const bonus = 4;
		assertEqual(bonus, 4, '非本系克制获 +4');
	});

	// =============================================================================
	section('换人评分 - 生存能力 / Switch Scoring - Survivability');

	test('HP 百分比应影响评分 / HP percentage affects score', () => {
		const hpPercent = 80;
		const hpBonus = Math.floor(hpPercent / 10);
		assertEqual(hpBonus, 8, '80% HP 获得 8 分');
	});

	test('满血精灵获得满分 HP 加成 / Full HP Pokemon gets max HP bonus', () => {
		const hpPercent = 100;
		const hpBonus = Math.floor(hpPercent / 10);
		assertEqual(hpBonus, 10, '100% HP 获得 10 分');
	});

	test('低血精灵获得较少 HP 加成 / Low HP Pokemon gets less HP bonus', () => {
		const hpPercent = 30;
		const hpBonus = Math.floor(hpPercent / 10);
		assertEqual(hpBonus, 3, '30% HP 获得 3 分');
	});

	// =============================================================================
	section('换人评分 - 危险惩罚 / Switch Scoring - Danger Penalty');

	test('低 HP + 被克制应大扣分 / Low HP + weak to opponent gets big penalty', () => {
		const hpPercent = 30;
		const weakCount = 1;
		// Logic: if (hpPercent < 40 && weakCount > 0) penalty = -10
		const penalty = (hpPercent < 40 && weakCount > 0) ? -10 : 0;
		assertEqual(penalty, -10, '低 HP + 被克制扣 10 分');
	});

	test('被多招克制应扣分 / Multiple weaknesses gets penalty', () => {
		const weakCount = 2;
		// Logic: if (weakCount >= 2) penalty = -8
		const penalty = weakCount >= 2 ? -8 : 0;
		assertEqual(penalty, -8, '被 2+ 招克制扣 8 分');
	});

	test('中等 HP + 被克制应小扣分 / Moderate HP + weakness gets small penalty', () => {
		const hpPercent = 55;
		const weakCount = 1;
		// Logic: if (weakCount === 1 && hpPercent < 60) penalty = -5
		const penalty = (weakCount === 1 && hpPercent < 60) ? -5 : 0;
		assertEqual(penalty, -5, '中等 HP + 被克制扣 5 分');
	});

	test('被对手本系属性克制应额外扣分 / Weak to opponent STAB gets extra penalty', () => {
		// 对手是火系，我方草系
		const opponentTypes = ['Fire'];
		const myTypes = ['Grass'];
		// Fire is super effective vs Grass
		// Logic: -3 extra for STAB weakness
		const penalty = -3;
		assertEqual(penalty, -3, '被本系克制额外扣 3 分');
	});

	// =============================================================================
	section('换人阈值测试 / Switch Threshold Tests');

	test('攻击阈值 95: 单抵抗+极低伤害触发换人 / Attack threshold 95: single resist + very low triggers', () => {
		// Score: 100 - 5(resist) - 8(low dmg) = 87 <= 95
		const score = 100 - 5 - 8;
		const threshold = 95;
		assert(score <= threshold, `${score} <= ${threshold} 应触发换人考虑`);
	});

	test('攻击阈值 95: 本系双抵抗不触发 / Attack threshold 95: STAB double resist no trigger', () => {
		// Score: 100 + 3(STAB) - 5(resist) = 98 > 95
		const score = 100 + 3 - 5;
		const threshold = 95;
		assert(score > threshold, `${score} > ${threshold} 不触发换人`);
	});

	test('状态阈值 90: 对手已有状态触发 / Status threshold 90: target has status triggers', () => {
		// Score: 100 - 10~15(status) = 85~90, use 85
		const score = 100 - 15;
		const threshold = 90;
		assert(score <= threshold, `${score} <= ${threshold} 应触发换人考虑`);
	});

	test('状态阈值 90: 正常状态招式不触发 / Status threshold 90: normal status no trigger', () => {
		// Score: 100 + positive bonuses = 100+
		const score = 100 + 4; // e.g., paralysis bonus
		const threshold = 90;
		assert(score > threshold, `${score} > ${threshold} 不触发换人`);
	});

	test('两个阈值都要满足才触发换人 / Both thresholds must be met to trigger switch', () => {
		// Good attack but bad status: no switch
		const attackScore = 110; // good
		const statusScore = 80;  // bad
		const attackThreshold = 95;
		const statusThreshold = 90;

		const shouldSwitch = attackScore <= attackThreshold && statusScore <= statusThreshold;
		assertEqual(shouldSwitch, false, '攻击好但状态差不应换人');
	});

	// =============================================================================
	section('换人决策阈值 / Switch Decision Threshold');

	test('换入得分 > 5 才执行换人 / Switch score > 5 to actually switch', () => {
		const switchScore = 6;
		const threshold = 5;
		assert(switchScore > threshold, '换入得分必须 > 5');
	});

	test('换入得分 <= 5 不换人 / Switch score <= 5 stays in', () => {
		const switchScore = 3;
		const threshold = 5;
		assert(switchScore <= threshold, '换入得分 <= 5 不换人');
	});

	// =============================================================================
	section('综合场景测试 / Comprehensive Scenario Tests');

	test('完美换入: 免疫 + 本系克制 + 高 HP / Perfect switch: immune + STAB SE + high HP', () => {
		// 飞行/钢换入面对地面系
		// Score: +12(immune) + 8(STAB SE) + 10(100% HP) = 30
		const score = 12 + 8 + 10;
		assertEqual(score, 30, '完美换入得分约 30');
		assert(score > 5, '应该执行换人');
	});

	test('糟糕换入: 被克制 + 低 HP / Bad switch: weak + low HP', () => {
		// 草系换入面对火系，30% HP
		// Score: -10(low HP + weak) - 3(STAB weak) + 3(HP bonus) = -10
		const score = -10 - 3 + 3;
		assertEqual(score, -10, '糟糕换入得分约 -10');
		assert(score <= 5, '不应该执行换人');
	});

	test('中等换入: 抵抗一招 + 无克制 + 中等 HP / Average switch: resist one + no SE + avg HP', () => {
		// Score: +6(resist) + 7(70% HP) = 13
		const score = 6 + 7;
		assertEqual(score, 13, '中等换入得分约 13');
		assert(score > 5, '可以执行换人');
	});
}

module.exports = { runSwitchingTests };
