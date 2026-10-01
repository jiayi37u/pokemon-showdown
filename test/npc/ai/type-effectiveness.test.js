/**
 * 属性相克测试 / Type Effectiveness Tests
 * 测试属性克制、特性免疫、神奇守护等
 */

const { section, test, assertEqual, assert } = require('./test-utils');

function runTypeEffectivenessTests() {
	const { getTypeEffectiveness, getAbilityTypeImmunity, wonderGuardBlocks } = require('../../../dist/server/npc/ai/cfru/util/type-calc');

	// =============================================================================
	// 属性相克测试 / TYPE EFFECTIVENESS TESTS
	// =============================================================================

	section('属性免疫检查 / Type Effectiveness - Immunity');

	// 地面 vs 飞行 = 免疫
	test('地面打飞行应免疫 / Ground vs Flying should be immune', () => {
		const effectiveness = getTypeEffectiveness('Ground', ['Flying']);
		assertEqual(effectiveness, 0, '地面打飞行应为0倍');
	});

	// 地面 vs 飞行/龙 = 免疫（飞行属性使其免疫）
	test('地面打飞行龙应免疫 / Ground vs Flying/Dragon should be immune', () => {
		const effectiveness = getTypeEffectiveness('Ground', ['Flying', 'Dragon']);
		assertEqual(effectiveness, 0, '地面打飞行龙应为0倍');
	});

	// 电 vs 地面 = 免疫
	test('电打地面应免疫 / Electric vs Ground should be immune', () => {
		const effectiveness = getTypeEffectiveness('Electric', ['Ground']);
		assertEqual(effectiveness, 0, '电打地面应为0倍');
	});

	// 普通 vs 幽灵 = 免疫
	test('普通打幽灵应免疫 / Normal vs Ghost should be immune', () => {
		const effectiveness = getTypeEffectiveness('Normal', ['Ghost']);
		assertEqual(effectiveness, 0, '普通打幽灵应为0倍');
	});

	// 格斗 vs 幽灵 = 免疫
	test('格斗打幽灵应免疫 / Fighting vs Ghost should be immune', () => {
		const effectiveness = getTypeEffectiveness('Fighting', ['Ghost']);
		assertEqual(effectiveness, 0, '格斗打幽灵应为0倍');
	});

	// 幽灵 vs 普通 = 免疫
	test('幽灵打普通应免疫 / Ghost vs Normal should be immune', () => {
		const effectiveness = getTypeEffectiveness('Ghost', ['Normal']);
		assertEqual(effectiveness, 0, '幽灵打普通应为0倍');
	});

	// 毒 vs 钢 = 免疫
	test('毒打钢应免疫 / Poison vs Steel should be immune', () => {
		const effectiveness = getTypeEffectiveness('Poison', ['Steel']);
		assertEqual(effectiveness, 0, '毒打钢应为0倍');
	});

	// 超能 vs 恶 = 免疫
	test('超能打恶应免疫 / Psychic vs Dark should be immune', () => {
		const effectiveness = getTypeEffectiveness('Psychic', ['Dark']);
		assertEqual(effectiveness, 0, '超能打恶应为0倍');
	});

	// 龙 vs 妖精 = 免疫
	test('龙打妖精应免疫 / Dragon vs Fairy should be immune', () => {
		const effectiveness = getTypeEffectiveness('Dragon', ['Fairy']);
		assertEqual(effectiveness, 0, '龙打妖精应为0倍');
	});

	section('克制与抵抗 / Type Effectiveness - Super Effective and Resistance');

	// 火 vs 草 = 2倍克制
	test('火打草应2倍克制 / Fire vs Grass should be 2x', () => {
		const effectiveness = getTypeEffectiveness('Fire', ['Grass']);
		assertEqual(effectiveness, 2, '火打草应为2倍');
	});

	// 火 vs 草钢 = 4倍克制
	test('火打草钢应4倍克制 / Fire vs Grass/Steel should be 4x', () => {
		const effectiveness = getTypeEffectiveness('Fire', ['Grass', 'Steel']);
		assertEqual(effectiveness, 4, '火打草钢应为4倍');
	});

	// 火 vs 水 = 0.5倍抵抗
	test('火打水应0.5倍抵抗 / Fire vs Water should be 0.5x', () => {
		const effectiveness = getTypeEffectiveness('Fire', ['Water']);
		assertEqual(effectiveness, 0.5, '火打水应为0.5倍');
	});

	// 火 vs 水龙 = 0.25倍抵抗
	test('火打水龙应0.25倍抵抗 / Fire vs Water/Dragon should be 0.25x', () => {
		const effectiveness = getTypeEffectiveness('Fire', ['Water', 'Dragon']);
		assertEqual(effectiveness, 0.25, '火打水龙应为0.25倍');
	});

	// 火 vs 水草 = 1倍（水抵抗-1，草弱点+1，抵消）
	test('火打水草应1倍 / Fire vs Water/Grass should be 1x (neutral)', () => {
		const effectiveness = getTypeEffectiveness('Fire', ['Water', 'Grass']);
		assertEqual(effectiveness, 1, '火打水草应为1倍');
	});

	// =============================================================================
	// 特性属性免疫测试 / ABILITY TYPE IMMUNITY TESTS
	// =============================================================================

	section('特性属性免疫 / Ability Type Immunity');

	// 蓄电：电系免疫
	test('蓄电应免疫电系 / Volt Absorb grants Electric immunity', () => {
		const result = getAbilityTypeImmunity('Electric', 'Volt Absorb');
		assertEqual(result.immune, true, '蓄电免疫电系');
	});

	// 储水：水系免疫
	test('储水应免疫水系 / Water Absorb grants Water immunity', () => {
		const result = getAbilityTypeImmunity('Water', 'Water Absorb');
		assertEqual(result.immune, true, '储水免疫水系');
	});

	// 引火：火系免疫
	test('引火应免疫火系 / Flash Fire grants Fire immunity', () => {
		const result = getAbilityTypeImmunity('Fire', 'Flash Fire');
		assertEqual(result.immune, true, '引火免疫火系');
	});

	// 食草：草系免疫
	test('食草应免疫草系 / Sap Sipper grants Grass immunity', () => {
		const result = getAbilityTypeImmunity('Grass', 'Sap Sipper');
		assertEqual(result.immune, true, '食草免疫草系');
	});

	// 飘浮：地面免疫
	test('飘浮应免疫地面 / Levitate grants Ground immunity', () => {
		const result = getAbilityTypeImmunity('Ground', 'Levitate');
		assertEqual(result.immune, true, '飘浮免疫地面');
	});

	// 引雷：电系免疫
	test('引雷应免疫电系 / Lightning Rod grants Electric immunity', () => {
		const result = getAbilityTypeImmunity('Electric', 'Lightning Rod');
		assertEqual(result.immune, true, '引雷免疫电系');
	});

	// 引水：水系免疫
	test('引水应免疫水系 / Storm Drain grants Water immunity', () => {
		const result = getAbilityTypeImmunity('Water', 'Storm Drain');
		assertEqual(result.immune, true, '引水免疫水系');
	});

	// 电气引擎：电系免疫
	test('电气引擎应免疫电系 / Motor Drive grants Electric immunity', () => {
		const result = getAbilityTypeImmunity('Electric', 'Motor Drive');
		assertEqual(result.immune, true, '电气引擎免疫电系');
	});

	// 干燥皮肤：水系免疫
	test('干燥皮肤应免疫水系 / Dry Skin grants Water immunity', () => {
		const result = getAbilityTypeImmunity('Water', 'Dry Skin');
		assertEqual(result.immune, true, '干燥皮肤免疫水系');
	});

	// 猛火（普通特性）不应提供免疫
	test('普通特性不应提供免疫 / Blaze does not grant immunity', () => {
		const result = getAbilityTypeImmunity('Fire', 'Blaze');
		assertEqual(result.immune, false, '猛火不免疫火系');
	});

	// =============================================================================
	// 神奇守护测试 / WONDER GUARD TESTS
	// =============================================================================

	section('神奇守护 / Wonder Guard');

	// 神奇守护应阻挡正常倍率招式
	test('神奇守护应阻挡正常倍率招式 / Wonder Guard blocks neutral moves', () => {
		const blocked = wonderGuardBlocks('Normal', ['Bug', 'Ghost'], 'Wonder Guard');
		assertEqual(blocked, true, '普通打虫幽灵(1x)应被阻挡');
	});

	// 神奇守护应阻挡抵抗招式
	test('神奇守护应阻挡被抵抗招式 / Wonder Guard blocks resisted moves', () => {
		const blocked = wonderGuardBlocks('Poison', ['Bug', 'Ghost'], 'Wonder Guard');
		assertEqual(blocked, true, '毒打虫幽灵(0.5x)应被阻挡');
	});

	// 神奇守护不应阻挡克制招式
	test('神奇守护不应阻挡克制招式 / Wonder Guard does NOT block super effective', () => {
		const blocked = wonderGuardBlocks('Fire', ['Bug', 'Ghost'], 'Wonder Guard');
		assertEqual(blocked, false, '火打虫幽灵(2x)不应被阻挡');
	});

	// 神奇守护对免疫招式的处理
	test('免疫招式本身就无效 / Immune moves fail anyway', () => {
		const blocked = wonderGuardBlocks('Normal', ['Ghost'], 'Wonder Guard');
		assertEqual(blocked, true, '普通打幽灵会触发神奇守护检查');
	});

	// 非神奇守护特性不应阻挡任何招式
	test('非神奇守护特性不阻挡招式 / Non-Wonder Guard does not block', () => {
		const blocked = wonderGuardBlocks('Normal', ['Bug'], 'Swarm');
		assertEqual(blocked, false, '虫之预感没有神奇守护效果');
	});
}

module.exports = { runTypeEffectivenessTests };
