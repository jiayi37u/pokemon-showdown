/**
 * 正面评分测试 / Positive Scoring Tests
 * 测试吸血招式、控制招式、天气招式、顺风、Salt Cure、群攻招式等
 */

const { section, test, assertEqual, assert, deepMerge } = require('./test-utils');

function runPositivesScoringTests() {
	const { rewardDrainMove, rewardDisable, rewardEncore, rewardWeatherMove, rewardTailwind, rewardSaltCure, rewardSpreadMove } = require('../../../dist/server/npc/ai/cfru/scoring/positives');

	// =============================================================================
	// 吸血招式加分测试 / DRAIN MOVE REWARD TESTS
	// =============================================================================

	section('吸血招式加分 / Drain Move Rewards');

	function createDrainContext(overrides = {}) {
		return {
			state: {
				isDoubles: false,
				field: { weather: '', terrain: '' },
				opponent: { conditions: {} },
				self: { conditions: {} },
			},
			attacker: {
				slot: 0,
				boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
				hpPercent: overrides.attackerHp || 100,
				ability: '',
				item: '',
				types: ['Fighting'],
				status: '',
				moves: ['drainpunch'],
				...overrides.attacker,
			},
			target: {
				slot: 1,
				boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
				hpPercent: 100,
				ability: '',
				item: '',
				types: ['Normal'],
				...overrides.target,
			},
			move: {
				id: overrides.moveId || 'drainpunch',
				category: 'Physical',
				type: 'Fighting',
				basePower: 75,
				flags: { contact: 1, punch: 1 },
			},
			flags: { canKO: false, goesFirst: overrides.goesFirst !== false },
			adjustments: [],
		};
	}

	test('低血量时吸血招式应有高加分 / Drain move bonus at low HP', () => {
		const ctx = createDrainContext({ attackerHp: 25 });
		const bonus = rewardDrainMove(ctx);
		assert(bonus >= 8, `低血量应有高加分, 实际为${bonus}`);
	});

	test('中等血量时吸血招式有中等加分 / Drain move bonus at moderate HP', () => {
		const ctx = createDrainContext({ attackerHp: 60 });
		const bonus = rewardDrainMove(ctx);
		assert(bonus >= 3 && bonus < 8, `中等血量应有中等加分, 实际为${bonus}`);
	});

	test('高血量时吸血招式仅有小加分 / Drain move small bonus at high HP', () => {
		const ctx = createDrainContext({ attackerHp: 90 });
		const bonus = rewardDrainMove(ctx);
		assert(bonus >= 1 && bonus < 3, `高血量应有小加分, 实际为${bonus}`);
	});

	test('非吸血招式不应有加分 / Non-drain move no bonus', () => {
		const ctx = createDrainContext({ moveId: 'closecombat' });
		ctx.move.id = 'closecombat';
		const bonus = rewardDrainMove(ctx);
		assertEqual(bonus, 0, '非吸血招式不应有加分');
	});

	test('Oblivion Wing 应有额外加分 / Oblivion Wing extra bonus', () => {
		const ctx = createDrainContext({ moveId: 'oblivionwing', attackerHp: 50 });
		ctx.move.id = 'oblivionwing';
		ctx.move.type = 'Flying';
		const bonus = rewardDrainMove(ctx);
		assert(bonus >= 7, `Oblivion Wing应有额外加分, 实际为${bonus}`);
	});

	// =============================================================================
	// 控制招式加分测试 / CONTROL MOVE REWARD TESTS
	// =============================================================================

	section('控制招式 / Control Moves (Encore/Disable)');

	function createControlContext(overrides = {}) {
		return {
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
				types: overrides.attackerTypes || ['Psychic'],
				status: '',
			},
			target: {
				slot: 1,
				boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
				hpPercent: 100,
				ability: '',
				item: overrides.targetItem || '',
				types: ['Normal'],
				baseStats: overrides.targetStats || { hp: 80, atk: 100, def: 80, spa: 60, spd: 80, spe: 100 },
				moves: overrides.targetMoves || ['swordsdance', 'earthquake'],
				lastMove: overrides.targetLastMove || '',
				volatiles: overrides.targetVolatiles || new Set(),
			},
			move: {
				id: overrides.moveId || 'disable',
				category: 'Status',
				type: 'Normal',
				basePower: 0,
				flags: {},
			},
			flags: { canKO: false, goesFirst: overrides.goesFirst !== false },
			adjustments: [],
		};
	}

	test('Disable: 对手没有使用过招式时不应有加分 / Disable no bonus if no lastMove', () => {
		const ctx = createControlContext({
			moveId: 'disable',
			targetLastMove: '',
			goesFirst: true,
		});
		const bonus = rewardDisable(ctx);
		assertEqual(bonus, 0, 'Disable对未使用招式的对手不应有加分');
	});

	test('Disable: 对手上回合使用状态招式时应有加分 / Disable bonus when lastMove is status', () => {
		const ctx = createControlContext({
			moveId: 'disable',
			targetLastMove: 'swordsdance',
			goesFirst: true,
		});
		const bonus = rewardDisable(ctx);
		assert(bonus >= 4, `Disable状态招式应有加分, 实际为${bonus}`);
	});

	test('Disable: 对手上回合使用攻击招式时也有加分（但较少）/ Disable small bonus when lastMove is attack', () => {
		const ctx = createControlContext({
			moveId: 'disable',
			targetLastMove: 'earthquake',
			goesFirst: true,
		});
		const bonus = rewardDisable(ctx);
		assert(bonus >= 2, `Disable攻击招式应有加分, 实际为${bonus}`);
	});

	test('Disable对已被定身法的对手不应有加分 / Disable no bonus if already disabled', () => {
		const ctx = createControlContext({
			moveId: 'disable',
			targetVolatiles: new Set(['disable']),
		});
		const bonus = rewardDisable(ctx);
		assertEqual(bonus, 0, 'Disable对已被定身法的对手不应有加分');
	});

	test('Encore: 对手上回合使用状态招式应有加分 / Encore bonus when lastMove is status', () => {
		const ctx = createControlContext({
			moveId: 'encore',
			targetLastMove: 'swordsdance',
			goesFirst: true,
		});
		const bonus = rewardEncore(ctx);
		assert(bonus >= 4, `Encore状态招式应有加分, 实际为${bonus}`);
	});

	test('Encore对持有心灵香草的对手不应有加分 / Encore no bonus vs Mental Herb', () => {
		const ctx = createControlContext({
			moveId: 'encore',
			targetItem: 'Mental Herb',
		});
		const bonus = rewardEncore(ctx);
		assertEqual(bonus, 0, 'Encore对持有心灵香草的对手不应有加分');
	});

	test('后手使用Encore有小加分 / Encore small bonus when slower with status lastMove', () => {
		const ctx = createControlContext({
			moveId: 'encore',
			targetLastMove: 'swordsdance',
			goesFirst: false,
		});
		const bonus = rewardEncore(ctx);
		assert(bonus > 0 && bonus < 5, `后手Encore应有小加分, 实际为${bonus}`);
	});

	test('Encore: 对手没有使用过招式时不应有加分 / Encore no bonus if no lastMove', () => {
		const ctx = createControlContext({
			moveId: 'encore',
			targetLastMove: '',
			goesFirst: true,
		});
		const bonus = rewardEncore(ctx);
		assertEqual(bonus, 0, 'Encore对未使用招式的对手不应有加分');
	});

	test('Encore: 对手上回合使用免疫招式应有加分 / Encore bonus when lastMove is immune', () => {
		const ctx = createControlContext({
			moveId: 'encore',
			targetLastMove: 'earthquake',
			attackerTypes: ['Flying'],
			goesFirst: true,
		});
		const bonus = rewardEncore(ctx);
		assert(bonus >= 4, `Encore免疫招式应有加分, 实际为${bonus}`);
	});

	test('Encore: 对手上回合使用普通攻击招式不应有加分 / Encore no bonus for normal attack lastMove', () => {
		const ctx = createControlContext({
			moveId: 'encore',
			targetLastMove: 'tackle',
			goesFirst: true,
		});
		const bonus = rewardEncore(ctx);
		assertEqual(bonus, 0, 'Encore对普通攻击招式不应有加分');
	});

	test('Encore对已被再来一次的对手不应有加分 / Encore no bonus if already encored', () => {
		const ctx = createControlContext({
			moveId: 'encore',
			targetLastMove: 'swordsdance',
			targetVolatiles: new Set(['encore']),
		});
		const bonus = rewardEncore(ctx);
		assertEqual(bonus, 0, 'Encore对已被再来一次的对手不应有加分');
	});

	// =============================================================================
	// 天气招式评分测试 / WEATHER MOVE REWARD TESTS
	// =============================================================================

	section('天气招式评分 / Weather Move Rewards');

	function createWeatherContext(overrides = {}) {
		return {
			state: {
				isDoubles: overrides.isDoubles || false,
				field: { weather: overrides.currentWeather || '', terrain: '' },
				opponent: { conditions: {}, team: [] },
				self: { conditions: { tailwind: overrides.tailwind || 0 }, team: [], reserve: overrides.reserve || [] },
			},
			attacker: {
				slot: 0,
				boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
				hpPercent: 100,
				ability: overrides.attackerAbility || '',
				item: '',
				types: overrides.attackerTypes || ['Normal'],
				status: '',
				moves: overrides.attackerMoves || [],
				stats: { spe: overrides.attackerSpeed || 100 },
				baseStats: { spe: overrides.attackerSpeed || 100 },
			},
			target: {
				slot: 1,
				boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
				hpPercent: 100,
				ability: '',
				item: '',
				types: ['Normal'],
				stats: { spe: overrides.targetSpeed || 100 },
				baseStats: { spe: overrides.targetSpeed || 100 },
			},
			move: {
				id: overrides.moveId || 'raindance',
				category: 'Status',
				type: 'Normal',
				basePower: 0,
				flags: {},
			},
			flags: { canKO: false, goesFirst: overrides.goesFirst !== false },
			adjustments: [],
		};
	}

	test('雨天 + 悠游自如应有高加分 / Rain Dance + Swift Swim high bonus', () => {
		const ctx = createWeatherContext({
			moveId: 'raindance',
			attackerAbility: 'Swift Swim',
		});
		const bonus = rewardWeatherMove(ctx);
		assert(bonus >= 10, `悠游自如应有高加分, 实际为${bonus}`);
	});

	test('雨天 + 水系招式应有加分 / Rain Dance + Water moves bonus', () => {
		const ctx = createWeatherContext({
			moveId: 'raindance',
			attackerTypes: ['Water'],
		});
		const bonus = rewardWeatherMove(ctx);
		assert(bonus >= 3, `水系应有加分, 实际为${bonus}`);
	});

	test('晴天 + 叶绿素应有高加分 / Sunny Day + Chlorophyll high bonus', () => {
		const ctx = createWeatherContext({
			moveId: 'sunnyday',
			attackerAbility: 'Chlorophyll',
		});
		const bonus = rewardWeatherMove(ctx);
		assert(bonus >= 10, `叶绿素应有高加分, 实际为${bonus}`);
	});

	test('晴天 + 日光束应有加分 / Sunny Day + Solar Beam bonus', () => {
		const ctx = createWeatherContext({
			moveId: 'sunnyday',
			attackerMoves: ['solarbeam'],
		});
		const bonus = rewardWeatherMove(ctx);
		assert(bonus >= 4, `日光束应有加分, 实际为${bonus}`);
	});

	test('沙暴 + 拨沙应有高加分 / Sandstorm + Sand Rush high bonus', () => {
		const ctx = createWeatherContext({
			moveId: 'sandstorm',
			attackerAbility: 'Sand Rush',
		});
		const bonus = rewardWeatherMove(ctx);
		assert(bonus >= 10, `拨沙应有高加分, 实际为${bonus}`);
	});

	test('沙暴 + 岩石系应有加分 / Sandstorm + Rock type bonus', () => {
		const ctx = createWeatherContext({
			moveId: 'sandstorm',
			attackerTypes: ['Rock'],
		});
		const bonus = rewardWeatherMove(ctx);
		assert(bonus >= 3, `岩石系应有加分, 实际为${bonus}`);
	});

	test('冰雹 + 拨雪应有高加分 / Hail + Slush Rush high bonus', () => {
		const ctx = createWeatherContext({
			moveId: 'hail',
			attackerAbility: 'Slush Rush',
		});
		const bonus = rewardWeatherMove(ctx);
		assert(bonus >= 10, `拨雪应有高加分, 实际为${bonus}`);
	});

	test('冰雹 + 暴风雪应有加分 / Hail + Blizzard bonus', () => {
		const ctx = createWeatherContext({
			moveId: 'hail',
			attackerMoves: ['blizzard'],
		});
		const bonus = rewardWeatherMove(ctx);
		assert(bonus >= 4, `暴风雪应有加分, 实际为${bonus}`);
	});

	test('非天气招式不应有加分 / Non-weather move no bonus', () => {
		const ctx = createWeatherContext({
			moveId: 'earthquake',
		});
		const bonus = rewardWeatherMove(ctx);
		assertEqual(bonus, 0, '非天气招式不应有加分');
	});

	// =============================================================================
	// 顺风评分测试 / TAILWIND REWARD TESTS
	// =============================================================================

	section('顺风评分 / Tailwind Rewards');

	test('速度劣势时顺风应有高加分 / Tailwind high bonus when slower', () => {
		const ctx = createWeatherContext({
			moveId: 'tailwind',
			attackerSpeed: 80,
			targetSpeed: 120,
		});
		const bonus = rewardTailwind(ctx);
		assert(bonus >= 12, `速度劣势应有高加分, 实际为${bonus}`);
	});

	test('速度优势时顺风有小加分 / Tailwind small bonus when faster', () => {
		const ctx = createWeatherContext({
			moveId: 'tailwind',
			attackerSpeed: 120,
			targetSpeed: 80,
		});
		const bonus = rewardTailwind(ctx);
		assert(bonus >= 4 && bonus < 12, `速度优势应有小加分, 实际为${bonus}`);
	});

	test('顺风已激活时不应有加分 / Tailwind no bonus if already active', () => {
		const ctx = createWeatherContext({
			moveId: 'tailwind',
			tailwind: 4,
		});
		const bonus = rewardTailwind(ctx);
		assertEqual(bonus, 0, '顺风已激活时不应有加分');
	});

	test('双打中顺风应有额外加分 / Tailwind extra bonus in doubles', () => {
		const ctx = createWeatherContext({
			moveId: 'tailwind',
			attackerSpeed: 80,
			targetSpeed: 120,
			isDoubles: true,
		});
		const bonus = rewardTailwind(ctx);
		assert(bonus >= 16, `双打顺风应有更高加分, 实际为${bonus}`);
	});

	test('非顺风招式不应有加分 / Non-Tailwind move no bonus', () => {
		const ctx = createWeatherContext({
			moveId: 'earthquake',
		});
		const bonus = rewardTailwind(ctx);
		assertEqual(bonus, 0, '非顺风招式不应有加分');
	});

	// =============================================================================
	// Salt Cure 评分测试 / SALT CURE SCORING TESTS
	// =============================================================================

	section('Salt Cure 评分 / Salt Cure Scoring');

	function createSaltCureContext(targetTypes, targetAbility = '', targetVolatiles = []) {
		return {
			move: {
				id: 'saltcure',
				name: 'Salt Cure',
				type: 'Rock',
				category: 'Physical',
				basePower: 40,
				accuracy: 100,
				priority: 0,
				pp: 15,
				maxPp: 15,
				target: 'normal',
				flags: { protect: 1, mirror: 1 },
				slot: 1,
				secondaryChance: 100,
			},
			attacker: {
				species: 'Garganacl',
				types: ['Rock'],
				ability: 'Purifying Salt',
				item: '',
				hp: 100,
				maxHp: 100,
				hpPercent: 100,
				baseStats: { hp: 100, atk: 100, def: 130, spa: 45, spd: 90, spe: 35 },
				boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
				status: '',
				moves: ['saltcure', 'bodypress', 'recover', 'stealthrock'],
				volatiles: new Set(),
				fainted: false,
				active: true,
				slot: 1,
			},
			target: {
				species: 'Slowbro',
				types: targetTypes,
				ability: targetAbility,
				item: '',
				hp: 100,
				maxHp: 100,
				hpPercent: 100,
				baseStats: { hp: 95, atk: 75, def: 110, spa: 100, spd: 80, spe: 30 },
				boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
				status: '',
				moves: ['scald', 'slackoff', 'psyshock', 'thunderwave'],
				volatiles: new Set(targetVolatiles),
				fainted: false,
				active: true,
				slot: 1,
			},
			state: {
				turn: 1,
				isDoubles: false,
				self: { active: [], reserve: [], team: [], conditions: {} },
				opponent: { active: [], reserve: [], team: [], conditions: {} },
				field: { weather: '', terrain: '' },
			},
			flags: {
				canKO: false,
				can2HKO: false,
				goesFirst: false,
				isSuperEffective: false,
				isResisted: false,
				isImmune: false,
				hasNoEffect: false,
			},
			damageResult: {
				minDamage: 20,
				maxDamage: 25,
				averageDamage: 22,
				minPercent: 20,
				maxPercent: 25,
				averagePercent: 22,
			},
			adjustments: [],
		};
	}

	test('Salt Cure 对普通目标应获得基础加分 / Salt Cure should get base bonus vs normal target', () => {
		const ctx = createSaltCureContext(['Normal'], '');
		const bonus = rewardSaltCure(ctx);
		assert(bonus >= 4, `Salt Cure 基础加分应至少 4 分，实际: ${bonus}`);
	});

	test('Salt Cure 对水系应获得额外加分 / Salt Cure should get extra bonus vs Water type', () => {
		const ctx = createSaltCureContext(['Water', 'Psychic'], '');
		const bonus = rewardSaltCure(ctx);
		assert(bonus >= 10, `Salt Cure vs 水系应获得高分，实际: ${bonus}`);
	});

	test('Salt Cure 对钢系应获得额外加分 / Salt Cure should get extra bonus vs Steel type', () => {
		const ctx = createSaltCureContext(['Steel', 'Ground'], '');
		const bonus = rewardSaltCure(ctx);
		assert(bonus >= 10, `Salt Cure vs 钢系应获得高分，实际: ${bonus}`);
	});

	test('Salt Cure 对 Magic Guard 应返回 0 / Salt Cure should return 0 vs Magic Guard', () => {
		const ctx = createSaltCureContext(['Psychic', 'Fairy'], 'Magic Guard');
		const bonus = rewardSaltCure(ctx);
		assertEqual(bonus, 0, 'Magic Guard 应阻止 Salt Cure 加分');
	});

	test('Salt Cure 对已被 Salt Cure 的目标应返回 0 / Salt Cure should return 0 if target already has Salt Cure', () => {
		const ctx = createSaltCureContext(['Normal'], '', ['saltcure']);
		const bonus = rewardSaltCure(ctx);
		assertEqual(bonus, 0, '已被 Salt Cure 不应再加分');
	});

	test('Salt Cure 对坦克型目标应获得额外加分 / Salt Cure should get bonus vs bulky target', () => {
		const ctx = createSaltCureContext(['Normal'], '');
		ctx.target.baseStats = { hp: 120, atk: 60, def: 100, spa: 60, spd: 100, spe: 50 };
		const bonus = rewardSaltCure(ctx);
		assert(bonus >= 7, `Salt Cure vs 坦克应获得更高分，实际: ${bonus}`);
	});

	// =============================================================================
	// 群攻招式奖励测试 / SPREAD MOVE REWARD TESTS
	// =============================================================================

	section('群攻招式奖励 / Spread Move Rewards');

	function createSpreadMoveContext(overrides = {}) {
		const defaultCtx = {
			state: {
				isDoubles: true,
				field: { weather: '', terrain: '' },
				opponent: {
					conditions: {},
					active: [
						{
							slot: 1,
							species: 'Incineroar',
							types: ['Fire', 'Dark'],
							ability: '',
							item: '',
							level: 50,
							hp: 300,
							maxHp: 300,
							hpPercent: 100,
							fainted: false,
							baseStats: { hp: 95, atk: 115, def: 90, spa: 80, spd: 90, spe: 60 },
							stats: { hp: 300, atk: 200, def: 150, spa: 130, spd: 150, spe: 100 },
							boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
							volatiles: new Set(),
							status: '',
						},
						{
							slot: 2,
							species: 'Togekiss',
							types: ['Fairy', 'Flying'],
							ability: '',
							item: '',
							level: 50,
							hp: 280,
							maxHp: 280,
							hpPercent: 100,
							fainted: false,
							baseStats: { hp: 85, atk: 50, def: 95, spa: 120, spd: 115, spe: 80 },
							stats: { hp: 280, atk: 100, def: 150, spa: 200, spd: 190, spe: 130 },
							boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
							volatiles: new Set(),
							status: '',
						},
					],
				},
				self: {
					conditions: {},
					active: [
						{
							slot: 1,
							species: 'Excadrill',
							types: ['Ground', 'Steel'],
							ability: '',
							item: '',
							level: 50,
							hp: 320,
							maxHp: 320,
							hpPercent: 100,
							fainted: false,
							baseStats: { hp: 110, atk: 135, def: 60, spa: 50, spd: 65, spe: 88 },
							stats: { hp: 320, atk: 250, def: 120, spa: 100, spd: 130, spe: 150 },
							boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
							volatiles: new Set(),
							status: '',
						},
					],
				},
			},
			attacker: {
				slot: 1,
				species: 'Excadrill',
				types: ['Ground', 'Steel'],
				ability: '',
				item: '',
				level: 50,
				hp: 320,
				maxHp: 320,
				hpPercent: 100,
				baseStats: { hp: 110, atk: 135, def: 60, spa: 50, spd: 65, spe: 88 },
				stats: { hp: 320, atk: 250, def: 120, spa: 100, spd: 130, spe: 150 },
				boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
				volatiles: new Set(),
				status: '',
			},
			target: null,
			move: {
				id: 'earthquake',
				category: 'Physical',
				type: 'Ground',
				basePower: 100,
				target: 'allAdjacent',
				flags: {},
			},
			flags: { canKO: false, goesFirst: true },
			adjustments: [],
			cache: { damageCalc: new Map(), typeEffectiveness: new Map() },
		};

		const ctx = deepMerge(defaultCtx, overrides);
		if (!ctx.target) {
			ctx.target = ctx.state.opponent.active[0];
		}
		return ctx;
	}

	test('v1.1.21: 群攻对多个对手都有效时应获得基础奖励 / Spread move effective against both opponents gets base bonus', () => {
		const ctx = createSpreadMoveContext({
			state: {
				isDoubles: true,
				field: { weather: '', terrain: '' },
				opponent: {
					conditions: {},
					active: [
						{
							slot: 1,
							species: 'Incineroar',
							types: ['Fire', 'Dark'],
							ability: '',
							item: '',
							level: 50,
							hp: 150,
							maxHp: 300,
							hpPercent: 50,
							fainted: false,
							baseStats: { hp: 95, atk: 115, def: 90, spa: 80, spd: 90, spe: 60 },
							stats: { hp: 300, atk: 200, def: 150, spa: 130, spd: 150, spe: 100 },
							boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
							volatiles: new Set(),
							status: '',
						},
						{
							slot: 2,
							species: 'Arcanine',
							types: ['Fire'],
							ability: '',
							item: '',
							level: 50,
							hp: 140,
							maxHp: 280,
							hpPercent: 50,
							fainted: false,
							baseStats: { hp: 90, atk: 110, def: 80, spa: 100, spd: 80, spe: 95 },
							stats: { hp: 280, atk: 180, def: 130, spa: 160, spd: 130, spe: 150 },
							boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
							volatiles: new Set(),
							status: '',
						},
					],
				},
			},
		});
		ctx.target = ctx.state.opponent.active[0];

		const bonus = rewardSpreadMove(ctx);
		assert(bonus >= 6, `群攻对两个对手都有效应至少获得 +6 基础奖励, 实际为 ${bonus}`);
	});

	test('v1.1.22: 群攻对另一个对手免疫时不应获得 +6 基础奖励 / Spread move immune to other opponent should not get +6 base bonus', () => {
		const ctx = createSpreadMoveContext({
			state: {
				isDoubles: true,
				field: { weather: '', terrain: '' },
				opponent: {
					conditions: {},
					active: [
						{
							slot: 1,
							species: 'Incineroar',
							types: ['Fire', 'Dark'],
							ability: '',
							item: '',
							level: 50,
							hp: 150,
							maxHp: 300,
							hpPercent: 50,
							fainted: false,
							baseStats: { hp: 95, atk: 115, def: 90, spa: 80, spd: 90, spe: 60 },
							stats: { hp: 300, atk: 200, def: 150, spa: 130, spd: 150, spe: 100 },
							boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
							volatiles: new Set(),
							status: '',
						},
						{
							slot: 2,
							species: 'Togekiss',
							types: ['Fairy', 'Flying'],
							ability: '',
							item: '',
							level: 50,
							hp: 280,
							maxHp: 280,
							hpPercent: 100,
							fainted: false,
							baseStats: { hp: 85, atk: 50, def: 95, spa: 120, spd: 115, spe: 80 },
							stats: { hp: 280, atk: 100, def: 150, spa: 200, spd: 190, spe: 130 },
							boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
							volatiles: new Set(),
							status: '',
						},
					],
				},
			},
		});
		ctx.target = ctx.state.opponent.active[0];

		const bonus = rewardSpreadMove(ctx);
		assert(bonus < 6, `群攻对飞行系对手免疫时不应获得 +6 基础奖励, 实际为 ${bonus}`);
	});

	test('单打中群攻招式不应获得奖励 / Spread move in singles should get no bonus', () => {
		const ctx = createSpreadMoveContext({
			state: {
				isDoubles: false,
				field: { weather: '', terrain: '' },
				opponent: {
					conditions: {},
					active: [
						{
							slot: 1,
							species: 'Incineroar',
							types: ['Fire', 'Dark'],
							ability: '',
							hpPercent: 100,
							fainted: false,
						},
					],
				},
			},
		});

		const bonus = rewardSpreadMove(ctx);
		assertEqual(bonus, 0, '单打中群攻招式不应获得奖励');
	});

	test('状态招式不应获得群攻奖励 / Status moves should get no spread bonus', () => {
		const ctx = createSpreadMoveContext({
			move: {
				id: 'stealthrock',
				category: 'Status',
				type: 'Rock',
				basePower: 0,
				target: 'allAdjacentFoes',
				flags: {},
			},
		});

		const bonus = rewardSpreadMove(ctx);
		assertEqual(bonus, 0, '状态招式不应获得群攻奖励');
	});

	test('只有一个对手时群攻招式不应获得额外奖励 / Spread move with only one opponent gets no extra bonus', () => {
		const ctx = createSpreadMoveContext({
			state: {
				isDoubles: true,
				field: { weather: '', terrain: '' },
				opponent: {
					conditions: {},
					active: [
						{
							slot: 1,
							species: 'Incineroar',
							types: ['Fire', 'Dark'],
							ability: '',
							hpPercent: 100,
							fainted: false,
						},
					],
				},
			},
		});

		const bonus = rewardSpreadMove(ctx);
		assertEqual(bonus, 0, '只有一个对手时群攻招式不应获得额外奖励');
	});
	// =============================================================================
	// Knock Off 奖励测试 / KNOCK OFF REWARD TESTS
	// =============================================================================

	section('Knock Off 奖励 / Knock Off Rewards');

	const { rewardKnockOff } = require('../../../dist/server/npc/ai/cfru/scoring/positives');

	function createKnockOffContext(overrides = {}) {
		return {
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
				itemLost: false,
				types: ['Dark'],
				status: '',
				moves: ['knockoff'],
			},
			target: {
				slot: 1,
				boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
				hpPercent: 100,
				ability: overrides.targetAbility || '',
				item: overrides.targetItem || '',
				itemLost: overrides.targetItemLost || false,  // Added itemLost field
				types: overrides.targetTypes || ['Normal'],
				baseStats: overrides.targetBaseStats || { hp: 80, atk: 80, def: 80, spa: 80, spd: 80, spe: 80 },
				moves: overrides.targetMoves || [],
			},
			move: {
				id: overrides.moveId || 'knockoff',
				category: 'Physical',
				type: 'Dark',
				basePower: 65,
				flags: { contact: 1 },
			},
			flags: { canKO: false, goesFirst: true },
			adjustments: [],
		};
	}

	test('Knock Off 基础加分应为 +5 / Knock Off base bonus should be +5', () => {
		const ctx = createKnockOffContext({});
		const bonus = rewardKnockOff(ctx);
		assertEqual(bonus, 5, 'Knock Off 基础加分应为 5');
	});

	test('Knock Off 对 bulky 目标应额外 +3 / Knock Off vs bulky target should get +3 extra', () => {
		const ctx = createKnockOffContext({
			targetBaseStats: { hp: 100, atk: 50, def: 120, spa: 50, spd: 100, spe: 50 }, // Bulky
		});
		const bonus = rewardKnockOff(ctx);
		assertEqual(bonus, 8, 'Knock Off 对 bulky 目标应为 5+3=8');
	});

	test('Knock Off 对非 bulky 目标仅 +5 / Knock Off vs non-bulky target should be +5', () => {
		const ctx = createKnockOffContext({
			targetBaseStats: { hp: 60, atk: 100, def: 60, spa: 100, spd: 60, spe: 100 }, // Frail
		});
		const bonus = rewardKnockOff(ctx);
		assertEqual(bonus, 5, 'Knock Off 对非 bulky 目标应为 5');
	});

	test('Knock Off 对已失去道具的目标不应有加分 / Knock Off vs target who lost item should get no bonus', () => {
		const ctx = createKnockOffContext({
			targetItem: '', // Item lost
			targetItemLost: true, // Confirmed lost via -enditem
		});
		const bonus = rewardKnockOff(ctx);
		assertEqual(bonus, 0, 'Knock Off 对已失去道具目标不应有加分');
	});

	test('Knock Off 对已失去道具的 bulky 目标也不应有加分 / Knock Off vs bulky target who lost item should get no bonus', () => {
		const ctx = createKnockOffContext({
			targetItem: '', // Item lost
			targetItemLost: true, // Confirmed lost via -enditem
			targetBaseStats: { hp: 100, atk: 50, def: 120, spa: 50, spd: 100, spe: 50 }, // Bulky
		});
		const bonus = rewardKnockOff(ctx);
		assertEqual(bonus, 0, 'Knock Off 对已失去道具的 bulky 目标不应有加分');
	});

	test('非 Knock Off 招式不应获得加分 / Non-Knock Off move should not get bonus', () => {
		const ctx = createKnockOffContext({ moveId: 'crunch' });
		ctx.move.id = 'crunch';
		const bonus = rewardKnockOff(ctx);
		assertEqual(bonus, 0, '非 Knock Off 招式不应有加分');
	});
}

module.exports = { runPositivesScoringTests };
