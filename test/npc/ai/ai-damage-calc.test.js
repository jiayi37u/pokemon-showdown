/**
 * AI 伤害计算回归测试 / AI Damage Calculator Regression
 *
 * 用具体对子（Garchomp 地震 vs Mega Charizard X 等）锚定 AI 的 `calculateDamage`
 * 的输出范围，防止静默回归。期望范围来自 Smogon 风格的伤害计算器，用户在 PR
 * 里直接给出的数值。
 *
 * 场景：
 *   1. 单打 Garchomp EQ vs Mega Char-X (0 HP / 4 Def)   → 300-354 (OHKO)
 *   2. 双打 Garchomp EQ (allAdjacentFoes, 0.75x spread) → 222-264
 *   3. Mega Char-X Dragon Claw (Tough Claws) vs Garchomp (0/0) → 356-420
 *   4. Mega Char-X Flare Blitz (Tough Claws, 0.5x type) vs Garchomp → 133-157
 */

const { section, test, assertEqual, assert } = require('./test-utils');

function runAIDamageCalcTests() {
	const Dex = require('../../../dist/sim/dex').Dex;
	const { calculateDamage } = require('../../../dist/server/npc/ai/cfru/util/damage-calc');

	function emptyBoosts() {
		return { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
	}

	/**
	 * 按 PS 常用 lv100 EV/IV/nature 公式反算实际数值。
	 * nature: { plus: stat | null, minus: stat | null }
	 */
	function calcStats(baseStats, evs, nature) {
		const IV = 31;
		const stat = (base, ev, boost) => {
			const raw = Math.floor(((2 * base + IV + Math.floor(ev / 4)) * 100) / 100) + 5;
			return Math.floor(raw * boost);
		};
		const boost = (key) => {
			if (nature.plus === key) return 1.1;
			if (nature.minus === key) return 0.9;
			return 1.0;
		};
		return {
			hp: Math.floor(((2 * baseStats.hp + IV + Math.floor((evs.hp || 0) / 4)) * 100) / 100) + 100 + 10,
			atk: stat(baseStats.atk, evs.atk || 0, boost('atk')),
			def: stat(baseStats.def, evs.def || 0, boost('def')),
			spa: stat(baseStats.spa, evs.spa || 0, boost('spa')),
			spd: stat(baseStats.spd, evs.spd || 0, boost('spd')),
			spe: stat(baseStats.spe, evs.spe || 0, boost('spe')),
		};
	}

	/**
	 * 从 Dex 构造 AIPokemon。只填 damage-calc 需要的字段。
	 */
	function makePokemon(species, { ability, item, evs, nature, slot = 1 }) {
		const data = Dex.species.get(species);
		if (!data?.exists) throw new Error(`species not found: ${species}`);
		const stats = calcStats(data.baseStats, evs, nature);
		return {
			slot,
			species: data.name,
			hp: stats.hp,
			maxHp: stats.hp,
			hpPercent: 100,
			status: '',
			sleepTurns: 0,
			toxicCounter: 0,
			types: data.types.slice(),
			ability,
			item: item || '',
			itemLost: false,
			moves: [],
			lastMove: '',
			baseStats: stats,
			boosts: emptyBoosts(),
			abilityStatMod: { stat: null, multiplier: 1 },
			volatiles: new Set(),
			fainted: false,
			active: true,
			level: 100,
			gender: 'N',
		};
	}

	/**
	 * 从 Dex 构造 AIMove；默认 flags 直接取 Dex 的 flags。
	 */
	function makeMove(name) {
		const d = Dex.moves.get(name);
		if (!d?.exists) throw new Error(`move not found: ${name}`);
		return {
			id: d.id,
			name: d.name,
			slot: 1,
			type: d.type,
			category: d.category,
			basePower: d.basePower,
			accuracy: d.accuracy,
			pp: d.pp,
			maxPp: d.pp,
			priority: d.priority || 0,
			target: d.target || 'normal',
			flags: d.flags || {},
			secondaryChance: d.secondary?.chance || 0,
			disabled: false,
			isZMove: false,
			isMaxMove: false,
			multihit: d.multihit || null,
		};
	}

	function emptyField() {
		return {
			weather: '',
			weatherTurns: -1,
			terrain: '',
			terrainTurns: -1,
			trickroom: false,
			trickroomTurns: 0,
			gravity: false,
			magicroom: false,
			wonderroom: false,
		};
	}

	// 测试队伍：sample_team_1 的 Garchomp + sample_team_2 的 Mega Charizard X
	// Garchomp: Jolly 252 Atk / 4 SpD / 252 Spe, Rough Skin
	// Mega Char-X: Jolly 252 Atk / 4 Def / 252 Spe, Tough Claws
	const garchomp = () => makePokemon('Garchomp', {
		ability: 'Rough Skin',
		item: '',
		evs: { atk: 252, spd: 4, spe: 252 },
		nature: { plus: 'spe', minus: 'spa' },
	});
	const megaCharX = () => makePokemon('Charizard-Mega-X', {
		ability: 'Tough Claws',
		item: 'Charizardite X',
		evs: { atk: 252, def: 4, spe: 252 },
		nature: { plus: 'spe', minus: 'spa' },
	});

	// 期望值区间，带 ±4 的容差；不同实现对 0.75 spread、位运算、floor 顺序可能差 1-3。
	function assertRange(result, min, max, label, tolerance = 4) {
		assert(
			Math.abs(result.min - min) <= tolerance,
			`${label}: min expected ~${min}, got ${result.min} (max=${result.max})`
		);
		assert(
			Math.abs(result.max - max) <= tolerance,
			`${label}: max expected ~${max}, got ${result.max} (min=${result.min})`
		);
	}

	section('AI 伤害计算：Garchomp vs Mega Charizard X');

	test('单打 Garchomp EQ vs Mega Char-X → 300-354', () => {
		const atk = garchomp();
		const def = megaCharX();
		const move = makeMove('earthquake');
		const r = calculateDamage(atk, def, move, emptyField());
		assertRange(r, 300, 354, 'Garchomp Earthquake vs Mega Char-X');
	});

	test('双打 Garchomp EQ (0.75x spread) vs Mega Char-X → 222-264', () => {
		const atk = garchomp();
		const def = megaCharX();
		const move = makeMove('earthquake');
		const r = calculateDamage(atk, def, move, emptyField(), undefined, {
			isDoubles: true,
			numAliveTargets: 2,
		});
		assertRange(r, 222, 264, 'Garchomp Earthquake spread vs Mega Char-X');
	});

	test('Mega Char-X Dragon Claw (Tough Claws) vs Garchomp → 356-420', () => {
		const atk = megaCharX();
		const def = garchomp();
		const move = makeMove('dragonclaw');
		const r = calculateDamage(atk, def, move, emptyField());
		assertRange(r, 356, 420, 'Mega Char-X Dragon Claw vs Garchomp');
	});

	test('Mega Char-X Flare Blitz (Tough Claws, 0.5x type) vs Garchomp → 133-157', () => {
		const atk = megaCharX();
		const def = garchomp();
		const move = makeMove('flareblitz');
		const r = calculateDamage(atk, def, move, emptyField());
		assertRange(r, 133, 157, 'Mega Char-X Flare Blitz vs Garchomp');
	});

	// =============================================================================
	// 固定伤害招式 / Fixed-damage moves
	// =============================================================================
	section('AI 伤害计算：固定伤害招式');

	const chansey = () => makePokemon('Chansey', {
		ability: 'Natural Cure',
		item: 'Eviolite',
		evs: { hp: 240, def: 252, spe: 16 },
		nature: { plus: 'def', minus: 'atk' },
	});
	const slowbro = () => makePokemon('Slowbro', {
		ability: 'Regenerator',
		item: 'Leftovers',
		evs: { hp: 252, def: 252, spd: 4 },
		nature: { plus: 'def', minus: 'atk' },
	});
	const megaGengar = () => makePokemon('Gengar-Mega', {
		ability: 'Shadow Tag',
		evs: { spa: 252, spe: 252, def: 4 },
		nature: { plus: 'spe', minus: 'atk' },
	});

	test('Seismic Toss (Fighting) vs Garchomp → exactly 100 (level)', () => {
		const r = calculateDamage(chansey(), garchomp(), makeMove('seismictoss'), emptyField());
		assertEqual(r.min, 100, 'Seismic Toss min=level');
		assertEqual(r.max, 100, 'Seismic Toss max=level');
	});

	test('Seismic Toss vs Ghost (Mega Gengar) → 0 (type immunity)', () => {
		const r = calculateDamage(chansey(), megaGengar(), makeMove('seismictoss'), emptyField());
		assertEqual(r.min, 0, 'Seismic Toss vs Ghost immune');
		assertEqual(r.max, 0, 'Seismic Toss vs Ghost immune');
	});

	test('Night Shade (Ghost) vs Garchomp → exactly 100 (level)', () => {
		const r = calculateDamage(chansey(), garchomp(), makeMove('nightshade'), emptyField());
		assertEqual(r.min, 100, 'Night Shade min=level');
		assertEqual(r.max, 100, 'Night Shade max=level');
	});

	test('Dragon Rage → fixed 40', () => {
		const r = calculateDamage(chansey(), garchomp(), makeMove('dragonrage'), emptyField());
		assertEqual(r.min, 40, 'Dragon Rage min');
		assertEqual(r.max, 40, 'Dragon Rage max');
	});

	test('Sonic Boom → fixed 20', () => {
		const r = calculateDamage(chansey(), garchomp(), makeMove('sonicboom'), emptyField());
		assertEqual(r.min, 20, 'Sonic Boom min');
		assertEqual(r.max, 20, 'Sonic Boom max');
	});

	test('Super Fang vs full HP Garchomp → half current HP (~178)', () => {
		const r = calculateDamage(chansey(), garchomp(), makeMove('superfang'), emptyField());
		// Garchomp max HP = 357 → 第一发 Super Fang = floor(357/2) = 178
		assertEqual(r.min, 178, 'Super Fang min');
		assertEqual(r.max, 178, 'Super Fang max');
	});

	test('Psywave min=level/2, max=level*3/2', () => {
		const r = calculateDamage(chansey(), garchomp(), makeMove('psywave'), emptyField());
		assertEqual(r.min, 50, 'Psywave min');
		assertEqual(r.max, 150, 'Psywave max');
	});

	// =============================================================================
	// Counter / Mirror Coat / Metal Burst
	// =============================================================================
	section('AI 伤害计算：Counter / Mirror Coat');

	test('Counter 没有 lastMove 时返回 0', () => {
		const def = megaCharX();
		def.lastMove = '';
		const r = calculateDamage(slowbro(), def, makeMove('counter'), emptyField());
		assertEqual(r.min, 0, 'Counter without lastMove');
	});

	test('Counter: Mega-X 上回合用 Flare Blitz（物理）→ 伤害 > 0', () => {
		const def = megaCharX();
		def.lastMove = 'flareblitz';
		const r = calculateDamage(slowbro(), def, makeMove('counter'), emptyField());
		assert(r.min > 0, `Counter after physical should deal damage, got ${r.min}`);
		assert(r.max > r.min * 0.9, 'Counter should return a range');
	});

	test('Counter: Mega-X 上回合用过 Dragon Pulse（特殊）→ 返回 0', () => {
		const def = megaCharX();
		def.lastMove = 'dragonpulse';
		const r = calculateDamage(slowbro(), def, makeMove('counter'), emptyField());
		assertEqual(r.min, 0, 'Counter after special should fail');
	});

	test('Mirror Coat: Mega-X 上回合用过 Dragon Pulse（特殊）→ 伤害 > 0', () => {
		const def = megaCharX();
		def.lastMove = 'dragonpulse';
		const r = calculateDamage(slowbro(), def, makeMove('mirrorcoat'), emptyField());
		assert(r.min > 0, `Mirror Coat after special should deal damage, got ${r.min}`);
	});

	test('Mirror Coat: 上回合物理招 → 返回 0', () => {
		const def = megaCharX();
		def.lastMove = 'flareblitz';
		const r = calculateDamage(slowbro(), def, makeMove('mirrorcoat'), emptyField());
		assertEqual(r.min, 0, 'Mirror Coat after physical should fail');
	});

	// =============================================================================
	// Sucker Punch
	// =============================================================================
	section('AI 伤害计算：Sucker Punch');

	test('Sucker Punch 没有 lastMove → 返回 0', () => {
		const atk = megaCharX();
		const def = garchomp();
		def.lastMove = '';
		const r = calculateDamage(atk, def, makeMove('suckerpunch'), emptyField());
		assertEqual(r.min, 0, 'Sucker Punch without lastMove');
	});

	test('Sucker Punch 对手上回合用 Status（Swords Dance）→ 返回 0', () => {
		const atk = megaCharX();
		const def = garchomp();
		def.lastMove = 'swordsdance';
		const r = calculateDamage(atk, def, makeMove('suckerpunch'), emptyField());
		assertEqual(r.min, 0, 'Sucker Punch vs Status user');
	});

	test('Sucker Punch 对手上回合用攻击招 → 走常规公式（> 0）', () => {
		const atk = megaCharX();
		const def = garchomp();
		def.lastMove = 'earthquake';
		const r = calculateDamage(atk, def, makeMove('suckerpunch'), emptyField());
		assert(r.min > 0, `Sucker Punch after attack should deal damage, got ${r.min}`);
	});
}

module.exports = { runAIDamageCalcTests };
