/**
 * 格式等级解析测试 / Format Level Resolution Tests
 * 测试 getFormatLevel 和 resolveLevel 函数
 */

const { section, test, assertEqual } = require('./test-utils');

function runFormatLevelTests() {
	const { getFormatLevel, resolveLevel } = require('../../../dist/server/npc/ai/cfru/types');

	// =============================================================================
	// getFormatLevel 测试 / getFormatLevel Tests
	// =============================================================================

	section('格式等级推断 / Format Level Inference');

	// 随机对战
	test('Random Battle 应返回 0 (使用追踪值) / Random Battle returns 0', () => {
		assertEqual(getFormatLevel('gen9randombattle'), 0);
		assertEqual(getFormatLevel('gen8randombattle'), 0);
		assertEqual(getFormatLevel('gen9randomdoublesbattle'), 0);
	});

	// Little Cup
	test('Little Cup 应返回 5 / Little Cup returns 5', () => {
		assertEqual(getFormatLevel('gen9lc'), 5);
		assertEqual(getFormatLevel('gen9littlecup'), 5);
		assertEqual(getFormatLevel('gen8lc'), 5);
	});

	// VGC / BSS
	test('VGC 应返回 50 / VGC returns 50', () => {
		assertEqual(getFormatLevel('gen9vgc2024'), 50);
		assertEqual(getFormatLevel('gen9vgc2024regh'), 50);
		assertEqual(getFormatLevel('gen8vgc2022'), 50);
	});

	test('BSS 应返回 50 / BSS returns 50', () => {
		assertEqual(getFormatLevel('gen9bss'), 50);
		assertEqual(getFormatLevel('gen9battlestadiumsingles'), 50);
	});

	// National Dex / OU
	test('National Dex 应返回 100 / National Dex returns 100', () => {
		assertEqual(getFormatLevel('gen9nationaldex'), 100);
		assertEqual(getFormatLevel('gen9nationaldexmulti'), 100);
	});

	test('OU/UU/Uber 应返回 100 / OU/UU/Uber returns 100', () => {
		assertEqual(getFormatLevel('gen9ou'), 100);
		assertEqual(getFormatLevel('gen9uu'), 100);
		assertEqual(getFormatLevel('gen9uber'), 100);
	});

	// 空/未知格式
	test('空格式应返回 100 / Empty format returns 100', () => {
		assertEqual(getFormatLevel(''), 100);
		assertEqual(getFormatLevel('unknownformat'), 100);
	});

	// =============================================================================
	// resolveLevel 测试 / resolveLevel Tests
	// =============================================================================

	section('等级解析策略 / Level Resolution Strategy');

	// 随机对战：使用追踪值
	test('随机对战应使用追踪的等级 / Random battles use tracked level', () => {
		assertEqual(resolveLevel('gen9randombattle', 83), 83, '使用追踪的等级 83');
		assertEqual(resolveLevel('gen9randombattle', 76), 76, '使用追踪的等级 76');
	});

	test('随机对战无追踪值时默认 100 / Random battles default to 100 without tracked level', () => {
		assertEqual(resolveLevel('gen9randombattle'), 100);
		assertEqual(resolveLevel('gen9randombattle', 0), 100);
		assertEqual(resolveLevel('gen9randombattle', undefined), 100);
	});

	// 固定等级格式：忽略追踪值
	test('National Dex 应忽略追踪值使用 100 / National Dex ignores tracked level, uses 100', () => {
		assertEqual(resolveLevel('gen9nationaldex', 50), 100, '忽略追踪的 50');
		assertEqual(resolveLevel('gen9nationaldex', 100), 100, '使用格式默认 100');
		assertEqual(resolveLevel('gen9nationaldex'), 100, '无追踪值也是 100');
	});

	test('VGC 应忽略追踪值使用 50 / VGC ignores tracked level, uses 50', () => {
		assertEqual(resolveLevel('gen9vgc2024', 100), 50, '忽略追踪的 100');
		assertEqual(resolveLevel('gen9vgc2024', 50), 50, '使用格式默认 50');
		assertEqual(resolveLevel('gen9vgc2024'), 50, '无追踪值也是 50');
	});

	test('Little Cup 应使用 5 / Little Cup uses 5', () => {
		assertEqual(resolveLevel('gen9lc', 100), 5, '忽略追踪的 100');
		assertEqual(resolveLevel('gen9lc', 5), 5, '使用格式默认 5');
	});

	// =============================================================================
	// 一致性测试 / Consistency Tests
	// =============================================================================

	section('双方等级一致性 / Attacker-Defender Level Consistency');

	test('攻击方和防御方应使用相同等级 / Attacker and defender use same level', () => {
		// 模拟场景：National Dex 格式，己方从 request 解析到 100，对手从追踪解析到 100
		const format = 'gen9nationaldex';
		const selfLevel = resolveLevel(format, 100);    // 己方
		const opponentLevel = resolveLevel(format, 100); // 对手
		assertEqual(selfLevel, opponentLevel, '双方等级应一致');
	});

	test('即使追踪失败也保持一致 / Consistency even when tracking fails', () => {
		// 模拟场景：对手追踪失败，没有 parsedLevel
		const format = 'gen9nationaldex';
		const selfLevel = resolveLevel(format, 100);    // 己方有等级
		const opponentLevel = resolveLevel(format);     // 对手无等级
		assertEqual(selfLevel, opponentLevel, '双方等级应一致 (都是 100)');
	});
}

module.exports = { runFormatLevelTests };
