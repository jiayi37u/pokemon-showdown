/**
 * Opponent preset 测试 / Opponent Preset Tests
 *
 * 验证 `trackedPokemonToAIPokemon` 对命中 preset 的对手使用预设 EV/nature/道具，
 * 未命中对手回退到既有 IV=31 / EV=85 公式。
 */

const { section, test, assertEqual, assert } = require('./test-utils');

function runOpponentPresetTests() {
	const {
		getOpponentPreset,
		computeStatsFromPreset,
	} = require('../../../dist/server/npc/ai/cfru/util/opponent-presets');
	const { trackedPokemonToAIPokemon } = require('../../../dist/server/npc/ai/cfru/state-builder');
	const Dex = require('../../../dist/sim/dex').Dex;

	// 构造一个最小 TrackedPokemon 用于驱动 trackedPokemonToAIPokemon
	function mockTracked(species, {
		hpPercent = 100, status = '', ability = '', item = '', itemLost = false,
		knownMoves = [], lastMove = '', level = 100, boosts = null,
	} = {}) {
		const data = Dex.species.get(species);
		return {
			species: data.name,
			position: 'p1a',
			types: data.types.slice(),
			level,
			hpPercent,
			status,
			ability,
			item,
			itemLost,
			knownMoves,
			lastMove,
			boosts,
			active: true,
		};
	}

	section('Opponent Preset：直接查找 & stats 计算');

	test('已存在的 preset（Garchomp）→ 返回条目', () => {
		const p = getOpponentPreset('Garchomp');
		assert(p && p.nature === 'Jolly', `expected Jolly, got ${p?.nature}`);
		assertEqual(p.evs.atk, 252, 'Garchomp atk EV');
		assertEqual(p.evs.spe, 252, 'Garchomp spe EV');
	});

	test('不存在的 preset（Pikachu）→ null', () => {
		const p = getOpponentPreset('Pikachu');
		assertEqual(p, null, 'Pikachu should have no preset');
	});

	test('Garchomp Jolly 252 Atk → atk 359', () => {
		const bs = Dex.species.get('Garchomp').baseStats;
		const stats = computeStatsFromPreset(bs, 100, getOpponentPreset('Garchomp'));
		assertEqual(stats.atk, 359, 'Garchomp Jolly 252 Atk');
		assertEqual(stats.spe, 333, 'Garchomp Jolly 252 Spe');
	});

	test('Hydreigon Timid 252 SpA → spa 349, spe 324', () => {
		const bs = Dex.species.get('Hydreigon').baseStats;
		const stats = computeStatsFromPreset(bs, 100, getOpponentPreset('Hydreigon'));
		assertEqual(stats.spa, 349, 'Hydreigon Timid 252 SpA');
		assertEqual(stats.spe, 324, 'Hydreigon Timid 252 Spe');
	});

	test('Tyranitar Adamant 252 HP / 252 Atk → hp 404, atk 403', () => {
		const bs = Dex.species.get('Tyranitar').baseStats;
		const stats = computeStatsFromPreset(bs, 100, getOpponentPreset('Tyranitar'));
		assertEqual(stats.hp, 404, 'TTar HP');
		assertEqual(stats.atk, 403, 'TTar Atk');
	});

	test('Chansey Bold 252 HP / 252 Def → hp 704, def 119', () => {
		const bs = Dex.species.get('Chansey').baseStats;
		const stats = computeStatsFromPreset(bs, 100, getOpponentPreset('Chansey'));
		assertEqual(stats.hp, 704, 'Chansey HP');
		assertEqual(stats.def, 119, 'Chansey Def');
	});

	section('Opponent Preset：trackedPokemonToAIPokemon 命中 preset');

	test('Chansey preset 把 item 设为 Eviolite', () => {
		const tracked = mockTracked('Chansey');
		const mon = trackedPokemonToAIPokemon(tracked, 1, true);
		assertEqual(mon.item, 'Eviolite', 'Chansey item from preset');
	});

	test('协议暴露的 item 优先于 preset.item', () => {
		const tracked = mockTracked('Chansey', { item: 'Leftovers' });
		const mon = trackedPokemonToAIPokemon(tracked, 1, true);
		assertEqual(mon.item, 'Leftovers', 'observed item wins');
	});

	test('itemLost 已置真 → item 保持空（不回退 preset.item）', () => {
		const tracked = mockTracked('Chansey', { itemLost: true });
		const mon = trackedPokemonToAIPokemon(tracked, 1, true);
		assertEqual(mon.item, '', 'itemLost prevents preset fallback');
	});

	test('Garchomp preset 不写 item → mon.item 保持空', () => {
		const tracked = mockTracked('Garchomp');
		const mon = trackedPokemonToAIPokemon(tracked, 1, true);
		assertEqual(mon.item, '', 'Garchomp preset has no item');
	});

	test('未命中 preset 的 Pokemon 回退 IV=31/EV=85 公式', () => {
		// Pikachu 不在 preset 里；按 EV=85 公式应该 atk=226 (base 55)
		const tracked = mockTracked('Pikachu');
		const mon = trackedPokemonToAIPokemon(tracked, 1, true);
		// 公式: ((2*55 + 31 + 21) * 100 / 100) + 5 = 167
		// 没有 nature 修正
		assertEqual(mon.baseStats.atk, 167, 'Pikachu fallback atk');
	});

	test('Garchomp 命中 preset 后 atk 比默认 (357) 更高 (359)', () => {
		const tracked = mockTracked('Garchomp');
		const mon = trackedPokemonToAIPokemon(tracked, 1, true);
		assertEqual(mon.baseStats.atk, 359, 'Garchomp preset atk');
		// 默认估算是 357，preset 加上 Jolly nature 修正后速度提升明显
		assertEqual(mon.baseStats.spe, 333, 'Garchomp preset spe');
	});

	section('Opponent Preset：Chansey Eviolite 伤害降低');

	// 验证 preset.item='Eviolite' 对伤害计算下游生效
	const { calculateDamage } = require('../../../dist/server/npc/ai/cfru/util/damage-calc');

	function mkMove(name) {
		const d = Dex.moves.get(name);
		return {
			id: d.id, name: d.name, slot: 1, type: d.type, category: d.category,
			basePower: d.basePower, accuracy: d.accuracy, pp: d.pp, maxPp: d.pp,
			priority: d.priority || 0, target: d.target || 'normal',
			flags: d.flags || {}, secondaryChance: d.secondary?.chance || 0,
			disabled: false, isZMove: false, isMaxMove: false, multihit: d.multihit || null,
		};
	}
	function emptyField() {
		return {
			weather: '', weatherTurns: -1, terrain: '', terrainTurns: -1,
			trickroom: false, trickroomTurns: 0, gravity: false, magicroom: false, wonderroom: false,
		};
	}

	test('Chansey preset 命中 → 用 Eviolite 的 Def × 1.5 吸收伤害', () => {
		const chansey = trackedPokemonToAIPokemon(mockTracked('Chansey'), 2, true);
		const atk = trackedPokemonToAIPokemon(mockTracked('Garchomp'), 1, true);
		// Garchomp Earthquake vs Chansey w/ Eviolite preset
		const r = calculateDamage(atk, chansey, mkMove('earthquake'), emptyField());
		// 没有 Eviolite 的 Chansey 对比值 (手工拉一下)
		const chanseyNoItem = trackedPokemonToAIPokemon(
			mockTracked('Chansey', { itemLost: true }), 2, true
		);
		const rNoItem = calculateDamage(atk, chanseyNoItem, mkMove('earthquake'), emptyField());
		// Eviolite 应该降低 ~33% 伤害（def × 1.5 的大致效果）
		assert(r.max < rNoItem.max * 0.75,
			`Eviolite should reduce damage. withItem=${r.max}, noItem=${rNoItem.max}`);
	});
}

module.exports = { runOpponentPresetTests };
