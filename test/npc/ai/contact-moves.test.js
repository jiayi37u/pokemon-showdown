/**
 * 接触招式风险测试 / Contact Move Risk Tests
 * 测试铁刺、粗糙皮肤、静电等接触反伤效果
 */

const { section, test, assertEqual, assert, deepMerge } = require('./test-utils');

function runContactMoveTests() {
	const { checkContactRisk } = require('../../../dist/server/npc/ai/cfru/scoring/negatives');

	/**
	 * 创建接触招式评分上下文
	 */
	function createContactContext(overrides = {}) {
		const defaultCtx = {
			state: {
				isDoubles: false,
				field: { weather: '', terrain: '' },
				opponent: { conditions: {} },
				self: { conditions: {} },
			},
			attacker: {
				slot: 0,
				boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
				hpPercent: 100,
				ability: '',
				item: '',
				types: ['Normal'],
				status: '',
			},
			target: {
				slot: 1,
				boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
				hpPercent: 100,
				ability: '',
				item: '',
				types: ['Normal'],
			},
			move: {
				id: 'tackle',
				category: 'Physical',
				type: 'Normal',
				basePower: 40,
				flags: { contact: 1 },
			},
			flags: { canKO: false },
			adjustments: [],
		};

		return deepMerge(defaultCtx, overrides);
	}

	// =============================================================================
	// 接触招式风险测试 / CONTACT MOVE RISK TESTS
	// =============================================================================

	section('接触招式风险 / Contact Move Risk');

	// 铁刺应扣分
	test('铁刺应扣分 / Iron Barbs should be penalized', () => {
		const ctx = createContactContext({
			target: { ability: 'Iron Barbs' },
		});
		const penalty = checkContactRisk(ctx);
		assert(penalty < 0, `应有负分, 实际为${penalty}`);
	});

	// 粗糙皮肤应扣分
	test('粗糙皮肤应扣分 / Rough Skin should be penalized', () => {
		const ctx = createContactContext({
			target: { ability: 'Rough Skin' },
		});
		const penalty = checkContactRisk(ctx);
		assert(penalty < 0, `应有负分, 实际为${penalty}`);
	});

	// 静电应扣分
	test('静电应扣分 / Static should be penalized', () => {
		const ctx = createContactContext({
			target: { ability: 'Static' },
		});
		const penalty = checkContactRisk(ctx);
		assert(penalty < 0, `应有负分, 实际为${penalty}`);
	});

	// 电系对静电不应额外扣分
	test('电系对静电不应额外扣分 / Electric type vs Static not penalized', () => {
		const ctx = createContactContext({
			attacker: { types: ['Electric'] },
			target: { ability: 'Static' },
		});
		const penalty = checkContactRisk(ctx);
		assertEqual(penalty, 0, '电系免疫麻痹');
	});

	// 火焰之躯应扣分
	test('火焰之躯应扣分 / Flame Body should be penalized', () => {
		const ctx = createContactContext({
			target: { ability: 'Flame Body' },
		});
		const penalty = checkContactRisk(ctx);
		assert(penalty < 0, `应有负分, 实际为${penalty}`);
	});

	// 火系对火焰之躯不应额外扣分
	test('火系对火焰之躯不应额外扣分 / Fire type vs Flame Body not penalized', () => {
		const ctx = createContactContext({
			attacker: { types: ['Fire'] },
			target: { ability: 'Flame Body' },
		});
		const penalty = checkContactRisk(ctx);
		assertEqual(penalty, 0, '火系免疫烧伤');
	});

	// 气球橡皮应扣分
	test('气球橡皮应扣分 / Gooey should be penalized', () => {
		const ctx = createContactContext({
			target: { ability: 'Gooey' },
		});
		const penalty = checkContactRisk(ctx);
		assert(penalty < 0, `应有负分, 实际为${penalty}`);
	});

	// 木乃伊应扣分
	test('木乃伊应扣分 / Mummy should be penalized', () => {
		const ctx = createContactContext({
			target: { ability: 'Mummy' },
		});
		const penalty = checkContactRisk(ctx);
		assert(penalty < 0, `应有负分, 实际为${penalty}`);
	});

	// 木乃伊对有力量翻倍特性应大扣分
	test('木乃伊对力量翻倍特性应大扣分 / Mummy vs Huge Power heavily penalized', () => {
		const ctx = createContactContext({
			attacker: { ability: 'Huge Power' },
			target: { ability: 'Mummy' },
		});
		const penalty = checkContactRisk(ctx);
		assert(penalty <= -5, `应有大负分, 实际为${penalty}`);
	});

	// 凸凸头盔应扣分
	test('凸凸头盔应扣分 / Rocky Helmet should be penalized', () => {
		const ctx = createContactContext({
			target: { item: 'Rocky Helmet' },
		});
		const penalty = checkContactRisk(ctx);
		assert(penalty < 0, `应有负分, 实际为${penalty}`);
	});

	// Magic Guard 应免疫伤害类接触效果
	test('Magic Guard 应免疫伤害类接触效果 / Magic Guard immune to damage contact effects', () => {
		const ctx = createContactContext({
			attacker: { ability: 'Magic Guard' },
			target: { ability: 'Iron Barbs' },
		});
		const penalty = checkContactRisk(ctx);
		assertEqual(penalty, 0, 'Magic Guard 免疫铁刺伤害');
	});

	// 非接触招式不应扣分
	test('非接触招式不应扣分 / Non-contact move not penalized', () => {
		const ctx = {
			state: {
				isDoubles: false,
				field: { weather: '', terrain: '' },
				opponent: { conditions: {} },
				self: { conditions: {} },
			},
			attacker: {
				slot: 0,
				boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
				hpPercent: 100,
				ability: '',
				item: '',
				types: ['Normal'],
				status: '',
			},
			target: {
				slot: 1,
				boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
				hpPercent: 100,
				ability: 'Iron Barbs',
				item: '',
				types: ['Normal'],
			},
			move: {
				id: 'earthquake',
				category: 'Physical',
				type: 'Ground',
				basePower: 100,
				flags: {}, // No contact flag!
			},
			flags: { canKO: false },
			adjustments: [],
		};
		const penalty = checkContactRisk(ctx);
		assertEqual(penalty, 0, '非接触招式不受影响');
	});

	// 保护爪子应免疫接触效果
	test('保护爪子应免疫接触效果 / Protective Pads should negate contact effects', () => {
		const ctx = createContactContext({
			attacker: { item: 'Protective Pads' },
			target: { ability: 'Iron Barbs' },
		});
		const penalty = checkContactRisk(ctx);
		assertEqual(penalty, 0, '保护爪子免疫接触效果');
	});

	// 爆裂尸体应扣分
	test('爆裂尸体应扣分 / Perish Body should be penalized', () => {
		const ctx = createContactContext({
			target: { ability: 'Perish Body' },
		});
		const penalty = checkContactRisk(ctx);
		assert(penalty < 0, `应有负分, 实际为${penalty}`);
	});

	// 扒窃应扣分 (有道具)
	test('扒窃应扣分 (有道具) / Pickpocket penalized when holding item', () => {
		const ctx = createContactContext({
			attacker: { item: 'Life Orb' },
			target: { ability: 'Pickpocket' },
		});
		const penalty = checkContactRisk(ctx);
		assert(penalty < 0, `应有负分, 实际为${penalty}`);
	});

	// 扒窃不应扣分 (黏着)
	test('扒窃不应扣分 (黏着) / Pickpocket not penalized with Sticky Hold', () => {
		const ctx = createContactContext({
			attacker: { ability: 'Sticky Hold', item: 'Life Orb' },
			target: { ability: 'Pickpocket' },
		});
		const penalty = checkContactRisk(ctx);
		assertEqual(penalty, 0, '黏着防止扒窃');
	});
}

module.exports = { runContactMoveTests };
