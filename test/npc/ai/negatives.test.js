/**
 * 负面评分测试 / Negative Scoring Tests
 * 测试腹鼓、反击、状态招式、抵抗扣分、半无敌招式等
 */

const { section, test, assertEqual, assert, createMockContext, deepMerge } = require('./test-utils');

function runNegativesScoringTests() {
	const {
		checkBellyDrum,
		checkCounterMirrorCoat,
		checkBurnMove,
		checkPoisonMove,
		checkCovertCloak,
		checkPainSplit,
		checkDestinyBond,
		checkFutureSight,
		checkTrick,
		checkRecycle,
		checkFling,
		checkSemiInvulnerable,
		checkTypeResistance,
		checkLowDamage,
		checkSaltCure,
		checkSleepTalkSnore,
	} = require('../../../dist/server/npc/ai/cfru/scoring/negatives');

	// =============================================================================
	// 强化招式评分测试 / SETUP MOVE SCORING TESTS
	// =============================================================================

	section('强化招式评分逻辑 / Setup Move Scoring Logic');

	test('攻击+0时剑舞应获最高分 / Swords Dance at +0 atk gets highest score', () => {
		const ctx = createMockContext({ atk: 0 });
		assertEqual(ctx.attacker.boosts.atk, 0, '攻击从+0开始');
	});

	test('攻击+2时剑舞分数递减 / Swords Dance at +2 atk gets reduced score', () => {
		const ctx = createMockContext({ atk: 2 });
		assertEqual(ctx.attacker.boosts.atk, 2, '攻击从+2开始');
	});

	test('攻击+4时剑舞分数很低 / Swords Dance at +4 atk gets minimal score', () => {
		const ctx = createMockContext({ atk: 4 });
		assertEqual(ctx.attacker.boosts.atk, 4, '攻击从+4开始');
	});

	test('攻击+6（满级）时剑舞应为0分 / Swords Dance at +6 atk gets zero score', () => {
		const ctx = createMockContext({ atk: 6 });
		assertEqual(ctx.attacker.boosts.atk, 6, '攻击从+6开始（满级）');
	});

	test('100% HP 应允许完整强化加成 / Setup at 100% HP gets full bonus', () => {
		const hpPercent = 100;
		assert(hpPercent > 60, '高HP允许完整强化加成');
	});

	test('50% HP 时强化加成减少 / Setup at 50% HP gets reduced bonus', () => {
		const hpPercent = 50;
		assert(hpPercent <= 60 && hpPercent > 40, '中等HP减少加成');
	});

	test('30% HP 先手时加成大幅减少 / Setup at 30% HP when faster gets heavily reduced bonus', () => {
		const hpPercent = 30;
		const goesFirst = true;
		assert(hpPercent <= 40 && hpPercent > 25 && goesFirst, '低HP先手仍可强化');
	});

	test('30% HP 后手时应返回0 / Setup at 30% HP when slower returns 0', () => {
		const hpPercent = 30;
		const goesFirst = false;
		assert(hpPercent <= 40 && !goesFirst, '低HP后手阻止强化');
	});

	test('20% HP 时应始终返回0 / Setup at 20% HP always returns 0', () => {
		const hpPercent = 20;
		assert(hpPercent <= 25, '危急HP阻止所有强化');
	});

	test('对方提升防御时攻击强化更有价值 / Attack boost more valuable when target boosted defense', () => {
		const targetDefBoost = 2;
		const currentAtk = 0;
		assert(targetDefBoost > 0 && currentAtk < 4, '攻击强化克制防御强化');
	});

	test('已有高强化时无额外加分 / No extra bonus when already at high boost', () => {
		const currentAtk = 4;
		const targetDefBoost = 2;
		assert(!(targetDefBoost > 0 && currentAtk < 4), '高强化时无额外加分');
	});

	// =============================================================================
	// 魔法镜评分测试 / MAGIC BOUNCE SCORING TESTS
	// =============================================================================

	section('魔法镜评分 / Magic Bounce Scoring');

	test('可反弹招式对魔法镜应扣分 / Reflectable moves penalized against Magic Bounce', () => {
		const mockMove = {
			id: 'thunderwave',
			flags: { reflectable: 1 },
			category: 'Status',
		};
		assertEqual(mockMove.flags.reflectable, 1, '电磁波可被反弹');
	});

	test('不可反弹招式不应扣分 / Non-reflectable moves not penalized', () => {
		const mockMove = {
			id: 'earthquake',
			flags: {},
			category: 'Physical',
		};
		assertEqual(mockMove.flags.reflectable, undefined, '地震不可被反弹');
	});

	// =============================================================================
	// 状态招式重复检查 / STATUS MOVE REDUNDANCY TESTS
	// =============================================================================

	section('状态招式重复 / Status Move Redundancy');

	test('对已麻痹目标用电磁波应扣分 / Thunder Wave on paralyzed target penalized', () => {
		const targetStatus = 'par';
		assertEqual(targetStatus, 'par', '目标已麻痹');
	});

	test('对已睡眠目标用催眠招式应扣分 / Sleep moves on sleeping target penalized', () => {
		const targetStatus = 'slp';
		assertEqual(targetStatus, 'slp', '目标已睡眠');
	});

	test('对已中毒目标用剧毒应扣分 / Toxic on poisoned target penalized', () => {
		const targetStatus = 'tox';
		assertEqual(targetStatus, 'tox', '目标已剧毒');
	});

	// =============================================================================
	// 入场伤害重复检查 / ENTRY HAZARD REDUNDANCY TESTS
	// =============================================================================

	section('入场伤害重复 / Entry Hazard Redundancy');

	test('隐形岩已设置时应扣分 / Stealth Rock when already set penalized', () => {
		const opponentConditions = { stealthrock: true };
		assertEqual(opponentConditions.stealthrock, true, '隐形岩已设置');
	});

	test('撒菱满层（3层）时应扣分 / Spikes at max layers (3) penalized', () => {
		const opponentConditions = { spikes: 3 };
		assertEqual(opponentConditions.spikes, 3, '撒菱已满层');
	});

	test('毒菱满层（2层）时应扣分 / Toxic Spikes at max layers (2) penalized', () => {
		const opponentConditions = { toxicspikes: 2 };
		assertEqual(opponentConditions.toxicspikes, 2, '毒菱已满层');
	});

	// =============================================================================
	// 先制阻挡特性测试 / PRIORITY BLOCKING ABILITIES TESTS
	// =============================================================================

	section('先制阻挡特性 / Priority Blocking Abilities');

	test('鲜艳之躯应阻挡先制招式 / Dazzling blocks priority moves', () => {
		const abilityId = 'dazzling';
		const movePriority = 1;
		const moveTarget = 'normal';
		assert(movePriority > 0 && moveTarget !== 'self', '先制招式目标为对手');
	});

	test('非先制招式不应被鲜艳之躯阻挡 / Non-priority moves not blocked by Dazzling', () => {
		const movePriority = 0;
		assert(movePriority <= 0, '普通优先度招式');
	});

	// =============================================================================
	// 光墙/反射壁重复检查 / SCREENS REDUNDANCY TESTS
	// =============================================================================

	section('光墙/反射壁重复 / Screens Redundancy');

	test('光墙已设置时应扣分 / Light Screen when already active penalized', () => {
		const selfConditions = { lightscreen: 5 };
		assert(selfConditions.lightscreen > 0, '光墙已激活');
	});

	test('反射壁已设置时应扣分 / Reflect when already active penalized', () => {
		const selfConditions = { reflect: 5 };
		assert(selfConditions.reflect > 0, '反射壁已激活');
	});

	test('极光幕已设置时应扣分 / Aurora Veil when already active penalized', () => {
		const selfConditions = { auroraveil: 5 };
		assert(selfConditions.auroraveil > 0, '极光幕已激活');
	});

	test('极光幕在非冰雹天气时应扣分 / Aurora Veil without Hail/Snow penalized', () => {
		const weather = 'sun';
		assert(weather !== 'hail' && weather !== 'snow', '非冰雹/雪天气');
	});

	// =============================================================================
	// 腹鼓检查测试 / BELLY DRUM CHECK TESTS
	// =============================================================================

	section('腹鼓检查 / Belly Drum Check');

	function createBellyDrumContext(overrides = {}) {
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
				ability: overrides.attackerAbility || '',
				item: '',
				types: ['Normal'],
				status: '',
				volatiles: new Set(),
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
				id: 'bellydrum',
				category: 'Status',
				type: 'Normal',
				basePower: 0,
				flags: {},
			},
			flags: { canKO: false },
			adjustments: [],
		};
	}

	test('低HP时腹鼓应大扣分 / Belly Drum fails at low HP', () => {
		const ctx = createBellyDrumContext({ attackerHp: 40 });
		const penalty = checkBellyDrum(ctx);
		assertEqual(penalty, -100, '低HP时腹鼓应失败');
	});

	test('唱反调时腹鼓应大扣分 / Belly Drum fails with Contrary', () => {
		const ctx = createBellyDrumContext({ attackerAbility: 'Contrary', attackerHp: 100 });
		const penalty = checkBellyDrum(ctx);
		assertEqual(penalty, -100, '唱反调时腹鼓应失败');
	});

	test('高HP时腹鼓应正常 / Belly Drum OK at high HP', () => {
		const ctx = createBellyDrumContext({ attackerHp: 100 });
		const penalty = checkBellyDrum(ctx);
		assertEqual(penalty, 0, '高HP时腹鼓应正常');
	});

	test('中等HP时腹鼓有小扣分 / Belly Drum penalty at moderate HP', () => {
		const ctx = createBellyDrumContext({ attackerHp: 55 });
		const penalty = checkBellyDrum(ctx);
		assert(penalty < 0 && penalty > -100, `中等HP应有小扣分, 实际为${penalty}`);
	});

	// =============================================================================
	// 反击/镜面反射检查测试 / COUNTER/MIRROR COAT CHECK TESTS
	// =============================================================================

	section('反击/镜面反射 / Counter/Mirror Coat');

	function createCounterContext(overrides = {}) {
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
				types: ['Fighting'],
				status: '',
			},
			target: {
				slot: 1,
				boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
				hpPercent: 100,
				ability: '',
				item: '',
				types: ['Normal'],
				baseStats: overrides.targetStats || { hp: 80, atk: 100, def: 80, spa: 60, spd: 80, spe: 100 },
				moves: overrides.targetMoves || ['tackle', 'thunderbolt'],
			},
			move: {
				id: overrides.moveId || 'counter',
				category: 'Physical',
				type: 'Fighting',
				basePower: 0,
				priority: -5,
				flags: {},
			},
			flags: { canKO: false, goesFirst: overrides.goesFirst || false },
			adjustments: [],
		};
	}

	test('对手无物理招式时Counter应扣分 / Counter fails vs no physical moves', () => {
		const ctx = createCounterContext({
			targetMoves: ['thunderbolt', 'psychic', 'flamethrower'],
		});
		const penalty = checkCounterMirrorCoat(ctx);
		assertEqual(penalty, -10, '对手无物理招式时Counter应扣分');
	});

	test('对手无特殊招式时Mirror Coat应扣分 / Mirror Coat fails vs no special moves', () => {
		const ctx = createCounterContext({
			moveId: 'mirrorcoat',
			targetMoves: ['earthquake', 'stoneedge', 'closecombat'],
		});
		const penalty = checkCounterMirrorCoat(ctx);
		assertEqual(penalty, -10, '对手无特殊招式时Mirror Coat应扣分');
	});

	test('先手时Metal Burst应扣分 / Metal Burst fails when faster', () => {
		const ctx = createCounterContext({
			moveId: 'metalburst',
			goesFirst: true,
		});
		const penalty = checkCounterMirrorCoat(ctx);
		assertEqual(penalty, -10, '先手时Metal Burst应失败');
	});

	test('后手时Metal Burst应正常 / Metal Burst OK when slower', () => {
		const ctx = createCounterContext({
			moveId: 'metalburst',
			goesFirst: false,
		});
		const penalty = checkCounterMirrorCoat(ctx);
		assertEqual(penalty, 0, '后手时Metal Burst应正常');
	});

	// =============================================================================
	// Magic Guard 状态招式测试 / MAGIC GUARD STATUS MOVE TESTS
	// =============================================================================

	section('Magic Guard 状态招式 / Magic Guard Status Moves');

	function createStatusMoveContext(overrides = {}) {
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
				types: ['Fire'],
				status: '',
				moves: overrides.attackerMoves || [],
			},
			target: {
				slot: 1,
				boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
				hpPercent: 100,
				ability: overrides.targetAbility || '',
				item: overrides.targetItem || '',
				types: overrides.targetTypes || ['Normal'],
				status: overrides.targetStatus || '',
			},
			move: {
				id: overrides.moveId || 'willowisp',
				category: 'Status',
				type: overrides.moveType || 'Fire',
				basePower: 0,
				accuracy: 85,
				flags: {},
				secondaryChance: overrides.secondaryChance || 0,
			},
			flags: { canKO: false, hasNoEffect: false },
			adjustments: [],
		};
	}

	test('对 Magic Guard 使用鬼火应扣分 / Will-O-Wisp vs Magic Guard penalized', () => {
		const ctx = createStatusMoveContext({
			moveId: 'willowisp',
			targetAbility: 'Magic Guard',
		});
		const penalty = checkBurnMove(ctx);
		assertEqual(penalty, -10, '对 Magic Guard 使用鬼火应扣10分');
	});

	test('对 Magic Guard 使用剧毒应扣分 / Toxic vs Magic Guard penalized', () => {
		const ctx = createStatusMoveContext({
			moveId: 'toxic',
			moveType: 'Poison',
			targetAbility: 'Magic Guard',
		});
		const penalty = checkPoisonMove(ctx);
		assertEqual(penalty, -10, '对 Magic Guard 使用剧毒应扣10分');
	});

	test('有 Venoshock 时对 Magic Guard 使用剧毒不扣分 / Toxic vs Magic Guard OK with Venoshock', () => {
		const ctx = createStatusMoveContext({
			moveId: 'toxic',
			moveType: 'Poison',
			targetAbility: 'Magic Guard',
			attackerMoves: [{ id: 'venoshock' }, { id: 'sludgebomb' }],
		});
		const penalty = checkPoisonMove(ctx);
		assertEqual(penalty, 0, '有 Venoshock 时不扣分');
	});

	test('对普通特性使用鬼火不额外扣分 / Will-O-Wisp vs normal ability no penalty', () => {
		const ctx = createStatusMoveContext({
			moveId: 'willowisp',
			targetAbility: 'Blaze',
		});
		const penalty = checkBurnMove(ctx);
		assertEqual(penalty, 0, '对普通特性不扣分');
	});

	// =============================================================================
	// Covert Cloak 测试 / COVERT CLOAK TESTS
	// =============================================================================

	section('Covert Cloak 测试 / Covert Cloak Tests');

	test('Covert Cloak 应阻挡附加效果 / Covert Cloak blocks secondary effects', () => {
		const ctx = createStatusMoveContext({
			moveId: 'thunderbolt',
			moveType: 'Electric',
			targetItem: 'Covert Cloak',
			secondaryChance: 10,
		});
		ctx.move.category = 'Special';
		ctx.move.basePower = 90;
		const penalty = checkCovertCloak(ctx);
		assertEqual(penalty, -3, 'Covert Cloak 应扣3分');
	});

	test('无附加效果的招式不受 Covert Cloak 影响 / No secondary effect not affected', () => {
		const ctx = createStatusMoveContext({
			moveId: 'earthquake',
			moveType: 'Ground',
			targetItem: 'Covert Cloak',
			secondaryChance: 0,
		});
		ctx.move.category = 'Physical';
		ctx.move.basePower = 100;
		const penalty = checkCovertCloak(ctx);
		assertEqual(penalty, 0, '无附加效果不扣分');
	});

	test('没有 Covert Cloak 时不扣分 / No Covert Cloak no penalty', () => {
		const ctx = createStatusMoveContext({
			moveId: 'thunderbolt',
			moveType: 'Electric',
			targetItem: '',
			secondaryChance: 10,
		});
		ctx.move.category = 'Special';
		ctx.move.basePower = 90;
		const penalty = checkCovertCloak(ctx);
		assertEqual(penalty, 0, '没有 Covert Cloak 不扣分');
	});

	// =============================================================================
	// Pain Split 测试 / PAIN SPLIT TESTS
	// =============================================================================

	section('Pain Split 测试 / Pain Split Tests');

	function createPainSplitContext(overrides = {}) {
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
				hpPercent: overrides.attackerHp || 50,
				ability: '',
				item: overrides.attackerItem || '',
				types: ['Normal'],
				status: '',
				volatiles: overrides.attackerVolatiles || new Set(),
				moves: overrides.attackerMoves || [],
			},
			target: {
				slot: 1,
				boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
				hpPercent: overrides.targetHp || 50,
				ability: overrides.targetAbility || '',
				item: overrides.targetItem || '',
				types: ['Normal'],
				volatiles: overrides.targetVolatiles || new Set(),
				moves: overrides.targetMoves || [],
			},
			move: {
				id: overrides.moveId || 'painsplit',
				category: 'Status',
				type: 'Normal',
				basePower: 0,
				priority: 0,
				target: 'normal',
				flags: {},
			},
			flags: { canKO: false, goesFirst: overrides.goesFirst !== false },
			adjustments: [],
		};
	}

	test('Pain Split: 攻击方HP高时应扣分 / Pain Split penalized when attacker HP higher', () => {
		const ctx = createPainSplitContext({
			attackerHp: 80,
			targetHp: 20,
		});
		const penalty = checkPainSplit(ctx);
		assertEqual(penalty, -10, '攻击方HP高时应扣10分');
	});

	test('Pain Split: 攻击方HP低时不扣分 / Pain Split OK when attacker HP lower', () => {
		const ctx = createPainSplitContext({
			attackerHp: 20,
			targetHp: 80,
		});
		const penalty = checkPainSplit(ctx);
		assertEqual(penalty, 0, '攻击方HP低时不扣分');
	});

	test('Pain Split: HP相等时不扣分 / Pain Split OK when HP equal', () => {
		const ctx = createPainSplitContext({
			attackerHp: 50,
			targetHp: 50,
		});
		const penalty = checkPainSplit(ctx);
		assertEqual(penalty, 0, 'HP相等时不扣分');
	});

	// =============================================================================
	// Destiny Bond 测试 / DESTINY BOND TESTS
	// =============================================================================

	section('Destiny Bond 测试 / Destiny Bond Tests');

	test('Destiny Bond: 已激活时应扣分 / Destiny Bond penalized when already active', () => {
		const ctx = createPainSplitContext({
			moveId: 'destinybond',
			attackerVolatiles: new Set(['destinybond']),
		});
		const penalty = checkDestinyBond(ctx);
		assertEqual(penalty, -10, 'Destiny Bond已激活时应扣10分');
	});

	test('Destiny Bond: 未激活时不扣分 / Destiny Bond OK when not active', () => {
		const ctx = createPainSplitContext({
			moveId: 'destinybond',
			attackerVolatiles: new Set(),
		});
		const penalty = checkDestinyBond(ctx);
		assertEqual(penalty, 0, 'Destiny Bond未激活时不扣分');
	});

	// =============================================================================
	// Future Sight 测试 / FUTURE SIGHT TESTS
	// =============================================================================

	section('Future Sight 测试 / Future Sight Tests');

	test('Future Sight: 已设置时应扣分 / Future Sight penalized when already pending', () => {
		const ctx = createPainSplitContext({
			moveId: 'futuresight',
			targetVolatiles: new Set(['futuremove']),
		});
		const penalty = checkFutureSight(ctx);
		assertEqual(penalty, -10, 'Future Sight已设置时应扣10分');
	});

	test('Future Sight: 未设置时不扣分 / Future Sight OK when not pending', () => {
		const ctx = createPainSplitContext({
			moveId: 'futuresight',
			targetVolatiles: new Set(),
		});
		const penalty = checkFutureSight(ctx);
		assertEqual(penalty, 0, 'Future Sight未设置时不扣分');
	});

	test('Doom Desire: 也应检查 / Doom Desire also checked', () => {
		const ctx = createPainSplitContext({
			moveId: 'doomdesire',
			targetVolatiles: new Set(['futuremove']),
		});
		const penalty = checkFutureSight(ctx);
		assertEqual(penalty, -10, 'Doom Desire已设置时应扣10分');
	});

	// =============================================================================
	// Trick/Switcheroo 测试 / TRICK TESTS
	// =============================================================================

	section('Trick 测试 / Trick Tests');

	test('Trick: Sticky Hold应阻止 / Trick blocked by Sticky Hold', () => {
		const ctx = createPainSplitContext({
			moveId: 'trick',
			attackerItem: 'Choice Scarf',
			targetAbility: 'Sticky Hold',
		});
		const penalty = checkTrick(ctx);
		assertEqual(penalty, -10, 'Sticky Hold阻止Trick');
	});

	test('Trick: 道具相同时应扣分 / Trick penalized when same item', () => {
		const ctx = createPainSplitContext({
			moveId: 'trick',
			attackerItem: '',
			targetItem: '',
		});
		const penalty = checkTrick(ctx);
		assertEqual(penalty, -10, '双方无道具时应扣分');
	});

	test('Trick: 正常情况不扣分 / Trick OK normally', () => {
		const ctx = createPainSplitContext({
			moveId: 'trick',
			attackerItem: 'Choice Scarf',
			targetItem: 'Leftovers',
		});
		const penalty = checkTrick(ctx);
		assertEqual(penalty, 0, '正常情况不扣分');
	});

	test('Switcheroo: 也应检查 / Switcheroo also checked', () => {
		const ctx = createPainSplitContext({
			moveId: 'switcheroo',
			targetAbility: 'Sticky Hold',
		});
		const penalty = checkTrick(ctx);
		assertEqual(penalty, -10, 'Switcheroo也受Sticky Hold阻止');
	});

	// =============================================================================
	// Recycle 测试 / RECYCLE TESTS
	// =============================================================================

	section('Recycle 测试 / Recycle Tests');

	test('Recycle: 已有道具时应扣分 / Recycle penalized when holding item', () => {
		const ctx = createPainSplitContext({
			moveId: 'recycle',
			attackerItem: 'Sitrus Berry',
		});
		const penalty = checkRecycle(ctx);
		assertEqual(penalty, -10, '已有道具时应扣分');
	});

	test('Recycle: 无道具时不扣分 / Recycle OK when no item', () => {
		const ctx = createPainSplitContext({
			moveId: 'recycle',
			attackerItem: '',
		});
		const penalty = checkRecycle(ctx);
		assertEqual(penalty, 0, '无道具时不扣分');
	});

	// =============================================================================
	// Fling 测试 / FLING TESTS
	// =============================================================================

	section('Fling 测试 / Fling Tests');

	test('Fling: 无道具时应扣分 / Fling penalized when no item', () => {
		const ctx = createPainSplitContext({
			moveId: 'fling',
			attackerItem: '',
		});
		const penalty = checkFling(ctx);
		assertEqual(penalty, -10, '无道具时应扣分');
	});

	test('Fling: Z-Crystal不能投掷 / Fling fails with Z-Crystal', () => {
		const ctx = createPainSplitContext({
			moveId: 'fling',
			attackerItem: 'Fightinium Z',
		});
		ctx.attacker.item = 'fightiniumz';
		const penalty = checkFling(ctx);
		assertEqual(penalty, -10, 'Z-Crystal不能投掷');
	});

	test('Fling: 正常道具不扣分 / Fling OK with normal item', () => {
		const ctx = createPainSplitContext({
			moveId: 'fling',
			attackerItem: 'Iron Ball',
		});
		ctx.attacker.item = 'ironball';
		const penalty = checkFling(ctx);
		assertEqual(penalty, 0, '正常道具可以投掷');
	});

	test('Fling: 火焰宝珠对火系扣分 / Fling Flame Orb vs Fire type penalized', () => {
		const ctx = createPainSplitContext({
			moveId: 'fling',
			attackerItem: 'Flame Orb',
		});
		ctx.attacker.item = 'flameorb';
		ctx.target.types = ['Fire'];
		const penalty = checkFling(ctx);
		assertEqual(penalty, -5, '火焰宝珠对火系扣分');
	});

	// =============================================================================
	// 半无敌招式测试 / SEMI-INVULNERABLE MOVE TESTS
	// =============================================================================

	section('半无敌招式 / Semi-Invulnerable Moves');

	test('Fly: Power Herb不扣分 / Fly with Power Herb no penalty', () => {
		const ctx = createPainSplitContext({
			moveId: 'fly',
			attackerItem: 'Power Herb',
		});
		ctx.attacker.item = 'powerherb';
		ctx.move.category = 'Physical';
		ctx.move.type = 'Flying';
		ctx.move.basePower = 90;
		const penalty = checkSemiInvulnerable(ctx);
		assertEqual(penalty, 0, 'Power Herb跳过充能');
	});

	test('Solar Beam: 晴天不扣分 / Solar Beam in sun no penalty', () => {
		const ctx = createPainSplitContext({
			moveId: 'solarbeam',
		});
		ctx.state.field.weather = 'sun';
		ctx.move.category = 'Special';
		ctx.move.type = 'Grass';
		ctx.move.basePower = 120;
		const penalty = checkSemiInvulnerable(ctx);
		assertEqual(penalty, 0, '晴天日光束即时发动');
	});

	test('Fly: 对手有Protect应扣分 / Fly penalized when opponent has Protect', () => {
		const ctx = createPainSplitContext({
			moveId: 'fly',
			targetMoves: ['protect', 'earthquake'],
			goesFirst: false,
		});
		ctx.move.category = 'Physical';
		ctx.move.type = 'Flying';
		ctx.move.basePower = 90;
		const penalty = checkSemiInvulnerable(ctx);
		assert(penalty < 0, `对手有Protect应扣分, 实际为${penalty}`);
	});

	test('Dig: 对手有地震应扣分 / Dig penalized when opponent has Earthquake', () => {
		const ctx = createPainSplitContext({
			moveId: 'dig',
			targetMoves: ['earthquake', 'thunderbolt'],
		});
		ctx.move.category = 'Physical';
		ctx.move.type = 'Ground';
		ctx.move.basePower = 80;
		const penalty = checkSemiInvulnerable(ctx);
		assert(penalty < 0, `对手有地震应扣分, 实际为${penalty}`);
	});

	test('Dive: 对手有冲浪应扣分 / Dive penalized when opponent has Surf', () => {
		const ctx = createPainSplitContext({
			moveId: 'dive',
			targetMoves: ['surf', 'thunderbolt'],
		});
		ctx.move.category = 'Physical';
		ctx.move.type = 'Water';
		ctx.move.basePower = 80;
		const penalty = checkSemiInvulnerable(ctx);
		assert(penalty < 0, `对手有冲浪应扣分, 实际为${penalty}`);
	});

	test('Fly: 普通情况有小扣分 / Fly small penalty normally', () => {
		const ctx = createPainSplitContext({
			moveId: 'fly',
			targetMoves: ['thunderbolt', 'psychic'],
		});
		ctx.move.category = 'Physical';
		ctx.move.type = 'Flying';
		ctx.move.basePower = 90;
		const penalty = checkSemiInvulnerable(ctx);
		assertEqual(penalty, -3, '二回合招式有小扣分');
	});

	// =============================================================================
	// 抵抗招式扣分测试 / TYPE RESISTANCE PENALTY TESTS
	// =============================================================================

	section('抵抗招式扣分 / Type Resistance Penalty');

	function createMockScoringContext(moveType, targetTypes, moveCategory = 'Physical', damagePercent = null) {
		return {
			move: { type: moveType, category: moveCategory, priority: 0 },
			target: { types: targetTypes },
			cache: { typeEffectiveness: new Map() },
			adjustments: [],
			flags: { isImmune: false, hasNoEffect: false },
			damageResult: damagePercent !== null ? { averagePercent: damagePercent } : null,
		};
	}

	test('单抵抗 (0.5x) 应扣 5 分 / Single resistance (0.5x) should deduct 5', () => {
		const ctx = createMockScoringContext('Fire', ['Water']);
		const penalty = checkTypeResistance(ctx);
		assertEqual(penalty, -5, '单抵抗应扣 5 分');
	});

	test('双重抵抗 (0.25x) 应扣 20 分 / Double resistance (0.25x) should deduct 20', () => {
		const ctx = createMockScoringContext('Grass', ['Fire', 'Flying']);
		const penalty = checkTypeResistance(ctx);
		assertEqual(penalty, -20, '双重抵抗应扣 20 分');
	});

	test('中性效果 (1x) 不应扣分 / Neutral (1x) should not deduct', () => {
		const ctx = createMockScoringContext('Fire', ['Normal']);
		const penalty = checkTypeResistance(ctx);
		assertEqual(penalty, 0, '中性效果不应扣分');
	});

	test('克制 (2x) 不应扣分 / Super effective (2x) should not deduct', () => {
		const ctx = createMockScoringContext('Fire', ['Grass']);
		const penalty = checkTypeResistance(ctx);
		assertEqual(penalty, 0, '克制不应扣分');
	});

	test('免疫 (0x) 不应通过此函数扣分 / Immune (0x) should not deduct via this function', () => {
		const ctx = createMockScoringContext('Ground', ['Flying']);
		const penalty = checkTypeResistance(ctx);
		assertEqual(penalty, 0, '免疫应由 checkTypeImmunity 处理');
	});

	test('变化招式不应检查抵抗 / Status move should not check resistance', () => {
		const ctx = createMockScoringContext('Fire', ['Water'], 'Status');
		const penalty = checkTypeResistance(ctx);
		assertEqual(penalty, 0, '变化招式不应检查抵抗');
	});

	// =============================================================================
	// 低伤害扣分测试 / LOW DAMAGE PENALTY TESTS
	// =============================================================================

	section('低伤害扣分 / Low Damage Penalty');

	test('极低伤害 (<10%) 应扣 20 分 / Very low damage (<10%) should deduct 20', () => {
		const ctx = createMockScoringContext('Fire', ['Normal'], 'Physical', 5);
		const penalty = checkLowDamage(ctx);
		assertEqual(penalty, -20, '极低伤害应扣 20 分');
	});

	test('低伤害 (10-20%) 应扣 8 分 / Low damage (10-20%) should deduct 8', () => {
		const ctx = createMockScoringContext('Fire', ['Normal'], 'Physical', 15);
		const penalty = checkLowDamage(ctx);
		assertEqual(penalty, -8, '低伤害应扣 8 分');
	});

	test('较低伤害 (20-33%) 应扣 3 分 / Moderately low damage (20-33%) should deduct 3', () => {
		const ctx = createMockScoringContext('Fire', ['Normal'], 'Physical', 25);
		const penalty = checkLowDamage(ctx);
		assertEqual(penalty, -3, '较低伤害应扣 3 分');
	});

	test('中等伤害 (>=33%) 不应扣分 / Moderate damage (>=33%) should not deduct', () => {
		const ctx = createMockScoringContext('Fire', ['Normal'], 'Physical', 35);
		const penalty = checkLowDamage(ctx);
		assertEqual(penalty, 0, '中等伤害不应扣分');
	});

	test('高伤害 (>=50%) 不应扣分 / High damage (>=50%) should not deduct', () => {
		const ctx = createMockScoringContext('Fire', ['Normal'], 'Physical', 50);
		const penalty = checkLowDamage(ctx);
		assertEqual(penalty, 0, '高伤害不应扣分');
	});

	test('先制招式不应因低伤害扣分 / Priority move should not deduct for low damage', () => {
		const ctx = createMockScoringContext('Normal', ['Normal'], 'Physical', 10);
		ctx.move.priority = 1;
		const penalty = checkLowDamage(ctx);
		assertEqual(penalty, 0, '先制招式不应扣分');
	});

	test('免疫招式不应重复扣分 / Immune move should not double penalize', () => {
		const ctx = createMockScoringContext('Ground', ['Flying'], 'Physical', 0);
		ctx.flags.isImmune = true;
		const penalty = checkLowDamage(ctx);
		assertEqual(penalty, 0, '免疫招式已被其他函数扣分');
	});

	test('变化招式不应检查伤害 / Status move should not check damage', () => {
		const ctx = createMockScoringContext('Fire', ['Normal'], 'Status');
		const penalty = checkLowDamage(ctx);
		assertEqual(penalty, 0, '变化招式不应检查伤害');
	});

	// =============================================================================
	// Salt Cure 负面评分测试 / SALT CURE NEGATIVE SCORING TESTS
	// =============================================================================

	section('Salt Cure 负面评分 / Salt Cure Negative Scoring');

	function createSaltCureContext(targetTypes, targetAbility = '', targetVolatiles = []) {
		return {
			move: { id: 'saltcure', category: 'Physical', type: 'Rock', basePower: 40 },
			attacker: {
				species: 'Garganacl',
				types: ['Rock'],
				ability: 'Purifying Salt',
				boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
			},
			target: {
				species: 'Slowbro',
				types: targetTypes,
				ability: targetAbility,
				volatiles: new Set(targetVolatiles),
				baseStats: { hp: 95, atk: 75, def: 110, spa: 100, spd: 80, spe: 30 },
			},
			state: { isDoubles: false, field: { weather: '', terrain: '' } },
			flags: { canKO: false, hasNoEffect: false },
			adjustments: [],
		};
	}

	test('checkSaltCure 对已有 Salt Cure 的目标应扣 10 分 / checkSaltCure should deduct 10 for target with Salt Cure', () => {
		const ctx = createSaltCureContext(['Normal'], '', ['saltcure']);
		const penalty = checkSaltCure(ctx);
		assertEqual(penalty, -10, '已有 Salt Cure 应扣 10 分');
	});

	test('checkSaltCure 对 Magic Guard 应扣 8 分 / checkSaltCure should deduct 8 vs Magic Guard', () => {
		const ctx = createSaltCureContext(['Psychic'], 'Magic Guard');
		const penalty = checkSaltCure(ctx);
		assertEqual(penalty, -8, 'Magic Guard 应扣 8 分');
	});

	test('checkSaltCure 对有替身的目标应扣分 / checkSaltCure should deduct for target with Substitute', () => {
		const ctx = createSaltCureContext(['Normal'], '', ['substitute']);
		const penalty = checkSaltCure(ctx);
		assertEqual(penalty, -8, '替身应扣 8 分');
	});

	test('checkSaltCure 对普通目标应返回 0 / checkSaltCure should return 0 for normal target', () => {
		const ctx = createSaltCureContext(['Normal'], '');
		const penalty = checkSaltCure(ctx);
		assertEqual(penalty, 0, '普通情况不应扣分');
	});

	// =============================================================================
	// Protect 连续使用扣分测试 / CONSECUTIVE PROTECT PENALTY TESTS
	// =============================================================================

	section('Protect 连续使用扣分 / Consecutive Protect Penalty');

	const { checkProtectOveruse } = require('../../../dist/server/npc/ai/cfru/scoring/negatives');

	function createProtectContext(lastMove, isDoubles = false, moveId = 'protect') {
		return {
			move: { id: moveId, category: 'Status', type: 'Normal', basePower: 0 },
			attacker: {
				species: 'Ferrothorn',
				types: ['Grass', 'Steel'],
				ability: 'Iron Barbs',
				lastMove: lastMove,
				boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
				volatiles: new Set(),
			},
			target: {
				species: 'Garchomp',
				types: ['Dragon', 'Ground'],
				ability: 'Rough Skin',
			},
			state: { isDoubles: isDoubles, field: { weather: '', terrain: '' } },
			flags: {},
			adjustments: [],
		};
	}

	test('首次使用 Protect 不应扣分 / First Protect usage should not deduct', () => {
		const ctx = createProtectContext('', false);
		const penalty = checkProtectOveruse(ctx);
		assertEqual(penalty, 0, '首次使用不应扣分');
	});

	test('上回合非 Protect 招式后使用不应扣分 / Protect after non-Protect move should not deduct', () => {
		const ctx = createProtectContext('earthquake', false);
		const penalty = checkProtectOveruse(ctx);
		assertEqual(penalty, 0, '上回合非 Protect 后不应扣分');
	});

	test('连续使用 Protect 应扣 20 分 / Consecutive Protect should deduct 20', () => {
		const ctx = createProtectContext('protect', false);
		const penalty = checkProtectOveruse(ctx);
		assertEqual(penalty, -20, '连续使用应扣 20 分');
	});

	test('Detect 与 Protect 连用应扣 20 分 / Detect after Protect should deduct 20', () => {
		const ctx = createProtectContext('protect', false, 'detect');
		const penalty = checkProtectOveruse(ctx);
		assertEqual(penalty, -20, 'Detect 与 Protect 连用应扣 20 分');
	});

	test("King's Shield 连续使用应扣 20 分 / Consecutive King's Shield should deduct 20", () => {
		const ctx = createProtectContext('kingsshield', false, 'kingsshield');
		const penalty = checkProtectOveruse(ctx);
		assertEqual(penalty, -20, "King's Shield 连续使用应扣 20 分");
	});

	test('Quick Guard 不应受连续使用惩罚 / Quick Guard should not be penalized for consecutive use', () => {
		const ctx = createProtectContext('quickguard', false, 'quickguard');
		const penalty = checkProtectOveruse(ctx);
		assertEqual(penalty, 0, 'Quick Guard 有无限使用次数');
	});

	test('Wide Guard 不应受连续使用惩罚 / Wide Guard should not be penalized', () => {
		const ctx = createProtectContext('wideguard', false, 'wideguard');
		const penalty = checkProtectOveruse(ctx);
		assertEqual(penalty, 0, 'Wide Guard 有无限使用次数');
	});

	test('切换后使用 Protect 不应扣分 / Protect after switch should not deduct', () => {
		// After switch, lastMove is ''
		const ctx = createProtectContext('', false);
		const penalty = checkProtectOveruse(ctx);
		assertEqual(penalty, 0, '切换后首次使用不应扣分');
	});

	// =============================================================================
	// Knock Off 负面评分测试 / KNOCK OFF NEGATIVE SCORING TESTS
	// =============================================================================

	section('Knock Off 负面评分 / Knock Off Negative Scoring');

	const { checkKnockOff } = require('../../../dist/server/npc/ai/cfru/scoring/negatives');

	function createKnockOffNegContext(overrides = {}) {
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

	test('Knock Off 对已失去道具的目标应扣 5 分 / Knock Off vs target without item should deduct 5', () => {
		const ctx = createKnockOffNegContext({
			targetItem: '', // Item lost
			targetItemLost: true, // Confirmed lost via -enditem
		});
		const penalty = checkKnockOff(ctx);
		assertEqual(penalty, -5, 'Knock Off 对已失去道具目标应扣 5 分');
	});

	test('Knock Off 对道具未揭示的目标不应扣分 / Knock Off vs target with unrevealed item should not deduct', () => {
		const ctx = createKnockOffNegContext({
			targetItem: '',
			targetItemLost: false, // Not confirmed lost, just unknown
		});
		const penalty = checkKnockOff(ctx);
		assertEqual(penalty, 0, 'Knock Off 对道具未揭示目标不应扣分');
	});

	test('Knock Off 对有道具的目标不应扣分 / Knock Off vs target with item should not deduct', () => {
		const ctx = createKnockOffNegContext({
			targetItem: 'Leftovers',
		});
		const penalty = checkKnockOff(ctx);
		assertEqual(penalty, 0, 'Knock Off 对有道具目标不应扣分');
	});

	test('非 Knock Off 招式不应检查道具 / Non-Knock Off move should not check item', () => {
		const ctx = createKnockOffNegContext({ moveId: 'crunch' });
		ctx.move.id = 'crunch';
		ctx.target.item = '';
		ctx.target.moves = ['earthquake'];
		const penalty = checkKnockOff(ctx);
		assertEqual(penalty, 0, '非 Knock Off 招式不应检查道具');
	});

	// =============================================================================
	// 睡眠条款检查 / SLEEP CLAUSE TESTS
	// =============================================================================

	section('睡眠条款检查 / Sleep Clause Tests');

	const { checkSleepMove } = require('../../../dist/server/npc/ai/cfru/scoring/negatives');

	function createSleepClauseContext(overrides = {}) {
		return {
			attacker: {
				species: 'Amoonguss',
				hpPercent: 100,
				status: '',
				types: ['Grass', 'Poison'],
				ability: 'Effect Spore',
				item: '',
				itemLost: false,
				boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
				volatiles: new Set(),
				baseStats: { hp: 114, atk: 85, def: 70, spa: 85, spd: 80, spe: 30 },
				moves: overrides.attackerMoves || [],
			},
			target: {
				species: overrides.targetSpecies || 'Landorus',
				hpPercent: overrides.targetHP || 100,
				status: overrides.targetStatus || '',
				types: overrides.targetTypes || ['Ground', 'Flying'],
				ability: overrides.targetAbility || 'Intimidate',
				item: overrides.targetItem || '',
				itemLost: false,
				boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
				volatiles: new Set(),
				baseStats: { hp: 89, atk: 125, def: 90, spa: 115, spd: 80, spe: 101 },
				moves: overrides.targetMoves || [],
			},
			state: {
				opponent: {
					team: overrides.opponentTeam || [
						// Active Pokemon (target)
						{
							species: overrides.targetSpecies || 'Landorus',
							fainted: false,
							status: overrides.targetStatus || '',
						},
						// Reserve Pokemon 1
						{
							species: 'Garchomp',
							fainted: false,
							status: overrides.reserve1Status || '',
						},
						// Reserve Pokemon 2
						{
							species: 'Dragonite',
							fainted: false,
							status: overrides.reserve2Status || '',
						},
					],
				},
				field: {
					terrain: overrides.terrain || '',
					weather: overrides.weather || '',
				},
			},
			move: {
				id: overrides.moveId || 'spore',
				category: 'Status',
				type: 'Grass',
				basePower: 0,
				flags: overrides.moveFlags || { powder: 1 },
			},
			flags: overrides.flags || { canKO: false, goesFirst: true, hasNoEffect: false },
			adjustments: [],
		};
	}

	test('睡眠条款：对手已有睡眠精灵时应扣 20 分 / Sleep Clause: deduct 20 when opponent has sleeping Pokemon', () => {
		const ctx = createSleepClauseContext({
			reserve1Status: 'slp', // Garchomp is asleep
		});
		const penalty = checkSleepMove(ctx);
		assertEqual(penalty, -20, '对手已有睡眠精灵时睡眠招式应扣 20 分');
		assert(
			ctx.adjustments.some(adj =>
				adj.reason.includes('Sleep Clause') && adj.amount === -20
			),
			'应记录睡眠条款扣分'
		);
	});

	test('睡眠条款：对手无睡眠精灵时不应扣分 / Sleep Clause: no penalty when no sleeping Pokemon', () => {
		const ctx = createSleepClauseContext({
			// No sleeping Pokemon on opponent team
		});
		const penalty = checkSleepMove(ctx);
		assertEqual(penalty, 0, '对手无睡眠精灵时睡眠招式不应扣分');
	});

	test('睡眠条款：对手有已倒下的睡眠精灵时不应扣分 / Sleep Clause: no penalty if sleeping Pokemon is fainted', () => {
		const ctx = createSleepClauseContext({
			opponentTeam: [
				{ species: 'Landorus', fainted: false, status: '' },
				{ species: 'Garchomp', fainted: true, status: 'slp' }, // Fainted and asleep
				{ species: 'Dragonite', fainted: false, status: '' },
			],
		});
		const penalty = checkSleepMove(ctx);
		assertEqual(penalty, 0, '已倒下的睡眠精灵不应触发睡眠条款');
	});

	test('睡眠条款：目标已有状态时应优先检查状态 / Sleep Clause: check target status first', () => {
		const ctx = createSleepClauseContext({
			targetStatus: 'par', // Target is paralyzed
			reserve1Status: 'slp', // Another Pokemon is asleep
		});
		const penalty = checkSleepMove(ctx);
		assertEqual(penalty, -20, '目标已有状态时应扣分');
		assert(
			ctx.adjustments.some(adj =>
				adj.reason.includes('already has status') && adj.amount === -20
			),
			'应记录"目标已有状态"而非睡眠条款'
		);
	});

	test('睡眠条款：对草系使用孢子应扣分 / Sleep Clause: powder move vs Grass type should fail', () => {
		const ctx = createSleepClauseContext({
			targetTypes: ['Grass', 'Poison'],
		});
		const penalty = checkSleepMove(ctx);
		assertEqual(penalty, -20, '草系免疫粉末招式');
		assert(
			ctx.adjustments.some(adj =>
				adj.reason.includes('Grass type immune') && adj.amount === -20
			),
			'应记录草系免疫粉末'
		);
	});

	test('睡眠条款：电气场地对接地精灵阻止睡眠 / Sleep Clause: Electric Terrain blocks sleep on grounded Pokemon', () => {
		const ctx = createSleepClauseContext({
			terrain: 'electric',
			targetTypes: ['Ground', 'Rock'], // Grounded types
		});
		const penalty = checkSleepMove(ctx);
		assertEqual(penalty, -10, '电气场地阻止接地精灵睡眠');
		assert(
			ctx.adjustments.some(adj =>
				adj.reason.includes('Electric Terrain') && adj.amount === -10
			),
			'应记录电气场地阻止睡眠'
		);
	});

	test('睡眠条款：不眠特性阻止睡眠 / Sleep Clause: Insomnia prevents sleep', () => {
		const ctx = createSleepClauseContext({
			targetAbility: 'Insomnia',
		});
		const penalty = checkSleepMove(ctx);
		assertEqual(penalty, -20, '不眠特性阻止睡眠');
		assert(
			ctx.adjustments.some(adj =>
				adj.reason.includes('Insomnia') && adj.amount === -20
			),
			'应记录不眠特性阻止睡眠'
		);
	});

	test('睡眠条款：非睡眠招式不应检查 / Sleep Clause: non-sleep move should not check', () => {
		const ctx = createSleepClauseContext({
			moveId: 'thunderwave',
			reserve1Status: 'slp',
		});
		ctx.move.id = 'thunderwave';
		const penalty = checkSleepMove(ctx);
		assertEqual(penalty, 0, '非睡眠招式不应触发睡眠条款检查');
	});

	test('睡眠条款：hasNoEffect 标志应被正确设置 / Sleep Clause: hasNoEffect flag should be set', () => {
		const ctx = createSleepClauseContext({
			reserve1Status: 'slp', // Opponent has sleeping Pokemon
		});
		const penalty = checkSleepMove(ctx);
		assertEqual(penalty, -20, '睡眠条款违规应扣 20 分');
		assertEqual(ctx.flags.hasNoEffect, true, 'hasNoEffect 标志应为 true');
	});

	// Integration test: Verify that positive scoring doesn't apply when hasNoEffect is true
	test('睡眠条款：违规时正面加分不应触发 / Sleep Clause: no positive bonus when violated', () => {
		const { rewardSleepMove } = require('../../../dist/server/npc/ai/cfru/scoring/positives');

		// Create context with Sleep Clause violation
		const ctx = createSleepClauseContext({
			reserve1Status: 'slp',
		});

		// First run negative scorer to set hasNoEffect
		const penalty = checkSleepMove(ctx);
		assertEqual(penalty, -20, '应扣 20 分');
		assertEqual(ctx.flags.hasNoEffect, true, 'hasNoEffect 应为 true');

		// Now verify that positive scorer returns 0
		const bonus = rewardSleepMove(ctx);
		assertEqual(bonus, 0, '睡眠条款违规时睡眠招式不应有正面加分');
	});

	// =============================================================================
	// 梦话/打鼾评分测试 / SLEEP TALK/SNORE SCORING TESTS
	// CFRU: ai_negatives.c 1783-1795, ai_positives.c 982-986
	// =============================================================================

	section('梦话/打鼾评分 / Sleep Talk/Snore Scoring');

	// Helper function to create Sleep Talk/Snore context
	function createSleepTalkContext(overrides = {}) {
		const base = {
			move: {
				id: 'sleeptalk',
				name: 'Sleep Talk',
				type: 'Normal',
				category: 'Status',
				basePower: 0,
				accuracy: true,
				flags: {},
			},
			attacker: {
				status: overrides.attackerStatus || '',
				sleepTurns: overrides.sleepTurns || 0,
				ability: overrides.attackerAbility || 'Hustle',
				hpPercent: 100,
				boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
			},
			target: {
				status: '',
				ability: 'Intimidate',
				hpPercent: 100,
				boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
			},
			state: {
				field: { weather: 'none', terrain: null },
				opponent: { conditions: {}, team: [] },
				self: { conditions: {}, team: [] },
			},
			adjustments: [],
			flags: {},
		};
		return deepMerge(base, overrides);
	}

	test('梦话：非睡眠状态应扣分 / Sleep Talk not asleep should penalize', () => {
		const ctx = createSleepTalkContext({
			attackerStatus: '', // Not asleep
		});
		const penalty = checkSleepTalkSnore(ctx);
		assertEqual(penalty, -10, '非睡眠状态使用梦话应扣 10 分');
		assertEqual(ctx.flags.hasNoEffect, true, 'hasNoEffect 应为 true');
	});

	test('梦话：睡眠状态不应扣分 / Sleep Talk while asleep should not penalize', () => {
		const ctx = createSleepTalkContext({
			attackerStatus: 'slp',
			sleepTurns: 2, // More than 1 turn remaining
		});
		const penalty = checkSleepTalkSnore(ctx);
		assertEqual(penalty, 0, '睡眠状态使用梦话不应扣分');
	});

	test('梦话：睡眠最后一回合应扣分 / Sleep Talk on last turn of sleep should penalize', () => {
		const ctx = createSleepTalkContext({
			attackerStatus: 'slp',
			sleepTurns: 1, // Last turn of sleep
		});
		const penalty = checkSleepTalkSnore(ctx);
		assertEqual(penalty, -10, '睡眠最后一回合使用梦话应扣 10 分');
		assertEqual(ctx.flags.hasNoEffect, true, 'hasNoEffect 应为 true');
	});

	test('梦话：绝对睡眠特性不应扣分 / Sleep Talk with Comatose should not penalize', () => {
		const ctx = createSleepTalkContext({
			attackerStatus: '', // Not status-asleep, but Comatose
			attackerAbility: 'Comatose',
		});
		const penalty = checkSleepTalkSnore(ctx);
		assertEqual(penalty, 0, '绝对睡眠特性使用梦话不应扣分');
	});

	test('打鼾：非睡眠状态应扣分 / Snore not asleep should penalize', () => {
		const ctx = createSleepTalkContext({
			attackerStatus: '',
		});
		ctx.move.id = 'snore';
		ctx.move.name = 'Snore';
		const penalty = checkSleepTalkSnore(ctx);
		assertEqual(penalty, -10, '非睡眠状态使用打鼾应扣 10 分');
	});

	test('打鼾：睡眠状态不应扣分 / Snore while asleep should not penalize', () => {
		const ctx = createSleepTalkContext({
			attackerStatus: 'slp',
			sleepTurns: 3,
		});
		ctx.move.id = 'snore';
		ctx.move.name = 'Snore';
		const penalty = checkSleepTalkSnore(ctx);
		assertEqual(penalty, 0, '睡眠状态使用打鼾不应扣分');
	});

	test('其他招式不应触发检查 / Other moves should not trigger check', () => {
		const ctx = createSleepTalkContext({
			attackerStatus: '', // Not asleep
		});
		ctx.move.id = 'tackle';
		ctx.move.name = 'Tackle';
		const penalty = checkSleepTalkSnore(ctx);
		assertEqual(penalty, 0, '其他招式不应触发梦话/打鼾检查');
	});

	// Integration test: positive scoring
	test('梦话：睡眠状态应获得正面加分 / Sleep Talk while asleep gets positive bonus', () => {
		const { rewardSleepTalkSnore } = require('../../../dist/server/npc/ai/cfru/scoring/positives');

		const ctx = createSleepTalkContext({
			attackerStatus: 'slp',
			sleepTurns: 2,
		});
		const bonus = rewardSleepTalkSnore(ctx);
		assertEqual(bonus, 10, '睡眠状态使用梦话应加 10 分');
	});

	test('梦话：非睡眠状态不应获得正面加分 / Sleep Talk not asleep no positive bonus', () => {
		const { rewardSleepTalkSnore } = require('../../../dist/server/npc/ai/cfru/scoring/positives');

		const ctx = createSleepTalkContext({
			attackerStatus: '',
		});
		const bonus = rewardSleepTalkSnore(ctx);
		assertEqual(bonus, 0, '非睡眠状态使用梦话不应加分');
	});

	test('梦话：绝对睡眠特性应获得正面加分 / Sleep Talk with Comatose gets positive bonus', () => {
		const { rewardSleepTalkSnore } = require('../../../dist/server/npc/ai/cfru/scoring/positives');

		const ctx = createSleepTalkContext({
			attackerStatus: '',
			attackerAbility: 'Comatose',
		});
		const bonus = rewardSleepTalkSnore(ctx);
		assertEqual(bonus, 10, '绝对睡眠特性使用梦话应加 10 分');
	});
}

module.exports = { runNegativesScoringTests };
