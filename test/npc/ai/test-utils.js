/**
 * 测试框架工具 / Test Framework Utilities
 * 提供统一的测试函数和断言工具
 */

let passed = 0;
let failed = 0;
let currentSection = '';

/**
 * 开始一个新的测试部分
 * @param {string} name 部分名称
 */
function section(name) {
	currentSection = name;
	console.log(`\n--- ${name} ---`);
}

/**
 * 运行单个测试
 * @param {string} name 测试名称
 * @param {Function} fn 测试函数
 */
function test(name, fn) {
	try {
		fn();
		console.log(`✓ ${name}`);
		passed++;
	} catch (e) {
		console.log(`✗ ${name}`);
		console.log(`  Error: ${e.message}`);
		failed++;
	}
}

/**
 * 断言条件为真
 * @param {boolean} condition 条件
 * @param {string} message 错误消息
 */
function assert(condition, message) {
	if (!condition) throw new Error(message);
}

/**
 * 断言两个值相等
 * @param {*} actual 实际值
 * @param {*} expected 期望值
 * @param {string} message 错误消息
 */
function assertEqual(actual, expected, message) {
	if (actual !== expected) {
		throw new Error(`${message}: expected ${expected}, got ${actual}`);
	}
}

/**
 * 深度合并两个对象
 * @param {Object} target 目标对象
 * @param {Object} source 源对象
 * @returns {Object} 合并后的对象
 */
function deepMerge(target, source) {
	const result = { ...target };
	for (const key of Object.keys(source)) {
		if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) && !(source[key] instanceof Set) && !(source[key] instanceof Map)) {
			result[key] = deepMerge(target[key] || {}, source[key]);
		} else {
			result[key] = source[key];
		}
	}
	return result;
}

/**
 * 获取测试结果
 * @returns {{ passed: number, failed: number }}
 */
function getResults() {
	return { passed, failed };
}

/**
 * 重置测试计数器
 */
function resetResults() {
	passed = 0;
	failed = 0;
}

/**
 * 打印测试结果摘要
 */
function printSummary() {
	console.log(`\n=== Results / 结果: ${passed} passed / 通过, ${failed} failed / 失败 ===`);
}

/**
 * 创建双打评分上下文
 * Create a doubles scoring context
 */
function createDoublesContext(overrides = {}) {
	const defaultCtx = {
		state: {
			isDoubles: true,
			field: { weather: '', terrain: '' },
			opponent: { conditions: {} },
			self: {
				conditions: {},
				active: [
					{ slot: 0, fainted: false },
					{ slot: 1, fainted: false },
				],
			},
		},
		attacker: {
			slot: 0,
			boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
			hpPercent: 100,
			ability: '',
			item: '',
			types: ['Normal'],
			baseStats: { spe: 100 },
		},
		target: {
			slot: 1,
			boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
			hpPercent: 100,
			ability: '',
			item: '',
			types: ['Normal'],
			baseStats: { spe: 100 },
		},
		partner: {
			slot: 1,
			fainted: false,
			boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
			hpPercent: 100,
			ability: '',
			item: '',
			types: ['Normal'],
		},
		move: {
			id: 'earthquake',
			category: 'Physical',
			type: 'Ground',
			basePower: 100,
			target: 'normal',
			flags: {},
		},
		isTargetingPartner: false,
		flags: { canKO: false },
		adjustments: [],
		cache: { typeEffectiveness: new Map() },
	};

	const ctx = deepMerge(defaultCtx, overrides);
	const { makeAIPokemonSkeleton } = require('../../../dist/server/npc/ai/cfru/util/pokemon-builder');
	const { createAICache } = require('../../../dist/server/npc/ai/cfru/types');
	for (const key of ['attacker', 'target', 'partner']) {
		const base = makeAIPokemonSkeleton({
			slot: key === 'attacker' ? 0 : 1, species: 'Mew', hp: 300, maxHp: 300, hpPercent: 100,
			status: '', fainted: false, types: ['Normal'], ability: '', item: '', moves: ['earthquake'],
			baseStats: { hp: 300, atk: 200, def: 200, spa: 200, spd: 200, spe: 100 },
			active: true, level: 100, gender: 'N',
		});
		ctx[key] = { ...base, ...ctx[key], baseStats: { ...base.baseStats, ...ctx[key].baseStats } };
	}
	ctx.state.self.active = [ctx.attacker, ctx.partner];
	ctx.state.opponent.active = [ctx.target];
	ctx.state.self.team ||= [ctx.attacker, ctx.partner];
	ctx.state.opponent.team ||= [ctx.target];
	ctx.cache = createAICache(1);
	return ctx;
}

/**
 * 创建模拟 Pokemon 对象
 */
function createMockPokemon(overrides = {}) {
	return {
		hp: 100,
		maxHp: 100,
		hpPercent: 100,
		status: '',
		ability: '',
		item: '',
		types: ['Normal'],
		volatiles: new Set(),
		toxicCounter: 1,
		...overrides,
	};
}

module.exports = {
	section,
	test,
	assert,
	assertEqual,
	deepMerge,
	getResults,
	resetResults,
	printSummary,
	createDoublesContext,
	createMockPokemon,
};
