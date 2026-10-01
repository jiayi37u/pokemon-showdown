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
 * 创建模拟评分上下文的辅助函数
 * Helper to create a mock scoring context
 */
function createMockContext(attackerBoosts = {}, hpPercent = 100, targetBoosts = {}, moveId = 'swordsdance') {
	const { DEFAULT_AI_CONFIG, createAICache } = require('../../../dist/server/npc/ai/cfru/types');
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

	return deepMerge(defaultCtx, overrides);
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
	createMockContext,
	createDoublesContext,
	createMockPokemon,
};
