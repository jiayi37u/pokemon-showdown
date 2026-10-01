/**
 * 双打队友检查测试 / Doubles Partner Check Tests
 * 测试双打中队友伤害、状态招式、群攻招式等
 */

const { section, test, assertEqual, assert, deepMerge } = require('./test-utils');

function runDoublesPartnerTests() {
	const { checkTargetingPartnerDamage, checkTargetingPartnerStatus, checkSpreadMoveHitsPartner } = require('../../../dist/server/npc/ai/cfru/scoring/negatives');

	/**
	 * 创建双打评分上下文
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

	// =============================================================================
	// 双打队友检查测试 / DOUBLES PARTNER CHECK TESTS
	// =============================================================================

	section('双打队友检查 / Doubles Partner Checks');

	// 攻击队友时应扣分 (无特殊原因)
	test('攻击队友时应扣分 / Attacking partner should be penalized', () => {
		const ctx = createDoublesContext({
			isTargetingPartner: true,
			move: { category: 'Physical', type: 'Normal', id: 'tackle' },
		});
		const penalty = checkTargetingPartnerDamage(ctx);
		assert(penalty < 0, `应有负分, 实际为${penalty}`);
	});

	// 不攻击队友时不应扣分
	test('不攻击队友时不应扣分 / Not targeting partner should not be penalized', () => {
		const ctx = createDoublesContext({
			isTargetingPartner: false,
		});
		const penalty = checkTargetingPartnerDamage(ctx);
		assertEqual(penalty, 0, '不攻击队友时应为0');
	});

	// 队友有蓄电时用电招不扣分
	test('队友有蓄电时用电招不扣分 / Electric move on Volt Absorb partner not penalized', () => {
		const ctx = createDoublesContext({
			isTargetingPartner: true,
			target: { ability: 'Volt Absorb' },
			move: { category: 'Special', type: 'Electric', id: 'thunderbolt' },
		});
		const penalty = checkTargetingPartnerDamage(ctx);
		assertEqual(penalty, 0, '蓄电队友吸收电招');
	});

	// 队友有储水时用水招不扣分
	test('队友有储水时用水招不扣分 / Water move on Water Absorb partner not penalized', () => {
		const ctx = createDoublesContext({
			isTargetingPartner: true,
			target: { ability: 'Water Absorb' },
			move: { category: 'Special', type: 'Water', id: 'surf' },
		});
		const penalty = checkTargetingPartnerDamage(ctx);
		assertEqual(penalty, 0, '储水队友吸收水招');
	});

	// 队友有引火时用火招不扣分
	test('队友有引火时用火招不扣分 / Fire move on Flash Fire partner not penalized', () => {
		const ctx = createDoublesContext({
			isTargetingPartner: true,
			target: { ability: 'Flash Fire' },
			move: { category: 'Special', type: 'Fire', id: 'flamethrower' },
		});
		const penalty = checkTargetingPartnerDamage(ctx);
		assertEqual(penalty, 0, '引火队友吸收火招');
	});

	// 队友有食草时用草招不扣分
	test('队友有食草时用草招不扣分 / Grass move on Sap Sipper partner not penalized', () => {
		const ctx = createDoublesContext({
			isTargetingPartner: true,
			target: { ability: 'Sap Sipper' },
			move: { category: 'Physical', type: 'Grass', id: 'leafblade' },
		});
		const penalty = checkTargetingPartnerDamage(ctx);
		assertEqual(penalty, 0, '食草队友吸收草招');
	});

	// 对队友用有害状态招式大扣分
	test('对队友用有害状态招式大扣分 / Harmful status move on partner heavily penalized', () => {
		const ctx = createDoublesContext({
			isTargetingPartner: true,
			move: { category: 'Status', type: 'Electric', id: 'thunderwave', flags: {} },
		});
		const penalty = checkTargetingPartnerStatus(ctx);
		assert(penalty <= -100, `应有大负分, 实际为${penalty}`);
	});

	// 对队友用帮助不扣分
	test('对队友用帮助不扣分 / Helping Hand on partner not penalized', () => {
		const ctx = createDoublesContext({
			isTargetingPartner: true,
			move: { category: 'Status', type: 'Normal', id: 'helpinghand', flags: {} },
		});
		const penalty = checkTargetingPartnerStatus(ctx);
		assertEqual(penalty, 0, '帮助是好的队友招式');
	});

	// 对队友用治愈铃声不扣分
	test('对队友用治愈铃声不扣分 / Heal Bell on partner not penalized', () => {
		const ctx = createDoublesContext({
			isTargetingPartner: true,
			move: { category: 'Status', type: 'Normal', id: 'healbell', flags: {} },
		});
		const penalty = checkTargetingPartnerStatus(ctx);
		assertEqual(penalty, 0, '治愈铃声是好的队友招式');
	});

	// 双打中地震会打到队友
	test('双打中地震会打到队友应扣分 / Earthquake hitting partner in doubles penalized', () => {
		const ctx = createDoublesContext({
			move: {
				id: 'earthquake',
				category: 'Physical',
				type: 'Ground',
				basePower: 100,
				target: 'allAdjacent',
				flags: {},
			},
			partner: { types: ['Normal'], ability: '', fainted: false },
		});
		const penalty = checkSpreadMoveHitsPartner(ctx);
		assert(penalty < 0, `地震打队友应扣分, 实际为${penalty}`);
	});

	// 队友有飘浮时地震不扣分
	test('队友有飘浮时地震不扣分 / Earthquake when partner has Levitate not penalized', () => {
		const ctx = createDoublesContext({
			move: {
				id: 'earthquake',
				category: 'Physical',
				type: 'Ground',
				basePower: 100,
				target: 'allAdjacent',
				flags: {},
			},
			partner: { types: ['Normal'], ability: 'Levitate', fainted: false },
		});
		const penalty = checkSpreadMoveHitsPartner(ctx);
		assertEqual(penalty, 0, '飘浮队友免疫地震');
	});

	// 队友是飞行系时地震不扣分
	test('队友是飞行系时地震不扣分 / Earthquake when partner is Flying type not penalized', () => {
		const ctx = createDoublesContext({
			move: {
				id: 'earthquake',
				category: 'Physical',
				type: 'Ground',
				basePower: 100,
				target: 'allAdjacent',
				flags: {},
			},
			partner: { types: ['Flying'], ability: '', fainted: false },
		});
		const penalty = checkSpreadMoveHitsPartner(ctx);
		assertEqual(penalty, 0, '飞行系队友免疫地震');
	});

	// 单打中不检查队友
	test('单打中不检查队友 / No partner check in singles', () => {
		const ctx = createDoublesContext({
			state: { isDoubles: false },
			move: {
				id: 'earthquake',
				category: 'Physical',
				type: 'Ground',
				basePower: 100,
				target: 'allAdjacent',
				flags: {},
			},
		});
		const penalty = checkSpreadMoveHitsPartner(ctx);
		assertEqual(penalty, 0, '单打中不检查队友');
	});

	// 队友倒下时不检查
	test('队友倒下时不检查 / No check when partner fainted', () => {
		const ctx = createDoublesContext({
			move: {
				id: 'earthquake',
				category: 'Physical',
				type: 'Ground',
				basePower: 100,
				target: 'allAdjacent',
				flags: {},
			},
			partner: { types: ['Normal'], ability: '', fainted: true },
		});
		const penalty = checkSpreadMoveHitsPartner(ctx);
		assertEqual(penalty, 0, '队友倒下时不扣分');
	});
}

module.exports = { runDoublesPartnerTests };
