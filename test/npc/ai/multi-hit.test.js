/**
 * 多次攻击伤害计算测试 / Multi-Hit Move Tests
 * 测试 Skill Link, Loaded Dice, 固定次数攻击等
 */

const { section, test, assertEqual } = require('./test-utils');

function runMultiHitTests() {
	const { getExpectedHitCount } = require('../../../dist/server/npc/ai/cfru/util/damage-calc');

	function mockMove(id, multihit) {
		return { id, multihit };
	}

	// =============================================================================
	// 多次攻击伤害计算测试 / MULTI-HIT MOVE DAMAGE CALCULATION TESTS
	// =============================================================================

	section('多次攻击伤害计算 / Multi-Hit Move Damage Calculation');

	// 单次攻击返回 1
	test('单次攻击招式应返回 1 / Single hit move returns 1', () => {
		const move = mockMove('earthquake', null);
		const hits = getExpectedHitCount(move, '', '', '');
		assertEqual(hits, 1, '地震应为1次攻击');
	});

	// 固定 2 次攻击 (二连踢)
	test('二连踢应返回 2 次 / Double Kick returns 2 hits', () => {
		const move = mockMove('doublekick', 2);
		const hits = getExpectedHitCount(move, '', '', '');
		assertEqual(hits, 2, '二连踢应为2次攻击');
	});

	// 2-5 次无特性 (种子机关枪平均)
	test('种子机关枪无特性应返回 3 次 (平均) / Bullet Seed without Skill Link returns 3', () => {
		const move = mockMove('bulletseed', [2, 5]);
		const hits = getExpectedHitCount(move, '', '', '');
		assertEqual(hits, 3, '种子机关枪平均应为3次');
	});

	// 2-5 次 + 连续攻击
	test('种子机关枪 + 连续攻击应返回 5 次 / Bullet Seed with Skill Link returns 5', () => {
		const move = mockMove('bulletseed', [2, 5]);
		const hits = getExpectedHitCount(move, 'Skill Link', '', '');
		assertEqual(hits, 5, '连续攻击应固定5次');
	});

	// 2-5 次 + 读取骰子
	test('种子机关枪 + 读取骰子应返回 4.5 次 / Bullet Seed with Loaded Dice returns 4.5', () => {
		const move = mockMove('bulletseed', [2, 5]);
		const hits = getExpectedHitCount(move, '', 'Loaded Dice', '');
		assertEqual(hits, 4.5, '读取骰子平均应为4.5次');
	});

	// 水流连击固定 3 次
	test('水流连击应固定 3 次 / Surging Strikes always returns 3', () => {
		const move = mockMove('surgingstrikes', 3);
		const hits = getExpectedHitCount(move, '', '', '');
		assertEqual(hits, 3, '水流连击应为3次');
	});

	// 飞水手里剑 (小智版甲贺忍蛙)
	test('飞水手里剑 (小智版甲贺忍蛙) 应返回 3 次 / Water Shuriken for Ash-Greninja returns 3', () => {
		const move = mockMove('watershuriken', [2, 5]);
		const hits = getExpectedHitCount(move, '', '', 'Greninja-Ash');
		assertEqual(hits, 3, '小智版甲贺忍蛙飞水手里剑应为3次');
	});

	// 飞水手里剑 (普通甲贺忍蛙)
	test('飞水手里剑 (普通甲贺忍蛙) 应返回 3 次 (平均) / Water Shuriken for normal Greninja returns 3', () => {
		const move = mockMove('watershuriken', [2, 5]);
		const hits = getExpectedHitCount(move, '', '', 'Greninja');
		assertEqual(hits, 3, '普通甲贺忍蛙飞水手里剑平均应为3次');
	});

	// 鼠数儿 + 连续攻击
	test('鼠数儿 + 连续攻击应返回 10 次 / Population Bomb with Skill Link returns 10', () => {
		const move = mockMove('populationbomb', [1, 10]);
		const hits = getExpectedHitCount(move, 'Skill Link', '', '');
		assertEqual(hits, 10, '连续攻击鼠数儿应为10次');
	});

	// 鼠数儿 + 读取骰子
	test('鼠数儿 + 读取骰子应返回 7 次 / Population Bomb with Loaded Dice returns 7', () => {
		const move = mockMove('populationbomb', [1, 10]);
		const hits = getExpectedHitCount(move, '', 'Loaded Dice', '');
		assertEqual(hits, 7, '读取骰子鼠数儿应为7次');
	});
}

module.exports = { runMultiHitTests };
