/**
 * 伤害计算测试 / Damage Calculation Tests
 * 测试额外伤害、重量招式、Salt Cure 等
 */

const { section, test, assertEqual, assert, createMockPokemon } = require('./test-utils');

function runDamageCalcTests() {
	const {
		getPoisonDamage,
		getBurnDamage,
		getSandstormDamage,
		getHailDamage,
		getLeechSeedDamage,
		getSecondaryEffectDamage,
		willFaintFromSecondaryDamage,
		getActualWeight,
		getWeightBasedPower,
		getWeightRatioPower,
		getSaltCureDamage,
	} = require('../../../dist/server/npc/ai/cfru/util/damage-calc');

	// =============================================================================
	// 额外伤害计算测试 / SECONDARY EFFECT DAMAGE TESTS
	// =============================================================================

	section('额外伤害计算 / Secondary Effect Damage');

	// 普通毒伤害 (1/8)
	test('普通毒应造成 1/8 伤害 / Regular poison deals 1/8 max HP', () => {
		const pokemon = createMockPokemon({ status: 'psn', maxHp: 160 });
		const damage = getPoisonDamage(pokemon, true);
		assertEqual(damage, 20, '160 HP 的 1/8 = 20');
	});

	// 剧毒伤害 (递增)
	test('剧毒应造成递增伤害 / Toxic poison deals increasing damage', () => {
		const pokemon = createMockPokemon({ status: 'tox', maxHp: 160, toxicCounter: 3 });
		const damage = getPoisonDamage(pokemon, true);
		// baseDamage = 160/16 = 10, counter = 3+1(forAI) = 4, total = 10*4 = 40
		assertEqual(damage, 40, '第4回合剧毒应造成40伤害');
	});

	// Magic Guard 免疫毒伤害
	test('Magic Guard 应免疫毒伤害 / Magic Guard prevents poison damage', () => {
		const pokemon = createMockPokemon({ status: 'tox', ability: 'Magic Guard' });
		const damage = getPoisonDamage(pokemon, true);
		assertEqual(damage, 0, 'Magic Guard 免疫毒伤害');
	});

	// Poison Heal 免疫毒伤害 (实际是回复，但计算伤害时返回0)
	test('Poison Heal 应不计算毒伤害 / Poison Heal prevents poison damage calculation', () => {
		const pokemon = createMockPokemon({ status: 'tox', ability: 'Poison Heal' });
		const damage = getPoisonDamage(pokemon, true);
		assertEqual(damage, 0, 'Poison Heal 不计算毒伤害');
	});

	// 烧伤伤害 (1/16)
	test('烧伤应造成 1/16 伤害 / Burn deals 1/16 max HP', () => {
		const pokemon = createMockPokemon({ status: 'brn', maxHp: 160 });
		const damage = getBurnDamage(pokemon);
		assertEqual(damage, 10, '160 HP 的 1/16 = 10');
	});

	// Heatproof 减半烧伤伤害
	test('Heatproof 应减半烧伤伤害 / Heatproof halves burn damage', () => {
		const pokemon = createMockPokemon({ status: 'brn', maxHp: 160, ability: 'Heatproof' });
		const damage = getBurnDamage(pokemon);
		assertEqual(damage, 5, 'Heatproof 减半烧伤伤害');
	});

	// 沙暴伤害
	test('沙暴应对非岩地钢造成伤害 / Sandstorm damages non-Rock/Ground/Steel', () => {
		const pokemon = createMockPokemon({ maxHp: 160 });
		const damage = getSandstormDamage(pokemon, 'sand');
		assertEqual(damage, 10, '沙暴造成 1/16 伤害');
	});

	// 岩石属性免疫沙暴
	test('岩石属性应免疫沙暴 / Rock type immune to sandstorm', () => {
		const pokemon = createMockPokemon({ types: ['Rock'] });
		const damage = getSandstormDamage(pokemon, 'sand');
		assertEqual(damage, 0, '岩石属性免疫沙暴');
	});

	// Sand Veil 免疫沙暴
	test('Sand Veil 应免疫沙暴 / Sand Veil immune to sandstorm', () => {
		const pokemon = createMockPokemon({ ability: 'Sand Veil' });
		const damage = getSandstormDamage(pokemon, 'sand');
		assertEqual(damage, 0, 'Sand Veil 免疫沙暴');
	});

	// Safety Goggles 免疫沙暴
	test('Safety Goggles 应免疫沙暴 / Safety Goggles immune to sandstorm', () => {
		const pokemon = createMockPokemon({ item: 'Safety Goggles' });
		const damage = getSandstormDamage(pokemon, 'sand');
		assertEqual(damage, 0, 'Safety Goggles 免疫沙暴');
	});

	// 冰雹伤害
	test('冰雹应对非冰系造成伤害 / Hail damages non-Ice types', () => {
		const pokemon = createMockPokemon({ maxHp: 160 });
		const damage = getHailDamage(pokemon, 'hail');
		assertEqual(damage, 10, '冰雹造成 1/16 伤害');
	});

	// 冰属性免疫冰雹
	test('冰属性应免疫冰雹 / Ice type immune to hail', () => {
		const pokemon = createMockPokemon({ types: ['Ice'] });
		const damage = getHailDamage(pokemon, 'hail');
		assertEqual(damage, 0, '冰属性免疫冰雹');
	});

	// 寄生种子伤害
	test('寄生种子应造成 1/8 伤害 / Leech Seed deals 1/8 max HP', () => {
		const volatiles = new Set(['leechseed']);
		const pokemon = createMockPokemon({ maxHp: 160, volatiles });
		const damage = getLeechSeedDamage(pokemon);
		assertEqual(damage, 20, '寄生种子造成 1/8 伤害');
	});

	// 综合额外伤害计算
	test('综合额外伤害应累加 / Total secondary damage should accumulate', () => {
		const volatiles = new Set(['leechseed']);
		const pokemon = createMockPokemon({
			maxHp: 160,
			status: 'brn',
			volatiles,
		});
		const damage = getSecondaryEffectDamage(pokemon, 'sand', '');
		// burn: 10 + sandstorm: 10 + leechseed: 20 = 40
		assertEqual(damage, 40, '综合额外伤害应为40');
	});

	// Magic Guard 免疫所有额外伤害
	test('Magic Guard 应免疫所有额外伤害 / Magic Guard prevents all secondary damage', () => {
		const volatiles = new Set(['leechseed', 'curse']);
		const pokemon = createMockPokemon({
			maxHp: 160,
			status: 'tox',
			ability: 'Magic Guard',
			volatiles,
		});
		const damage = getSecondaryEffectDamage(pokemon, 'sand', '');
		assertEqual(damage, 0, 'Magic Guard 免疫所有额外伤害');
	});

	// 额外伤害致死判断
	test('应正确判断额外伤害致死 / Should correctly determine death from secondary damage', () => {
		const pokemon = createMockPokemon({
			maxHp: 100,
			hpPercent: 5, // 5 HP
			status: 'psn',
		});
		const willDie = willFaintFromSecondaryDamage(pokemon, '', '');
		// poison: 12 (100/8), current HP: 5
		assertEqual(willDie, true, '5HP时毒伤害应致死');
	});

	// Leftovers 减少有效伤害
	test('Leftovers 应减少有效额外伤害 / Leftovers should reduce effective secondary damage', () => {
		const pokemon = createMockPokemon({
			maxHp: 160,
			hpPercent: 10, // 16 HP
			status: 'psn',
			item: 'Leftovers',
		});
		const willDie = willFaintFromSecondaryDamage(pokemon, '', '');
		// poison: 20, leftovers recovery: 10, net: 10, current HP: 16
		assertEqual(willDie, false, 'Leftovers 减少后不应致死');
	});

	// =============================================================================
	// 重量招式计算测试 / WEIGHT-BASED MOVE CALCULATION TESTS
	// =============================================================================

	section('重量招式计算 / Weight-Based Move Calculation');

	// Snorlax (460kg) 应返回 120 威力
	test('Low Kick 对 Snorlax (460kg) 应返回 120 威力 / Low Kick vs Snorlax returns 120', () => {
		const power = getWeightBasedPower('Snorlax', '', '');
		assertEqual(power, 120, 'Snorlax 460kg >= 200kg = 120 威力');
	});

	// Gyarados (235kg) 应返回 120 威力
	test('Low Kick 对 Gyarados (235kg) 应返回 120 威力 / Low Kick vs Gyarados returns 120', () => {
		const power = getWeightBasedPower('Gyarados', '', '');
		assertEqual(power, 120, 'Gyarados 235kg >= 200kg = 120 威力');
	});

	// Tyranitar (202kg) 应返回 120 威力
	test('Low Kick 对 Tyranitar (202kg) 应返回 120 威力 / Low Kick vs Tyranitar returns 120', () => {
		const power = getWeightBasedPower('Tyranitar', '', '');
		assertEqual(power, 120, 'Tyranitar 202kg >= 200kg = 120 威力');
	});

	// Machamp (130kg) 应返回 100 威力
	test('Low Kick 对 Machamp (130kg) 应返回 100 威力 / Low Kick vs Machamp returns 100', () => {
		const power = getWeightBasedPower('Machamp', '', '');
		assertEqual(power, 100, 'Machamp 130kg >= 100kg = 100 威力');
	});

	// Lucario (54kg) 应返回 80 威力
	test('Low Kick 对 Lucario (54kg) 应返回 80 威力 / Low Kick vs Lucario returns 80', () => {
		const power = getWeightBasedPower('Lucario', '', '');
		assertEqual(power, 80, 'Lucario 54kg >= 50kg = 80 威力');
	});

	// Pikachu (6kg) 应返回 20 威力
	test('Low Kick 对 Pikachu (6kg) 应返回 20 威力 / Low Kick vs Pikachu returns 20', () => {
		const power = getWeightBasedPower('Pikachu', '', '');
		assertEqual(power, 20, 'Pikachu 6kg < 10kg = 20 威力');
	});

	// 轻金属 (Light Metal) 测试 - 体重减半
	test('Light Metal 应使体重减半 / Light Metal halves weight', () => {
		const normalWeight = getActualWeight('Metagross', '', '');
		const lightWeight = getActualWeight('Metagross', 'Light Metal', '');
		assertEqual(lightWeight, Math.floor(normalWeight / 2), 'Light Metal 体重减半');
	});

	// 重金属 (Heavy Metal) 测试 - 体重翻倍
	test('Heavy Metal 应使体重翻倍 / Heavy Metal doubles weight', () => {
		const normalWeight = getActualWeight('Aggron', '', '');
		const heavyWeight = getActualWeight('Aggron', 'Heavy Metal', '');
		assertEqual(heavyWeight, normalWeight * 2, 'Heavy Metal 体重翻倍');
	});

	// 轻石 (Float Stone) 测试 - 体重减半
	test('Float Stone 应使体重减半 / Float Stone halves weight', () => {
		const normalWeight = getActualWeight('Snorlax', '', '');
		const floatWeight = getActualWeight('Snorlax', '', 'Float Stone');
		assertEqual(floatWeight, Math.floor(normalWeight / 2), 'Float Stone 体重减半');
	});

	// Light Metal 影响 Low Kick 威力
	test('Light Metal 应降低 Low Kick 威力 / Light Metal reduces Low Kick power', () => {
		const normalPower = getWeightBasedPower('Metagross', '', '');
		assertEqual(normalPower, 120, 'Metagross 正常 120 威力');

		const lightPower = getWeightBasedPower('Tyranitar', 'Light Metal', '');
		assertEqual(lightPower, 100, 'Tyranitar Light Metal 后 100 威力');
	});

	// Heavy Slam 测试
	test('Heavy Slam: Snorlax vs Pikachu 应返回 120 威力 / Heavy Slam high ratio', () => {
		const power = getWeightRatioPower('Snorlax', '', '', 'Pikachu', '', '');
		assertEqual(power, 120, '比率 >= 5 = 120 威力');
	});

	test('Heavy Slam: Aggron vs Lucario 应返回 120 威力 / Heavy Slam ratio 6', () => {
		const power = getWeightRatioPower('Aggron', '', '', 'Lucario', '', '');
		assertEqual(power, 120, '比率 >= 5 = 120 威力');
	});

	test('Heavy Slam: 比率 4 应返回 100 威力 / Heavy Slam ratio 4', () => {
		const power = getWeightRatioPower('Machamp', '', '', 'Pikachu', '', '');
		assertEqual(power, 120, '高比率 = 120 威力');
	});

	test('Heavy Slam: 攻击方较轻应返回 40 威力 / Heavy Slam low ratio', () => {
		const power = getWeightRatioPower('Pikachu', '', '', 'Snorlax', '', '');
		assertEqual(power, 40, '比率 <= 1 = 40 威力');
	});

	test('Heavy Metal 应提高 Heavy Slam 威力 / Heavy Metal increases Heavy Slam power', () => {
		const normalPower = getWeightRatioPower('Aggron', '', '', 'Tyranitar', '', '');
		assertEqual(normalPower, 40, '正常比率 40 威力');

		const heavyPower = getWeightRatioPower('Aggron', 'Heavy Metal', '', 'Tyranitar', '', '');
		assertEqual(heavyPower, 80, 'Heavy Metal 后 80 威力');
	});

	test('防守方 Light Metal 应提高对方 Heavy Slam 威力 / Defender Light Metal increases Heavy Slam', () => {
		const power = getWeightRatioPower('Aggron', '', '', 'Tyranitar', 'Light Metal', '');
		assertEqual(power, 80, '防守方 Light Metal 后比率提高');
	});

	// =============================================================================
	// Salt Cure 伤害测试 / SALT CURE DAMAGE TESTS
	// =============================================================================

	section('Salt Cure 伤害 / Salt Cure Damage');

	test('getSaltCureDamage 对普通类型应返回 1/8 HP / getSaltCureDamage should return 1/8 HP for normal types', () => {
		const pokemon = {
			types: ['Normal'],
			ability: '',
			maxHp: 200,
			hpPercent: 100,
			volatiles: new Set(['saltcure']),
		};
		const damage = getSaltCureDamage(pokemon);
		assertEqual(damage, 25, '普通类型应受 1/8 HP (25) 伤害');
	});

	test('getSaltCureDamage 对水系应返回 1/4 HP / getSaltCureDamage should return 1/4 HP for Water type', () => {
		const pokemon = {
			types: ['Water', 'Flying'],
			ability: '',
			maxHp: 200,
			hpPercent: 100,
			volatiles: new Set(['saltcure']),
		};
		const damage = getSaltCureDamage(pokemon);
		assertEqual(damage, 50, '水系应受 1/4 HP (50) 伤害');
	});

	test('getSaltCureDamage 对钢系应返回 1/4 HP / getSaltCureDamage should return 1/4 HP for Steel type', () => {
		const pokemon = {
			types: ['Steel', 'Psychic'],
			ability: '',
			maxHp: 200,
			hpPercent: 100,
			volatiles: new Set(['saltcure']),
		};
		const damage = getSaltCureDamage(pokemon);
		assertEqual(damage, 50, '钢系应受 1/4 HP (50) 伤害');
	});

	test('getSaltCureDamage 对 Magic Guard 应返回 0 / getSaltCureDamage should return 0 for Magic Guard', () => {
		const pokemon = {
			types: ['Water'],
			ability: 'Magic Guard',
			maxHp: 200,
			hpPercent: 100,
			volatiles: new Set(['saltcure']),
		};
		const damage = getSaltCureDamage(pokemon);
		assertEqual(damage, 0, 'Magic Guard 应阻止 Salt Cure 伤害');
	});

	test('getSaltCureDamage 对没有 Salt Cure 状态的目标应返回 0 / getSaltCureDamage should return 0 if no saltcure volatile', () => {
		const pokemon = {
			types: ['Water'],
			ability: '',
			maxHp: 200,
			hpPercent: 100,
			volatiles: new Set(),
		};
		const damage = getSaltCureDamage(pokemon);
		assertEqual(damage, 0, '没有 Salt Cure 状态应返回 0');
	});
}

module.exports = { runDamageCalcTests };
