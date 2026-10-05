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

	// =============================================================================
	// 攻击方特性（基准伤害相对关系）
	// =============================================================================
	section('AI 伤害计算：攻击方特性');

	function cloneWithAbility(mon, ability) {
		return { ...mon, ability };
	}

	test('Water Bubble: 水招式伤害翻倍', () => {
		// 基准：没有 Water Bubble 的 Starmie Surf
		const starmie = makePokemon('Starmie', {
			ability: 'Natural Cure',
			evs: { spa: 252, spe: 252, def: 4 },
			nature: { plus: 'spe', minus: 'atk' },
		});
		const target = garchomp();
		const surf = makeMove('surf');
		const base = calculateDamage(starmie, target, surf, emptyField());
		const boosted = calculateDamage(cloneWithAbility(starmie, 'Water Bubble'), target, surf, emptyField());
		assert(boosted.min >= base.min * 1.9 && boosted.min <= base.min * 2.1,
			`Water Bubble should ~2x base. base.min=${base.min}, boosted.min=${boosted.min}`);
	});

	test('Transistor: 电招式 1.5x', () => {
		const koko = makePokemon('Tapu Koko', {
			ability: 'Electric Surge',
			evs: { spa: 244, spe: 252, hp: 8 },
			nature: { plus: 'spe', minus: 'atk' },
		});
		const base = calculateDamage(koko, slowbro(), makeMove('thunderbolt'), emptyField());
		const boosted = calculateDamage(cloneWithAbility(koko, 'Transistor'), slowbro(), makeMove('thunderbolt'), emptyField());
		assert(boosted.min >= base.min * 1.45 && boosted.min <= base.min * 1.55,
			`Transistor should ~1.5x. base.min=${base.min}, boosted.min=${boosted.min}`);
	});

	test('Dragon\'s Maw: 龙招式 1.5x', () => {
		// 用一只有 Dragon Claw 可学、原特性对 Dragon Claw 没加成的 Pokemon
		const dragonite = makePokemon('Dragonite', {
			ability: 'Multiscale', // 防御向，对 Dragon Claw 伤害无影响
			evs: { atk: 252, spe: 252, hp: 4 },
			nature: { plus: 'atk', minus: 'spa' },
		});
		const base = calculateDamage(dragonite, slowbro(), makeMove('dragonclaw'), emptyField());
		const boosted = calculateDamage(cloneWithAbility(dragonite, "Dragon's Maw"), slowbro(), makeMove('dragonclaw'), emptyField());
		assert(boosted.min >= base.min * 1.45 && boosted.min <= base.min * 1.55,
			`Dragon's Maw should ~1.5x. base.min=${base.min}, boosted.min=${boosted.min}`);
	});

	test('Steelworker: 钢招式 1.5x', () => {
		const kartana = makePokemon('Kartana', {
			ability: 'Beast Boost',
			evs: { atk: 252, spe: 252, spd: 4 },
			nature: { plus: 'spe', minus: 'spa' },
		});
		const base = calculateDamage(kartana, slowbro(), makeMove('smartstrike'), emptyField());
		const boosted = calculateDamage(cloneWithAbility(kartana, 'Steelworker'), slowbro(), makeMove('smartstrike'), emptyField());
		assert(boosted.min >= base.min * 1.45 && boosted.min <= base.min * 1.55,
			`Steelworker should ~1.5x. base.min=${base.min}, boosted.min=${boosted.min}`);
	});

	test('Tinted Lens: 抵抗属性 2x（Grass vs Dragon = 0.5x → 1x）', () => {
		// Ferrothorn Power Whip vs Garchomp (Grass vs Dragon/Ground = 0.5 * 2 = 1x)
		// 测试里要有"抵抗"的目标。Grass vs Mega Char-X (Fire/Dragon) = 0.25
		const ferro = makePokemon('Ferrothorn', {
			ability: 'Iron Barbs',
			evs: { hp: 252, def: 48, spd: 208 },
			nature: { plus: 'spd', minus: 'spa' },
		});
		const base = calculateDamage(ferro, megaCharX(), makeMove('powerwhip'), emptyField());
		const boosted = calculateDamage(cloneWithAbility(ferro, 'Tinted Lens'), megaCharX(), makeMove('powerwhip'), emptyField());
		assert(boosted.min >= base.min * 1.9 && boosted.min <= base.min * 2.1,
			`Tinted Lens should 2x resisted. base.min=${base.min}, boosted.min=${boosted.min}`);
	});

	test('Tinted Lens 不生效于常规或超效伤害', () => {
		// Garchomp EQ vs Mega-X (Fire/Dragon)：Ground vs Fire = 2x
		const atk = garchomp();
		const base = calculateDamage(atk, megaCharX(), makeMove('earthquake'), emptyField());
		const boosted = calculateDamage(cloneWithAbility(atk, 'Tinted Lens'), megaCharX(), makeMove('earthquake'), emptyField());
		assertEqual(boosted.min, base.min, 'Tinted Lens should not affect super-effective');
	});

	test('Neuroforce: 超效 1.25x', () => {
		const atk = garchomp();
		const base = calculateDamage(atk, megaCharX(), makeMove('earthquake'), emptyField());
		const boosted = calculateDamage(cloneWithAbility(atk, 'Neuroforce'), megaCharX(), makeMove('earthquake'), emptyField());
		assert(boosted.min >= base.min * 1.2 && boosted.min <= base.min * 1.3,
			`Neuroforce should ~1.25x super-effective. base.min=${base.min}, boosted.min=${boosted.min}`);
	});

	// =============================================================================
	// 防御方特性
	// =============================================================================
	section('AI 伤害计算：防御方特性');

	test('Filter: 超效伤害 ×0.75', () => {
		const def = megaCharX();
		const atk = garchomp();
		const base = calculateDamage(atk, def, makeMove('earthquake'), emptyField());
		const defFiltered = cloneWithAbility(def, 'Filter');
		const reduced = calculateDamage(atk, defFiltered, makeMove('earthquake'), emptyField());
		assert(reduced.min >= base.min * 0.7 && reduced.min <= base.min * 0.8,
			`Filter should ~0.75x. base.min=${base.min}, reduced.min=${reduced.min}`);
	});

	test('Solid Rock: 超效伤害 ×0.75（和 Filter 一致）', () => {
		const def = megaCharX();
		const atk = garchomp();
		const base = calculateDamage(atk, def, makeMove('earthquake'), emptyField());
		const reduced = calculateDamage(atk, cloneWithAbility(def, 'Solid Rock'), makeMove('earthquake'), emptyField());
		assert(reduced.min >= base.min * 0.7 && reduced.min <= base.min * 0.8,
			`Solid Rock should ~0.75x. base.min=${base.min}, reduced.min=${reduced.min}`);
	});

	test('Fluffy: 火招式 ×2（接触无 Flare Blitz → 单纯火 ×2）', () => {
		// Flare Blitz 本身是接触招，火 ×2 和 接触 ×0.5 叠加 = ×1，所以用 Fire Blast（非接触）
		const atk = megaCharX();
		const def = slowbro();
		const fireBlast = makeMove('fireblast');
		const base = calculateDamage(atk, def, fireBlast, emptyField());
		const fluffy = calculateDamage(atk, cloneWithAbility(def, 'Fluffy'), fireBlast, emptyField());
		assert(fluffy.min >= base.min * 1.9 && fluffy.min <= base.min * 2.1,
			`Fluffy should 2x non-contact Fire. base.min=${base.min}, fluffy.min=${fluffy.min}`);
	});

	test('Fluffy: 接触招式 ×0.5（非火）', () => {
		const atk = garchomp();
		const def = slowbro();
		const base = calculateDamage(atk, def, makeMove('earthquake'), emptyField());
		// EQ 不是接触招，Fluffy 不该生效
		const fluffyEq = calculateDamage(atk, cloneWithAbility(def, 'Fluffy'), makeMove('earthquake'), emptyField());
		assertEqual(fluffyEq.min, base.min, 'Fluffy should not affect non-contact Earthquake');

		// Dragon Claw 是接触招，非火 → ×0.5
		const dc = makeMove('dragonclaw');
		const dcBase = calculateDamage(atk, def, dc, emptyField());
		const dcFluffy = calculateDamage(atk, cloneWithAbility(def, 'Fluffy'), dc, emptyField());
		assert(dcFluffy.min >= dcBase.min * 0.45 && dcFluffy.min <= dcBase.min * 0.55,
			`Fluffy should 0.5x contact non-Fire. base=${dcBase.min}, fluffy=${dcFluffy.min}`);
	});

	test('Fluffy: Flare Blitz 火+接触 → 抵消 ×1', () => {
		const atk = megaCharX();
		const def = garchomp();
		const base = calculateDamage(atk, def, makeMove('flareblitz'), emptyField());
		const fluffy = calculateDamage(atk, cloneWithAbility(def, 'Fluffy'), makeMove('flareblitz'), emptyField());
		// 允许 ±5% 浮动（因 Math.floor 顺序）
		assert(Math.abs(fluffy.min - base.min) <= Math.max(2, base.min * 0.05),
			`Fluffy on Flare Blitz should cancel. base=${base.min}, fluffy=${fluffy.min}`);
	});

	test('Ice Scales: 特殊招 ×0.5', () => {
		const atk = megaCharX();
		const def = garchomp();
		const base = calculateDamage(atk, def, makeMove('dragonpulse'), emptyField());
		const ice = calculateDamage(atk, cloneWithAbility(def, 'Ice Scales'), makeMove('dragonpulse'), emptyField());
		assert(ice.min >= base.min * 0.45 && ice.min <= base.min * 0.55,
			`Ice Scales should 0.5x special. base=${base.min}, ice=${ice.min}`);
	});

	test('Ice Scales 不影响物理招', () => {
		const atk = garchomp();
		const def = slowbro();
		const base = calculateDamage(atk, def, makeMove('earthquake'), emptyField());
		const ice = calculateDamage(atk, cloneWithAbility(def, 'Ice Scales'), makeMove('earthquake'), emptyField());
		assertEqual(ice.min, base.min, 'Ice Scales should not affect physical');
	});

	test('Punk Rock (defender): 声音招 ×0.5', () => {
		const exploud = makePokemon('Exploud', {
			ability: 'Scrappy',
			evs: { spa: 252, spe: 252, def: 4 },
			nature: { plus: 'spa', minus: 'atk' },
		});
		const def = slowbro();
		const base = calculateDamage(exploud, def, makeMove('boomburst'), emptyField());
		const pr = calculateDamage(exploud, cloneWithAbility(def, 'Punk Rock'), makeMove('boomburst'), emptyField());
		assert(pr.min >= base.min * 0.45 && pr.min <= base.min * 0.55,
			`Punk Rock def should 0.5x sound. base=${base.min}, pr=${pr.min}`);
	});

	// =============================================================================
	// 道具：抵抗果
	// =============================================================================
	section('AI 伤害计算：抵抗果');

	test('Yache Berry: Ice 招式超效 ×0.5', () => {
		const atk = makePokemon('Weavile', {
			ability: 'Pressure',
			evs: { atk: 252, spe: 252, hp: 4 },
			nature: { plus: 'spe', minus: 'spa' },
		});
		const def = garchomp();
		const iceMove = makeMove('iciclecrash');
		const base = calculateDamage(atk, def, iceMove, emptyField());
		const defBerry = { ...def, item: 'Yache Berry' };
		const berry = calculateDamage(atk, defBerry, iceMove, emptyField());
		assert(berry.min >= base.min * 0.45 && berry.min <= base.min * 0.55,
			`Yache Berry should 0.5x super-effective Ice. base=${base.min}, berry=${berry.min}`);
	});

	test('Yache Berry 已被 itemLost 则不生效', () => {
		const atk = makePokemon('Weavile', {
			ability: 'Pressure',
			evs: { atk: 252, spe: 252, hp: 4 },
			nature: { plus: 'spe', minus: 'spa' },
		});
		const def = garchomp();
		const defBerryUsed = { ...def, item: 'Yache Berry', itemLost: true };
		const base = calculateDamage(atk, def, makeMove('iciclecrash'), emptyField());
		const used = calculateDamage(atk, defBerryUsed, makeMove('iciclecrash'), emptyField());
		assertEqual(used.min, base.min, 'Yache Berry gone → no reduction');
	});

	test('Chilan Berry: Normal 招无条件 ×0.5', () => {
		// Chansey Return 102 vs Garchomp (Normal × 1 for Garchomp)
		const atk = chansey();
		atk.baseStats.atk = 300; // 给 Chansey 足够的攻击让 Return 不是 0
		const chan = { ...atk };
		const def = garchomp();
		const normalMove = makeMove('bodyslam');
		const base = calculateDamage(chan, def, normalMove, emptyField());
		const defBerry = { ...def, item: 'Chilan Berry' };
		const berry = calculateDamage(chan, defBerry, normalMove, emptyField());
		assert(berry.min >= base.min * 0.45 && berry.min <= base.min * 0.55,
			`Chilan Berry should 0.5x any Normal. base=${base.min}, berry=${berry.min}`);
	});
}

module.exports = { runAIDamageCalcTests };
