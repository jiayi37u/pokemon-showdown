/**
 * CFRU AI - Damage Calculation Utilities
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Damage calculation functions for AI decision making.
 * Based on CFRU ai_util.c damage calculation logic.
 *
 * @license MIT
 */

import { Dex, toID } from '../../../../../sim/dex';
import type { AIPokemon, AIMove, DamageResult, AICache, FieldConditions, SideConditions } from '../types';
import { getSTABMultiplier, getMoveInteraction, resolveMove, type MoveInteractionContext } from './type-calc';
import { compareSpeedOrder, getEffectiveSpeed } from './speed';
import {
	activatesGem, effectiveAbility, getEffectiveStat, effectiveItem, grounded, rulesDex, defensiveAbility,
} from './mechanics';
import { flingFailure, itemAllowsRemoval } from './items';
import { pokemonCacheId } from './cache';
import { canHaveOpponentMoves } from './opponent-presets';

export interface DamageContext extends MoveInteractionContext {
	isDoubles: boolean;
	numAliveTargets: number;
	attackerSideConditions?: SideConditions;
	defenderSideConditions?: SideConditions;
}

/** Damage roll range (0.85 to 1.0) */
const MIN_ROLL = 0.85;
const MAX_ROLL = 1.0;

/**
 * 半减果 / 抵抗果 → 对应 move.type 的映射（Gen 3+）。
 * 用户带这个 berry，被该属性超效打到会一次性消耗，把这发伤害 ×0.5。
 * AI 侧用 defender.itemLost 判断是否已消耗。
 */
const RESIST_BERRY_TYPES: { [berry: string]: string } = {
	occaberry: 'Fire',
	passhoberry: 'Water',
	wacanberry: 'Electric',
	rindoberry: 'Grass',
	yacheberry: 'Ice',
	chopleberry: 'Fighting',
	kebiaberry: 'Poison',
	shucaberry: 'Ground',
	cobaberry: 'Flying',
	payapaberry: 'Psychic',
	tangaberry: 'Bug',
	chartiberry: 'Rock',
	kasibberry: 'Ghost',
	habanberry: 'Dragon',
	colburberry: 'Dark',
	babiriberry: 'Steel',
	roseliberry: 'Fairy',
	// Chilan Berry：对 Normal 招式 ×0.5，无论是否超效。单独处理不走此表。
};

/**
 * Get expected hit count for multi-hit moves
 * Based on CFRU GetNumHitsBasedOnMove function
 * @param move - Move being used
 * @param attackerAbility - Attacker's ability
 * @param attackerItem - Attacker's held item
 * @param attackerSpecies - Attacker's species
 * @returns Expected number of hits
 */
export function getExpectedHitCount(
	move: AIMove,
	attackerAbility: string,
	attackerItem: string,
	attackerSpecies: string
): number {
	// Single hit move
	if (!move.multihit) return 1;

	const abilityId = toID(attackerAbility);
	const itemId = toID(attackerItem);
	const speciesId = toID(attackerSpecies);
	const moveId = toID(move.id);

	// Fixed hit count (e.g., Double Kick = 2, Triple Kick = 3)
	if (typeof move.multihit === 'number') {
		return move.multihit;
	}

	// Range hit moves (e.g., [2, 5] for Bullet Seed)
	const [minHits, maxHits] = move.multihit;

	// Special cases
	// Surging Strikes: always 3 hits
	if (moveId === 'surgingstrikes') {
		return 3;
	}

	// Water Shuriken for Ash-Greninja: 3 hits
	if (moveId === 'watershuriken' && (speciesId === 'greninjaash' || speciesId === 'ashgreninja')) {
		return 3;
	}

	// Population Bomb: 10 hits max, but accuracy matters
	if (moveId === 'populationbomb') {
		// With Loaded Dice: 4-10 hits, avg ~7
		if (itemId === 'loadeddice') {
			return 7;
		}
		// With Skill Link: guaranteed 10 hits
		if (abilityId === 'skilllink') {
			return 10;
		}
		// Otherwise, each hit has 90% acc, expected ~5.7 hits
		return 5.7;
	}

	// 2-5 hit moves
	if (minHits === 2 && maxHits === 5) {
		// Skill Link: guarantees 5 hits
		if (abilityId === 'skilllink') {
			return 5;
		}

		// Loaded Dice: guarantees 4-5 hits (4.5 average)
		if (itemId === 'loadeddice') {
			return 4.5;
		}

		// Standard distribution: 35% for 2 or 3 hits, 15% for 4 or 5 hits
		// Expected value: 2*0.35 + 3*0.35 + 4*0.15 + 5*0.15 = 3.1
		// CFRU uses 3 as average for simplicity
		return 3;
	}

	// Other range moves: use average
	return (minHits + maxHits) / 2;
}

// =============================================================================
// Weight Calculation
// Based on CFRU damage_calc.c GetActualSpeciesWeight and AdjustWeight functions
// =============================================================================

/**
 * Get the actual weight of a Pokemon in hectograms (0.1 kg)
 * Based on CFRU GetActualSpeciesWeight function
 *
 * @param species - Pokemon species
 * @param ability - Pokemon's ability
 * @param item - Pokemon's held item
 * @returns Weight in hectograms (weighthg)
 */
export function getActualWeight(
	species: string,
	ability: string,
	item: string
): number {
	const speciesData = Dex.species.get(species);
	if (!speciesData.exists) return 100; // Default 10kg if species not found

	let weight = speciesData.weighthg; // Weight in hectograms (0.1 kg)

	const abilityId = toID(ability);
	const itemId = toID(item);

	// Light Metal: halves weight
	if (abilityId === 'lightmetal') {
		weight = Math.floor(weight / 2);
	}

	// Heavy Metal: doubles weight
	if (abilityId === 'heavymetal') {
		weight *= 2;
	}

	// Float Stone: halves weight
	if (itemId === 'floatstone') {
		weight = Math.floor(weight / 2);
	}

	// Minimum weight is 1 (0.1 kg)
	return Math.max(weight, 1);
}

/**
 * Get power for Low Kick / Grass Knot based on target's weight
 * Based on CFRU damage_calc.c lines 3521-3539
 *
 * Weight thresholds (in kg):
 * - >= 200 kg: 120 power
 * - >= 100 kg: 100 power
 * - >= 50 kg: 80 power
 * - >= 25 kg: 60 power
 * - >= 10 kg: 40 power
 * - < 10 kg: 20 power
 *
 * @param defenderSpecies - Defender's species
 * @param defenderAbility - Defender's ability
 * @param defenderItem - Defender's item
 * @returns Move power
 */
export function getWeightBasedPower(
	defenderSpecies: string,
	defenderAbility: string,
	defenderItem: string
): number {
	const weight = getActualWeight(defenderSpecies, defenderAbility, defenderItem);
	// CFRU uses weight / 10 (convert to kg), we have weighthg so divide by 10
	const weightKg = weight / 10;

	if (weightKg >= 200) return 120;
	if (weightKg >= 100) return 100;
	if (weightKg >= 50) return 80;
	if (weightKg >= 25) return 60;
	if (weightKg >= 10) return 40;
	return 20;
}

/**
 * Get power for Heavy Slam / Heat Crash based on weight ratio
 * Based on CFRU damage_calc.c lines 3542-3569
 *
 * Power is determined by attacker weight / defender weight ratio:
 * - ratio >= 5: 120 power
 * - ratio = 4: 100 power
 * - ratio = 3: 80 power
 * - ratio = 2: 60 power
 * - ratio <= 1: 40 power
 *
 * @param attackerSpecies - Attacker's species
 * @param attackerAbility - Attacker's ability
 * @param attackerItem - Attacker's item
 * @param defenderSpecies - Defender's species
 * @param defenderAbility - Defender's ability
 * @param defenderItem - Defender's item
 * @returns Move power
 */
export function getWeightRatioPower(
	attackerSpecies: string,
	attackerAbility: string,
	attackerItem: string,
	defenderSpecies: string,
	defenderAbility: string,
	defenderItem: string
): number {
	const atkWeight = getActualWeight(attackerSpecies, attackerAbility, attackerItem);
	const defWeight = getActualWeight(defenderSpecies, defenderAbility, defenderItem);

	// CFRU uses integer division
	const weightRatio = Math.floor(atkWeight / defWeight);

	switch (weightRatio) {
		case 0:
		case 1:
			return 40;
		case 2:
			return 60;
		case 3:
			return 80;
		case 4:
			return 100;
		default: // 5+
			return 120;
	}
}

/**
 * Get effective stat value considering boosts
 * @param base - Base stat value
 * @param boost - Boost stage (-6 to +6)
 * @returns Effective stat value
 */
export { getEffectiveStat } from './mechanics';

/**
 * Get attack stat for a move
 * @param attacker - Attacking Pokemon
 * @param move - Move being used
 * @param field - Field conditions
 * @returns Effective attack stat
 */
export function getAttackStat(
	attacker: AIPokemon,
	move: AIMove,
	field: FieldConditions,
	defender?: AIPokemon
): number {
	const isPhysical = move.category === 'Physical';
	const data = rulesDex(field).moves.get(move.calledMove || move.id);
	const statId = data.overrideOffensiveStat || (isPhysical ? 'atk' : 'spa');
	const source = data.overrideOffensivePokemon === 'target' && defender ? defender : attacker;
	const baseStatId = field.wonderroom && (statId === 'def' || statId === 'spd') ?
		(statId === 'def' ? 'spd' : 'def') : statId;
	const baseStat = source.baseStats[baseStatId];
	const unaware = defender && (source === attacker ?
		defensiveAbility(attacker, defender, move, field) === 'unaware' :
		effectiveAbility(attacker, field) === 'unaware' && statId === 'def');
	const boost = data.ignoreOffensive || unaware ||
		(data.ignoreNegativeOffensive && source.boosts[statId] < 0) ? 0 : source.boosts[statId];

	let stat = getEffectiveStat(baseStat, boost);

	// Ability modifiers
	const abilityId = effectiveAbility(attacker, field);

	// Huge Power / Pure Power
	if ((abilityId === 'hugepower' || abilityId === 'purepower') && isPhysical) {
		stat *= 2;
	}

	// Hustle (1.5x Attack, but we ignore accuracy penalty here)
	if (abilityId === 'hustle' && isPhysical) {
		stat = Math.floor(stat * 1.5);
	}

	// Guts (1.5x Attack when statused)
	if (abilityId === 'guts' && isPhysical && attacker.status) {
		stat = Math.floor(stat * 1.5);
	}

	// Solar Power (1.5x SpA in sun)
	if (abilityId === 'solarpower' && !isPhysical && field.weather === 'sun') {
		stat = Math.floor(stat * 1.5);
	}

	// Item modifiers
	const itemId = effectiveItem(attacker, field);

	// Choice Band / Choice Specs
	if (itemId === 'choiceband' && isPhysical) {
		stat = Math.floor(stat * 1.5);
	}
	if (itemId === 'choicespecs' && !isPhysical) {
		stat = Math.floor(stat * 1.5);
	}

	// Life Orb (1.3x, but we apply this to damage later for precision)

	// Species-specific items
	if (itemId === 'thickclub' && isPhysical) {
		const speciesId = toID(attacker.species);
		if (speciesId === 'cubone' || speciesId === 'marowak' || speciesId === 'marowakalola') {
			stat *= 2;
		}
	}

	if (itemId === 'lightball' && toID(attacker.species).startsWith('pikachu')) {
		stat *= 2;
	}

	if (abilityId === 'slowstart' && isPhysical && attacker.volatiles.has('slowstart')) stat *= 0.5;
	if (abilityId && attacker.abilityStatMod?.stat === (isPhysical ? 'atk' : 'spa')) {
		stat *= attacker.abilityStatMod.multiplier;
	}
	return Math.floor(stat);
}

/**
 * Get defense stat for a move
 * @param defender - Defending Pokemon
 * @param move - Move being used
 * @param field - Field conditions
 * @returns Effective defense stat
 */
export function getDefenseStat(
	defender: AIPokemon,
	move: AIMove,
	field: FieldConditions,
	ability: string = effectiveAbility(defender, field),
	attacker?: AIPokemon
): number {
	const statId = rulesDex(field).moves.get(move.id).overrideDefensiveStat ||
		(move.category === 'Physical' ? 'def' : 'spd');
	const usesPhysicalDef = statId === 'def';

	const physicalBase = usesPhysicalDef !== !!field.wonderroom;
	const baseStat = physicalBase ? defender.baseStats.def : defender.baseStats.spd;
	const data = rulesDex(field).moves.get(move.calledMove || move.id);
	const stage = usesPhysicalDef ? defender.boosts.def : defender.boosts.spd;
	const boost = data.ignoreDefensive || (data.ignorePositiveDefensive && stage > 0) ||
		(attacker && effectiveAbility(attacker, field) === 'unaware') ? 0 : stage;

	let stat = getEffectiveStat(baseStat, boost);

	// Ability modifiers
	const abilityId = ability;

	// Marvel Scale (1.5x Defense when statused)
	if (abilityId === 'marvelscale' && usesPhysicalDef && defender.status) {
		stat = Math.floor(stat * 1.5);
	}

	// Fur Coat (2x Defense)
	if (abilityId === 'furcoat' && usesPhysicalDef) {
		stat *= 2;
	}

	// Grass Pelt (1.5x Defense in Grassy Terrain)
	if (abilityId === 'grasspelt' && usesPhysicalDef && field.terrain === 'grassy') {
		stat = Math.floor(stat * 1.5);
	}

	// Item modifiers
	const itemId = effectiveItem(defender, field);

	// Eviolite (1.5x both defenses for NFE Pokemon)
	if (itemId === 'eviolite') {
		const species = rulesDex(field).species.get(defender.species);
		if (species.nfe) {
			stat = Math.floor(stat * 1.5);
		}
	}

	// Assault Vest (1.5x SpD)
	if (itemId === 'assaultvest' && !usesPhysicalDef) {
		stat = Math.floor(stat * 1.5);
	}

	// Sandstorm SpD boost for Rock types
	if (rulesDex(field).gen >= 4 && field.weather === 'sand' && !usesPhysicalDef && defender.types.includes('Rock')) {
		stat = Math.floor(stat * 1.5);
	}

	if (field.weather === 'snow' && usesPhysicalDef && defender.types.includes('Ice')) stat = Math.floor(stat * 1.5);
	if (ability && defender.abilityStatMod?.stat === (usesPhysicalDef ? 'def' : 'spd') &&
		ability === effectiveAbility(defender, field)) {
		stat *= defender.abilityStatMod.multiplier;
	}
	return Math.floor(stat);
}

/**
 * Get move base power with modifiers
 * @param attacker - Attacking Pokemon
 * @param defender - Defending Pokemon
 * @param move - Move being used
 * @param field - Field conditions
 * @returns Modified base power
 */
export function getModifiedBasePower(
	attacker: AIPokemon,
	defender: AIPokemon,
	move: AIMove,
	field: FieldConditions,
	context?: DamageContext
): number {
	// Dynamic-power moves can have a static Dex power of 0 (e.g. Flail and Crush Grip).
	let basePower = getVariableBasePower(attacker, defender, move, move.basePower, field, context);
	basePower = Math.floor(basePower * (move.typeChangeBoost || 1));
	if (basePower === 0) return 0;

	const moveId = toID(move.id);
	const attackerAbility = effectiveAbility(attacker, field);
	const defenderAbility = defensiveAbility(attacker, defender, move, field);

	// Ability-based power boosts
	// Technician
	if (attackerAbility === 'technician' && basePower <= 60) {
		basePower = Math.floor(basePower * 1.5);
	}

	// Iron Fist
	if (attackerAbility === 'ironfist' && move.flags['punch']) {
		basePower = Math.floor(basePower * 1.2);
	}

	// Reckless
	if (attackerAbility === 'reckless' && (move.recoil || moveId === 'jumpkick' || moveId === 'highjumpkick')) {
		basePower = Math.floor(basePower * 1.2);
	}

	// Sheer Force (boosts moves with secondary effects)
	if (attackerAbility === 'sheerforce' && move.secondaryChance > 0) {
		basePower = Math.floor(basePower * 1.3);
	}

	// Tough Claws
	if (attackerAbility === 'toughclaws' && move.flags['contact']) {
		basePower = Math.floor(basePower * 1.3);
	}

	// Strong Jaw
	if (attackerAbility === 'strongjaw' && move.flags['bite']) {
		basePower = Math.floor(basePower * 1.5);
	}

	// Mega Launcher
	if (attackerAbility === 'megalauncher' && move.flags['pulse']) {
		basePower = Math.floor(basePower * 1.5);
	}

	// Water Bubble (attacker)：水招式 ×2（CFRU damage_calc.c:3990）
	if (attackerAbility === 'waterbubble' && move.type === 'Water') {
		basePower = Math.floor(basePower * 2);
	}

	// Punk Rock (attacker)：声音招式 ×1.3（CFRU damage_calc.c:4002）
	if (attackerAbility === 'punkrock' && move.flags['sound']) {
		basePower = Math.floor(basePower * 1.3);
	}

	// Steelworker：钢系招式 ×1.5（CFRU damage_calc.c:3983）
	if (attackerAbility === 'steelworker' && move.type === 'Steel') {
		basePower = Math.floor(basePower * 1.5);
	}

	// Transistor：电系招式 ×1.5（CFRU damage_calc.c:4008）
	if (attackerAbility === 'transistor' && move.type === 'Electric') {
		basePower = Math.floor(basePower * 1.5);
	}

	// Dragon's Maw：龙系招式 ×1.5（CFRU damage_calc.c:4013）
	if (attackerAbility === 'dragonsmaw' && move.type === 'Dragon') {
		basePower = Math.floor(basePower * 1.5);
	}

	// Analytic estimates ordinary-priority order; a speed tie is not a confirmed second strike.
	if (attackerAbility === 'analytic' && compareSpeedOrder(attacker, defender, field,
		context?.attackerSideConditions, context?.defenderSideConditions) < 0) {
		basePower = Math.floor(basePower * 1.3);
	}

	// Weather effects on moves
	if (field.weather === 'sun') {
		if (move.type === 'Fire') basePower = Math.floor(basePower * 1.5);
		if (move.type === 'Water') basePower = Math.floor(basePower * 0.5);
	}
	if (field.weather === 'rain') {
		if (move.type === 'Water') basePower = Math.floor(basePower * 1.5);
		if (move.type === 'Fire') basePower = Math.floor(basePower * 0.5);
	}

	// Terrain boosts require the attacker to be grounded; Gen 6/7 use a 1.5 multiplier.
	if (grounded(attacker, field) && (
		(field.terrain === 'electric' && move.type === 'Electric') ||
		(field.terrain === 'grassy' && move.type === 'Grass') ||
		(field.terrain === 'psychic' && move.type === 'Psychic')
	)) basePower = Math.floor(basePower * (rulesDex(field).gen <= 7 ? 1.5 : 1.3));

	// Item modifiers
	const itemId = effectiveItem(attacker, field);

	// Type-boosting items (simplified - just checking common ones)
	const typeBoostItems: { [key: string]: string } = {
		'charcoal': 'Fire',
		'mysticwater': 'Water',
		'magnet': 'Electric',
		'miracleseed': 'Grass',
		'nevermeltice': 'Ice',
		'blackbelt': 'Fighting',
		'poisonbarb': 'Poison',
		'softsand': 'Ground',
		'sharpbeak': 'Flying',
		'twistedspoon': 'Psychic',
		'silverpowder': 'Bug',
		'hardstone': 'Rock',
		'spelltag': 'Ghost',
		'dragonfang': 'Dragon',
		'blackglasses': 'Dark',
		'metalcoat': 'Steel',
		'silkscarf': 'Normal',
		'pixieplate': 'Fairy',
	};

	if (typeBoostItems[itemId] === move.type) {
		basePower = Math.floor(basePower * 1.2);
	}

	// Defensive ability reductions
	if (defenderAbility === 'thickfat' && (move.type === 'Fire' || move.type === 'Ice')) {
		basePower = Math.floor(basePower * 0.5);
	}

	if (defenderAbility === 'heatproof' && move.type === 'Fire') {
		basePower = Math.floor(basePower * 0.5);
	}

	if (defenderAbility === 'waterbubble' && move.type === 'Fire') {
		basePower = Math.floor(basePower * 0.5);
	}

	const data = rulesDex(field).moves.get(move.id);
	if (attacker.terastallized && (attacker.terastallized === 'Stellar' ?
		!attacker.stellarBoostedTypes?.includes(move.type) : attacker.types.includes(move.type)) &&
		basePower < 60 && data.priority <= 0 && !data.multihit &&
		!((data.basePower === 0 || data.basePower === 150) && data.basePowerCallback)) basePower = 60;
	return basePower;
}

/**
 * Handle variable base power moves
 */
function getVariableBasePower(
	attacker: AIPokemon,
	defender: AIPokemon,
	move: AIMove,
	basePower: number,
	field: FieldConditions,
	context?: DamageContext
): number {
	const moveId = toID(move.id);
	const attackerHp = attacker.maxHp > 0 ? attacker.hp : attacker.hpPercent;
	const attackerMaxHp = attacker.maxHp || 100;
	const defenderHp = defender.maxHp > 0 ? defender.hp : defender.hpPercent;
	const defenderMaxHp = defender.maxHp || 100;

	if (moveId === 'ragefist') return Math.min(350, 50 * (1 + (attacker.timesAttacked || 0)));
	if (moveId === 'lastrespects') return 50 * (1 + Math.min(100, attacker.faintedAllies || 0));
	if (moveId === 'spitup') {
		const layers = [...attacker.volatiles].find(v => /^stockpile[1-3]$/.test(v));
		return 100 * Number(layers?.slice(-1) || 0);
	}
	if (moveId === 'terablast' && attacker.terastallized === 'Stellar') return 100;
	if (moveId === 'risingvoltage' && field.terrain === 'electric' && grounded(defender, field)) return basePower * 2;
	if (moveId === 'expandingforce' && field.terrain === 'psychic' && grounded(attacker, field)) return basePower * 1.5;
	if (moveId === 'psyblade' && field.terrain === 'electric') return basePower * 1.5;

	// Resolve current HP at decision time, including damage already taken on switching in.
	if (moveId === 'waterspout' || moveId === 'eruption' || moveId === 'dragonenergy') {
		return Math.max(1, Math.floor(basePower * attackerHp / attackerMaxHp));
	}

	if (moveId === 'flail' || moveId === 'reversal') {
		const ratio = Math.max(Math.floor(attackerHp * 48 / attackerMaxHp), 1);
		if (ratio < 2) return 200;
		if (ratio < 5) return 150;
		if (ratio < 10) return 100;
		if (ratio < 17) return 80;
		if (ratio < 33) return 40;
		return 20;
	}

	if (moveId === 'crushgrip' || moveId === 'wringout' || moveId === 'hardpress') {
		const maxPower = moveId === 'hardpress' ? 100 : 120;
		// Match the simulator's fixed-point rounding, including the minimum power of 1.
		const hp = Math.floor(defenderHp * 4096 / defenderMaxHp);
		return Math.max(1, Math.floor(Math.floor((maxPower * 100 * hp + 2047) / 4096) / 100));
	}

	// Facade excludes sleep, unlike Guts and Hex.
	if (moveId === 'facade' && attacker.status && attacker.status !== 'slp') {
		return basePower * 2;
	}

	// Hex: doubles when target is statused
	if (moveId === 'hex' && defender.status) {
		return basePower * 2;
	}

	// Venoshock: doubles when target is poisoned
	if (moveId === 'venoshock' && (defender.status === 'psn' || defender.status === 'tox')) {
		return basePower * 2;
	}

	// Brine: doubles when target is below 50% HP
	if (moveId === 'brine' && defenderHp * 2 <= defenderMaxHp) {
		return basePower * 2;
	}

	// Low Kick / Grass Knot: based on target's weight
	// CFRU damage_calc.c lines 3521-3539
	if (moveId === 'lowkick' || moveId === 'grassknot') {
		return getWeightBasedPower(
			defender.species, defensiveAbility(attacker, defender, move, field), effectiveItem(defender, field)
		);
	}

	// Heavy Slam / Heat Crash: based on weight ratio (attacker / defender)
	// CFRU damage_calc.c lines 3542-3569
	if (moveId === 'heavyslam' || moveId === 'heatcrash') {
		return getWeightRatioPower(
			attacker.species, effectiveAbility(attacker, field), effectiveItem(attacker, field),
			defender.species, defensiveAbility(attacker, defender, move, field), effectiveItem(defender, field)
		);
	}

	// Gyro Ball uses effective speed, not action order (Trick Room does not invert the ratio).
	if (moveId === 'gyroball') {
		const speedRatio = getEffectiveSpeed(defender, field, context?.defenderSideConditions) /
			getEffectiveSpeed(attacker, field, context?.attackerSideConditions);
		return Math.min(150, Math.floor(25 * speedRatio) + 1);
	}

	// Electro Ball uses the same effective speed as action ordering.
	if (moveId === 'electroball') {
		const speedRatio = getEffectiveSpeed(attacker, field, context?.attackerSideConditions) /
			getEffectiveSpeed(defender, field, context?.defenderSideConditions);
		if (speedRatio >= 4) return 150;
		if (speedRatio >= 3) return 120;
		if (speedRatio >= 2) return 80;
		if (speedRatio >= 1) return 60;
		return 40;
	}

	// Stored Power / Power Trip: based on boosts
	if (moveId === 'storedpower' || moveId === 'powertrip') {
		let totalBoosts = 0;
		for (const stat of ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'] as const) {
			if (attacker.boosts[stat] > 0) {
				totalBoosts += attacker.boosts[stat];
			}
		}
		return 20 + 20 * totalBoosts;
	}

	// Acrobatics: doubles without item
	if (moveId === 'acrobatics' && (activatesGem(attacker, move, field) ||
		!attacker.item && (attacker.itemKnown || attacker.itemLost || attacker.itemAssumed))) {
		return 110;
	}

	// Gen 5 and MMO retain 20-power Knock Off without the modern item boost.
	if (moveId === 'fling') {
		return flingFailure(attacker, move, field) ? 0 : rulesDex(field).items.get(attacker.item).fling!.basePower;
	}
	if (moveId === 'naturalgift') {
		return rulesDex(field).items.get(effectiveItem(attacker, field)).naturalGift?.basePower || 0;
	}
	if (moveId === 'knockoff' && basePower === 65 && defender.item && !defender.itemLost &&
		itemAllowsRemoval(defender, defender, move, field)) {
		return Math.floor(basePower * 1.5);
	}

	if (moveId === 'terrainpulse' && field.terrain && grounded(attacker, field)) return 100;

	// Weather Ball: type and power change in weather
	if (moveId === 'weatherball') {
		return field.weather && field.weatherId !== 'deltastream' ? 100 : 50;
	}

	return basePower;
}

/**
 * 计算固定伤害招式（CFRU damage_calc.c:484-564）。
 *
 * PS 把这些招的 basePower 存成 0 并用 damageCallback 在运行时决定伤害；AI 侧
 * 没有 damageCallback，所以必须自己识别招式 ID 并输出一个合理的"min/max 伤害估算"。
 *
 * 返回 null 表示"这不是固定伤害招，走常规公式"；返回数字对象表示"用这个 min/max 直接出结果"。
 *
 * 当前覆盖：
 *   - Seismic Toss / Night Shade: 等于攻击方等级
 *   - Dragon Rage: 固定 40
 *   - Sonic Boom: 固定 20
 *   - Super Fang / Nature's Madness / Ruination: 对手当前 HP 的 50%
 *   - Guardian of Alola: 对手当前 HP 的 75%，保护状态下再减伤
 *   - Endeavor: 把对手 HP 降到和自己一样（即 defHp - atkHp，<=0 则不打）
 *   - Final Gambit: 自己当前 HP（并且自己也会倒）
 *   - Psywave: 等级 × [0.5, 1.5]，min=level/2，max=level*3/2
 *   - Counter: 本回合受到的物理伤害 × 2
 *   - Mirror Coat: 本回合受到的特殊伤害 × 2
 *   - Metal Burst: 本回合受到的任意伤害 × 1.5
 *
 * 反击伤害优先根据上一招预测，否则使用公开招式及兼容配置中的对应攻击估算。
 */
export function computeFixedDamage(
	attacker: AIPokemon,
	defender: AIPokemon,
	move: AIMove,
	cache?: AICache,
	field?: FieldConditions
): { min: number; max: number } | null {
	const moveId = toID(move.id);
	const level = attacker.level || 100;
	const defenderCurHp = defender.hp;

	switch (moveId) {
	case 'seismictoss':
	case 'nightshade':
		return { min: level, max: level };
	case 'dragonrage':
		return { min: 40, max: 40 };
	case 'sonicboom':
		return { min: 20, max: 20 };
	case 'superfang':
	case 'naturesmadness':
	case 'ruination': {
		const dmg = Math.max(1, Math.floor(defenderCurHp / 2));
		return { min: dmg, max: dmg };
	}
	case 'guardianofalola': {
		let dmg = Math.floor(defenderCurHp * 3 / 4);
		if (['protect', 'banefulbunker', 'kingsshield', 'spikyshield', 'matblock'].some(v => defender.volatiles.has(v))) {
			dmg = Math.ceil(dmg / 4 - 0.5);
		}
		dmg = Math.max(1, dmg);
		return { min: dmg, max: dmg };
	}
	case 'endeavor': {
		const attackerCurHp = attacker.hp;
		if (defenderCurHp <= attackerCurHp) return { min: 0, max: 0 };
		const dmg = defenderCurHp - attackerCurHp;
		return { min: dmg, max: dmg };
	}
	case 'finalgambit':
		// 用光自己当前 HP，造成等量伤害；类型免疫由 calculateDamage 处理。
		return { min: attacker.hp, max: attacker.hp };
	case 'psywave':
		return { min: Math.max(1, Math.floor(level / 2)), max: Math.floor(level * 3 / 2) };
	case 'counter':
	case 'mirrorcoat':
	case 'metalburst': {
		const needPhysical = moveId === 'counter';
		const needSpecial = moveId === 'mirrorcoat';
		const knowledge = defender.moveKnowledge;
		const candidates = [...defender.moves, ...(knowledge?.revealedMoves || []),
			...(knowledge?.presetCandidates.filter(id => canHaveOpponentMoves(knowledge, [id])) || [])];
		const eligible = (id: string) => {
			const candidate = rulesDex(field || {}).moves.get(id);
			return candidate.exists && candidate.category !== 'Status' &&
				!['counter', 'mirrorcoat', 'metalburst'].includes(candidate.id) &&
				(!needPhysical || candidate.category === 'Physical') &&
				(!needSpecial || candidate.category === 'Special');
		};
		const attacks = defender.lastMove && eligible(defender.lastMove) ? [defender.lastMove] :
			[...new Set(candidates)].filter(eligible);
		if (!attacks.length) return { min: 0, max: 0 };
		const currentField = field || {
			weather: '', weatherTurns: -1, terrain: '', terrainTurns: -1,
			trickroom: false, trickroomTurns: 0, gravity: false, magicroom: false, wonderroom: false,
		};
		let best = { min: 0, max: 0 };
		for (const id of attacks) {
			const lastDex = rulesDex(currentField).moves.get(id);

			// 反向估算候选攻击造成的伤害；候选中排除反击类招式以避免递归。
			const simulatedMove: AIMove = {
				id: lastDex.id,
				name: lastDex.name,
				slot: 0,
				type: lastDex.type,
				category: lastDex.category,
				basePower: lastDex.basePower,
				accuracy: lastDex.accuracy,
				pp: lastDex.pp,
				maxPp: lastDex.pp,
				priority: lastDex.priority || 0,
				target: lastDex.target || 'normal',
				flags: lastDex.flags || {},
				status: lastDex.status,
				boosts: lastDex.boosts,
				recoil: lastDex.recoil,
				secondaryChance: lastDex.secondary?.chance || 0,
				disabled: false,
				isZMove: false,
				isMaxMove: false,
				multihit: lastDex.multihit || null,
			};
			// 使用当前场地计算对方候选攻击的伤害
			// 不复用 cache（defender/attacker 对调会导致 cache key 碰撞）
			const incoming = calculateDamage(defender, attacker, simulatedMove, currentField);
			const multiplier = moveId === 'metalburst' ? 1.5 : 2;
			const min = Math.floor(incoming.min * multiplier);
			const max = Math.floor(incoming.max * multiplier);
			if (min + max > best.min + best.max) best = { min, max };
		}
		return best;
	}
	}
	return null;
}

/**
 * Calculate damage for a move
 * @param attacker - Attacking Pokemon
 * @param defender - Defending Pokemon
 * @param move - Move being used
 * @param field - Field conditions
 * @param cache - Optional cache for memoization
 * @param spreadInfo - Optional spread move info for doubles/multi (CFRU: damage_calc.c:3239-3247)
 * @returns Damage calculation result
 */
export function calculateDamage(
	attacker: AIPokemon,
	defender: AIPokemon,
	move: AIMove,
	field: FieldConditions,
	cache?: AICache,
	spreadInfo?: DamageContext
): DamageResult {
	move = resolveMove(attacker, move, field, defender);
	// HP-dependent power, fixed damage and KO flags must reflect the current snapshot.
	const spreadKey = spreadInfo?.isDoubles ? `-spread${spreadInfo.numAliveTargets}` : '';
	const protectionKey = `${spreadInfo?.isAllyTarget}-${spreadInfo?.defenderAllies?.map(pokemonCacheId).join(',')}` +
		`-${spreadInfo?.activePokemon?.map(pokemonCacheId).join(',')}`;
	const hpKey = `${attacker.hp}/${attacker.maxHp}-${defender.hp}/${defender.maxHp}`;
	const cacheKey = `${pokemonCacheId(attacker)}-${pokemonCacheId(defender)}-${move.id}-${move.type}-${move.basePower}` +
		`-${hpKey}${spreadKey}-${protectionKey}-${JSON.stringify(field)}` +
		JSON.stringify([spreadInfo?.attackerSideConditions, spreadInfo?.defenderSideConditions]);
	if (cache?.damageCalc.has(cacheKey)) {
		return cache.damageCalc.get(cacheKey)!;
	}

	// Status moves do no damage
	if (move.category === 'Status') {
		const result: DamageResult = {
			min: 0,
			max: 0,
			average: 0,
			minPercent: 0,
			maxPercent: 0,
			averagePercent: 0,
			effectiveness: 1,
			canKO: false,
			guaranteedKO: false,
			hitsToKO: Infinity,
		};
		if (cache) cache.damageCalc.set(cacheKey, result);
		return result;
	}

	const interaction = getMoveInteraction(attacker, defender, move, field, spreadInfo);
	const effectiveness = interaction.effectiveness;
	if (interaction.blockedBy) {
		const result: DamageResult = {
			min: 0, max: 0, average: 0, minPercent: 0, maxPercent: 0, averagePercent: 0,
			effectiveness: 0, canKO: false, guaranteedKO: false, hitsToKO: Infinity,
		};
		if (cache) cache.damageCalc.set(cacheKey, result);
		return result;
	}

	// Damage describes a successful hit. A previous move does not determine the next
	// action, so conditional attacks such as Sucker Punch must not fabricate failure.

	// 固定伤害招式（Seismic Toss / Super Fang / Counter 等）在走常规公式前直接出结果
	const fixed = computeFixedDamage(attacker, defender, move, cache, field);
	if (fixed) {
		const defenderMaxHp = defender.maxHp || Math.floor(defender.hp / Math.max(defender.hpPercent, 1) * 100);
		const currentHp = Math.floor(defenderMaxHp * defender.hpPercent / 100);
		const avg = Math.floor((fixed.min + fixed.max) / 2);
		let hitsToKO = avg > 0 ? Math.ceil(currentHp / avg) : Infinity;
		if (['superfang', 'naturesmadness', 'ruination'].includes(move.id)) {
			// Each hit uses the remaining HP, not the first hit's damage.
			let remaining = currentHp;
			hitsToKO = 0;
			while (remaining > 0) {
				remaining -= Math.max(1, Math.floor(remaining / 2));
				hitsToKO++;
			}
		} else if (['endeavor', 'guardianofalola', 'finalgambit'].includes(move.id) && avg < currentHp) {
			// Endeavor stops at our HP; Z-Moves and self-sacrifice cannot be repeated.
			hitsToKO = Infinity;
		}
		const result: DamageResult = {
			min: fixed.min,
			max: fixed.max,
			average: avg,
			minPercent: defenderMaxHp > 0 ? (fixed.min / defenderMaxHp) * 100 : 0,
			maxPercent: defenderMaxHp > 0 ? (fixed.max / defenderMaxHp) * 100 : 0,
			averagePercent: defenderMaxHp > 0 ? (avg / defenderMaxHp) * 100 : 0,
			effectiveness: 1, // Immunities were checked above; fixed damage ignores resistance and weakness.
			canKO: fixed.max >= currentHp,
			guaranteedKO: fixed.min >= currentHp,
			hitsToKO,
		};
		if (cache) cache.damageCalc.set(cacheKey, result);
		return result;
	}

	// Get stats
	const attack = getAttackStat(attacker, move, field, defender);
	const defense = getDefenseStat(defender, move, field, defensiveAbility(attacker, defender, move, field), attacker);
	const basePower = getModifiedBasePower(attacker, defender, move, field, spreadInfo);

	// DEBUG: Uncomment to debug damage calculation inputs
	// const isPhysical = move.category === 'Physical';
	// console.log(`[DEBUG] Damage Calc: ${attacker.species} (Lv${attacker.level || 100}) -> ${defender.species} (Lv${defender.level || 100})`);
	// console.log(`[DEBUG]   Move: ${move.name} (${move.category}, BP=${move.basePower}, modifiedBP=${basePower})`);
	// console.log(`[DEBUG]   Attacker baseStats: ATK=${attacker.baseStats.atk}, SPA=${attacker.baseStats.spa}`);
	// console.log(`[DEBUG]   Defender baseStats: DEF=${defender.baseStats.def}, SPD=${defender.baseStats.spd}, HP=${defender.baseStats.hp}`);
	// console.log(`[DEBUG]   Attacker boosts: ${isPhysical ? 'atk' : 'spa'}=${isPhysical ? attacker.boosts.atk : attacker.boosts.spa}`);
	// console.log(`[DEBUG]   Defender boosts: ${isPhysical ? 'def' : 'spd'}=${isPhysical ? defender.boosts.def : defender.boosts.spd}`);
	// console.log(`[DEBUG]   Attack stat used: ${attack}, Defense stat used: ${defense}`);
	// console.log(`[DEBUG]   Type effectiveness: ${effectiveness}`);

	if (basePower === 0) {
		const result: DamageResult = {
			min: 0,
			max: 0,
			average: 0,
			minPercent: 0,
			maxPercent: 0,
			averagePercent: 0,
			effectiveness: effectiveness,
			canKO: false,
			guaranteedKO: false,
			hitsToKO: Infinity,
		};
		if (cache) cache.damageCalc.set(cacheKey, result);
		return result;
	}

	const hitDamage = (power: number): number => {
		if (activatesGem(attacker, move, field)) {
			const dex = rulesDex(field);
			power = Math.round(power * (dex.gen <= 5 || dex.currentMod === 'mmo' ? 1.5 : 5325 / 4096));
		}
		// Base damage formula
		const level = attacker.level || 100;
		let baseDamage = Math.floor(Math.floor(Math.floor(2 * level / 5 + 2) * power * attack / defense) / 50 + 2);

		// STAB
		const stabMultiplier = getSTABMultiplier(move.type, attacker.types, effectiveAbility(attacker, field), attacker);
		baseDamage = Math.floor(baseDamage * stabMultiplier);

		// Type effectiveness
		baseDamage = Math.floor(baseDamage * effectiveness);

		// 以下这些乘数依赖 "是否超效 / 是否被抵抗" 的判断，必须在 effectiveness 相乘之后
		const atkAbilityId = effectiveAbility(attacker, field);
		const defAbilityId = defensiveAbility(attacker, defender, move, field);

		// Tinted Lens (attacker)：抵抗招式伤害 ×2（CFRU damage_calc.c:3107）
		if (atkAbilityId === 'tintedlens' && effectiveness < 1 && effectiveness > 0) {
			baseDamage = Math.floor(baseDamage * 2);
		}

		// Neuroforce (attacker)：超效招式 ×1.25（CFRU damage_calc.c:3971）
		if (atkAbilityId === 'neuroforce' && effectiveness > 1) {
			baseDamage = Math.floor(baseDamage * 1.25);
		}

		// Filter / Solid Rock / Prism Armor (defender)：超效伤害 ×0.75（CFRU damage_calc.c:3136-3139）
		if ((defAbilityId === 'filter' || defAbilityId === 'solidrock' || defAbilityId === 'prismarmor') && effectiveness > 1) {
			baseDamage = Math.floor(baseDamage * 0.75);
		}

		// Fluffy (defender)：火招式 ×2 / 接触招式 ×0.5（两条可叠加，CFRU damage_calc.c:3159）
		if (defAbilityId === 'fluffy') {
			if (move.type === 'Fire') baseDamage = Math.floor(baseDamage * 2);
			if (move.flags['contact']) baseDamage = Math.floor(baseDamage * 0.5);
		}

		// Ice Scales (defender)：特殊招式 ×0.5（CFRU damage_calc.c:3175）
		if (defAbilityId === 'icescales' && move.category === 'Special') {
			baseDamage = Math.floor(baseDamage * 0.5);
		}

		// Punk Rock (defender)：声音招式 ×0.5（CFRU damage_calc.c:3169）
		if (defAbilityId === 'punkrock' && move.flags['sound']) {
			baseDamage = Math.floor(baseDamage * 0.5);
		}

		// 半减果 / 抵抗果：对应属性超效时 ×0.5（CFRU damage_calc.c:3188）。
		// 只有一发消耗型；defender.itemLost 为真说明道具已被打掉。
		if (effectiveness > 1 && !defender.itemLost) {
			const berry = effectiveItem(defender, field);
			if (RESIST_BERRY_TYPES[berry] === move.type) {
				baseDamage = Math.floor(baseDamage * 0.5);
			}
		}
		// Chilan Berry 特殊：Normal 招式无条件 ×0.5（不要求超效）
		if (!defender.itemLost && effectiveItem(defender, field) === 'chilanberry' && move.type === 'Normal') {
			baseDamage = Math.floor(baseDamage * 0.5);
		}

		// Burn penalty (physical moves, except Guts/Facade)
		if (attacker.status === 'brn' && move.category === 'Physical' &&
			effectiveAbility(attacker, field) !== 'guts' &&
			!(move.id === 'facade' && (rulesDex(field).gen >= 6 || rulesDex(field).currentMod === 'mmo'))) {
			baseDamage = Math.floor(baseDamage * 0.5);
		}

		// Life Orb
		if (effectiveItem(attacker, field) === 'lifeorb') {
			baseDamage = Math.floor(baseDamage * 1.3);
		}

		// Expert Belt
		if (effectiveItem(attacker, field) === 'expertbelt' && effectiveness > 1) {
			baseDamage = Math.floor(baseDamage * 1.2);
		}

		const conditions = spreadInfo?.defenderSideConditions;
		const screen = conditions?.auroraveil || (move.category === 'Physical' ?
			conditions?.reflect || defender.volatiles.has('reflect') :
			conditions?.lightscreen || defender.volatiles.has('lightscreen'));
		if (screen && effectiveAbility(attacker, field) !== 'infiltrator' &&
			!['brickbreak', 'psychicfangs', 'ragingbull'].includes(move.id)) {
			baseDamage = Math.floor(baseDamage * (spreadInfo?.isDoubles ? 2 / 3 : 0.5));
		}

		// Spread Move Cut (CFRU: damage_calc.c:3239-3247)
		// In doubles/multi, spread moves deal 75% damage when hitting multiple targets
		if (spreadInfo?.isDoubles && spreadInfo.numAliveTargets >= 2) {
			const moveTarget = move.target;
			// MOVE_TARGET_BOTH = allAdjacentFoes (Earthquake, Heat Wave, etc.)
			// MOVE_TARGET_FOES_AND_ALLY = allAdjacent (Surf, Boomburst, etc.)
			if (moveTarget === 'allAdjacentFoes' || moveTarget === 'allAdjacent') {
				baseDamage = Math.floor(baseDamage * 0.75);
			}
		}

		return baseDamage;
	};

	// Get multi-hit count
	const hitCount = getExpectedHitCount(move, effectiveAbility(attacker, field),
		effectiveItem(attacker, field), attacker.species);

	const increasing = ['tripleaxel', 'triplekick'].includes(move.calledMove || move.id);
	const defenderAbility = defensiveAbility(attacker, defender, move, field);
	const firstHitHalved = defender.hpPercent >= 100 &&
		['multiscale', 'shadowshield'].includes(defenderAbility);
	let minDamage = 0;
	let maxDamage = 0;
	for (let hit = 1; hit <= Math.ceil(hitCount); hit++) {
		const power = increasing ? getModifiedBasePower(attacker, defender,
			{ ...move, basePower: move.basePower * hit }, field, spreadInfo) : basePower;
		const damage = hitDamage(power);
		const weight = Math.min(1, hitCount - hit + 1);
		const reduction = hit === 1 && firstHitHalved ? 0.5 : 1;
		minDamage += Math.floor(Math.floor(damage * MIN_ROLL) * reduction * weight);
		maxDamage += Math.floor(Math.floor(damage * MAX_ROLL) * reduction * weight);
	}

	const avgDamage = Math.floor((minDamage + maxDamage) / 2);

	// Calculate HP percentages
	const defenderMaxHp = defender.maxHp || Math.floor(defender.hp / (defender.hpPercent / 100));
	const currentHp = Math.floor(defenderMaxHp * defender.hpPercent / 100);

	const minPercent = defenderMaxHp > 0 ? (minDamage / defenderMaxHp) * 100 : 0;
	const maxPercent = defenderMaxHp > 0 ? (maxDamage / defenderMaxHp) * 100 : 0;
	const avgPercent = defenderMaxHp > 0 ? (avgDamage / defenderMaxHp) * 100 : 0;

	// DEBUG: Uncomment to debug damage calculation results
	// console.log(`[DEBUG]   Defender HP: ${currentHp}/${defenderMaxHp} (${defender.hpPercent}%)`);
	// console.log(`[DEBUG]   Damage: ${minDamage}-${maxDamage} (avg ${avgDamage}), ${avgPercent.toFixed(1)}%`);

	// KO checks
	const canKO = maxDamage >= currentHp;
	const guaranteedKO = minDamage >= currentHp;

	// Hits to KO (using average damage)
	const hitsToKO = avgDamage > 0 ? Math.ceil(currentHp / avgDamage) : Infinity;

	const result: DamageResult = {
		min: minDamage,
		max: maxDamage,
		average: avgDamage,
		minPercent,
		maxPercent,
		averagePercent: avgPercent,
		effectiveness,
		canKO,
		guaranteedKO,
		hitsToKO,
	};

	// Cache result
	if (cache) {
		cache.damageCalc.set(cacheKey, result);
	}

	return result;
}

/**
 * Check if a move can knock out the target
 * Based on CFRU CanKnockOut function
 */
export function canKnockOut(
	attacker: AIPokemon,
	defender: AIPokemon,
	move: AIMove,
	field: FieldConditions,
	cache?: AICache
): boolean {
	const damage = calculateDamage(attacker, defender, move, field, cache);
	return damage.canKO;
}

/**
 * Check if a move can 2HKO the target
 * Based on CFRU Can2HKO function
 */
export function can2HKO(
	attacker: AIPokemon,
	defender: AIPokemon,
	move: AIMove,
	field: FieldConditions,
	cache?: AICache
): boolean {
	const damage = calculateDamage(attacker, defender, move, field, cache);
	return damage.hitsToKO <= 2;
}

/**
 * Calculate how many hits are needed to KO
 * Based on CFRU MoveKnocksOutXHits function
 */
export function hitsToKnockOut(
	attacker: AIPokemon,
	defender: AIPokemon,
	move: AIMove,
	field: FieldConditions,
	cache?: AICache
): number {
	const damage = calculateDamage(attacker, defender, move, field, cache);
	return damage.hitsToKO;
}

/**
 * Find the strongest damage move against a target
 */
export function findStrongestMove(
	attacker: AIPokemon,
	defender: AIPokemon,
	moves: AIMove[],
	field: FieldConditions,
	cache?: AICache
): { move: AIMove; damage: DamageResult } | null {
	let best: { move: AIMove; damage: DamageResult } | null = null;

	for (const candidate of moves) {
		const move = resolveMove(attacker, candidate, field, defender);
		if (move.category === 'Status' || move.disabled) continue;

		const damage = calculateDamage(attacker, defender, move, field, cache);

		if (!best || damage.average > best.damage.average) {
			best = { move, damage };
		}
	}

	return best;
}

// =============================================================================
// Secondary Effect Damage (End-of-turn damage)
// Based on CFRU ai_util.c GetSecondaryEffectDamage and CalcSecondaryEffectDamage
// =============================================================================

/**
 * Calculate poison damage at end of turn
 * Based on CFRU end_turn.c GetPoisonDamage
 * @param pokemon - Pokemon taking damage
 * @param forAI - If true, estimate next turn's toxic damage
 * @returns Damage amount
 */
export function getPoisonDamage(pokemon: AIPokemon, forAI = true, field?: FieldConditions): number {
	const abilityId = effectiveAbility(pokemon, field);

	// Magic Guard and Poison Heal prevent poison damage
	if (abilityId === 'magicguard' || abilityId === 'poisonheal') {
		return 0;
	}

	const maxHp = pokemon.maxHp || Math.floor(pokemon.hp / (pokemon.hpPercent / 100));

	// Regular poison: 1/8 max HP
	if (pokemon.status === 'psn') {
		return Math.max(1, Math.floor(maxHp / 8));
	}

	// Toxic poison: 1/16 * turn multiplier
	if (pokemon.status === 'tox') {
		const baseDamage = Math.max(1, Math.floor(maxHp / 16));
		// Number of completed public poison ticks during this stay; next tick starts at 1.
		const toxicCounter = Math.max(1, (pokemon.toxicCounter || 0) + (forAI ? 1 : 0));
		return baseDamage * Math.min(toxicCounter, 15);
	}

	return 0;
}

/**
 * Calculate burn damage at end of turn
 * Based on CFRU end_turn.c GetBurnDamage
 * @param pokemon - Pokemon taking damage
 * @returns Damage amount
 */
export function getBurnDamage(pokemon: AIPokemon, field?: FieldConditions): number {
	const abilityId = effectiveAbility(pokemon, field);

	// Magic Guard prevents burn damage
	if (abilityId === 'magicguard') {
		return 0;
	}

	if (pokemon.status !== 'brn') {
		return 0;
	}

	const maxHp = pokemon.maxHp || Math.floor(pokemon.hp / (pokemon.hpPercent / 100));

	const dex = rulesDex(field || {});
	const divisor = dex.gen < 7 && dex.currentMod !== 'mmo' ? 8 : 16;
	return Math.max(1, Math.floor(maxHp / (abilityId === 'heatproof' ? divisor * 2 : divisor)));
}

/**
 * Calculate sandstorm damage at end of turn
 * Based on CFRU general_bs_commands.c GetSandstormDamage
 * @param pokemon - Pokemon taking damage
 * @param weather - Current weather
 * @returns Damage amount
 */
export function getSandstormDamage(pokemon: AIPokemon, weather: string, field?: FieldConditions): number {
	if (weather !== 'sand' && weather !== 'sandstorm') {
		return 0;
	}

	const abilityId = effectiveAbility(pokemon, field);

	// Magic Guard prevents weather damage
	if (abilityId === 'magicguard') {
		return 0;
	}

	// Types and abilities that are immune to sandstorm
	if (pokemon.types.includes('Rock') ||
		pokemon.types.includes('Ground') ||
		pokemon.types.includes('Steel')) {
		return 0;
	}

	// Abilities that provide sandstorm immunity
	const immuneAbilities = ['sandveil', 'sandrush', 'sandforce', 'overcoat'];
	if (immuneAbilities.includes(abilityId)) {
		return 0;
	}

	// Safety Goggles blocks weather damage
	if (effectiveItem(pokemon, field) === 'safetygoggles') {
		return 0;
	}

	const maxHp = pokemon.maxHp || Math.floor(pokemon.hp / (pokemon.hpPercent / 100));

	// Sandstorm: 1/16 max HP
	return Math.max(1, Math.floor(maxHp / 16));
}

/**
 * Calculate hail damage at end of turn
 * Based on CFRU general_bs_commands.c GetHailDamage
 * @param pokemon - Pokemon taking damage
 * @param weather - Current weather
 * @returns Damage amount
 */
export function getHailDamage(pokemon: AIPokemon, weather: string, field?: FieldConditions): number {
	// Hail or Snow (snow doesn't do damage in Gen 9+, but older gens it does)
	if (weather !== 'hail') {
		return 0;
	}

	const abilityId = effectiveAbility(pokemon, field);

	// Magic Guard prevents weather damage
	if (abilityId === 'magicguard') {
		return 0;
	}

	// Ice types are immune
	if (pokemon.types.includes('Ice')) {
		return 0;
	}

	// Abilities that provide hail immunity
	const immuneAbilities = ['snowcloak', 'slushrush', 'icebody', 'overcoat'];
	if (immuneAbilities.includes(abilityId)) {
		return 0;
	}

	// Safety Goggles blocks weather damage
	if (effectiveItem(pokemon, field) === 'safetygoggles') {
		return 0;
	}

	const maxHp = pokemon.maxHp || Math.floor(pokemon.hp / (pokemon.hpPercent / 100));

	// Hail: 1/16 max HP
	return Math.max(1, Math.floor(maxHp / 16));
}

/**
 * Calculate leech seed damage at end of turn
 * Based on CFRU end_turn.c GetLeechSeedDamage
 * @param pokemon - Pokemon taking damage
 * @returns Damage amount
 */
export function getLeechSeedDamage(pokemon: AIPokemon, field?: FieldConditions): number {
	const abilityId = effectiveAbility(pokemon, field);

	// Magic Guard prevents leech seed damage
	if (abilityId === 'magicguard') {
		return 0;
	}

	// Check if seeded (via volatiles)
	if (!pokemon.volatiles.has('leechseed')) {
		return 0;
	}

	const maxHp = pokemon.maxHp || Math.floor(pokemon.hp / (pokemon.hpPercent / 100));

	// Leech Seed: 1/8 max HP
	return Math.max(1, Math.floor(maxHp / 8));
}

/**
 * Calculate trap damage (Bind, Wrap, Fire Spin, etc.) at end of turn
 * @param pokemon - Pokemon taking damage
 * @returns Damage amount
 */
export function getTrapDamage(pokemon: AIPokemon, field?: FieldConditions): number {
	const abilityId = effectiveAbility(pokemon, field);

	// Magic Guard prevents trap damage
	if (abilityId === 'magicguard') {
		return 0;
	}

	// Check if trapped (via volatiles - partialtrap)
	if (!pokemon.volatiles.has('partiallytrapped')) {
		return 0;
	}

	const maxHp = pokemon.maxHp || Math.floor(pokemon.hp / (pokemon.hpPercent / 100));

	// Use the ruleset baseline when no trapping-item modifier has been observed.
	const dex = rulesDex(field || {});
	return Math.max(1, Math.floor(maxHp / (dex.gen <= 5 && dex.currentMod !== 'mmo' ? 16 : 8)));
}

/**
 * Calculate curse (ghost) damage at end of turn
 * @param pokemon - Pokemon taking damage
 * @returns Damage amount
 */
export function getCurseDamage(pokemon: AIPokemon, field?: FieldConditions): number {
	const abilityId = effectiveAbility(pokemon, field);

	// Magic Guard prevents curse damage
	if (abilityId === 'magicguard') {
		return 0;
	}

	// Check if cursed (via volatiles)
	if (!pokemon.volatiles.has('curse')) {
		return 0;
	}

	const maxHp = pokemon.maxHp || Math.floor(pokemon.hp / (pokemon.hpPercent / 100));

	// Curse: 1/4 max HP
	return Math.max(1, Math.floor(maxHp / 4));
}

/**
 * Calculate nightmare damage at end of turn
 * @param pokemon - Pokemon taking damage
 * @returns Damage amount
 */
export function getNightmareDamage(pokemon: AIPokemon, field?: FieldConditions): number {
	const abilityId = effectiveAbility(pokemon, field);

	// Magic Guard prevents nightmare damage
	if (abilityId === 'magicguard') {
		return 0;
	}

	// Nightmare only works when asleep
	if (pokemon.status !== 'slp') {
		return 0;
	}

	// Check if nightmare (via volatiles)
	if (!pokemon.volatiles.has('nightmare')) {
		return 0;
	}

	const maxHp = pokemon.maxHp || Math.floor(pokemon.hp / (pokemon.hpPercent / 100));

	// Nightmare: 1/4 max HP
	return Math.max(1, Math.floor(maxHp / 4));
}

/**
 * Calculate Salt Cure damage at end of turn
 * Gen 9 move: 1/8 max HP normally, 1/4 max HP for Water/Steel types
 * @param pokemon - Pokemon taking damage
 * @returns Damage amount
 */
export function getSaltCureDamage(pokemon: AIPokemon, field?: FieldConditions): number {
	const abilityId = effectiveAbility(pokemon, field);

	// Magic Guard prevents Salt Cure damage
	if (abilityId === 'magicguard') {
		return 0;
	}

	// Check if salt cured (via volatiles)
	if (!pokemon.volatiles.has('saltcure')) {
		return 0;
	}

	const maxHp = pokemon.maxHp || Math.floor(pokemon.hp / (pokemon.hpPercent / 100));

	// Salt Cure: 1/4 max HP for Water/Steel types, 1/8 otherwise
	const isWaterOrSteel = pokemon.types.includes('Water') || pokemon.types.includes('Steel');
	const divisor = isWaterOrSteel ? 4 : 8;

	return Math.max(1, Math.floor(maxHp / divisor));
}

/**
 * Calculate Bad Dreams ability damage at end of turn
 * @param pokemon - Pokemon taking damage
 * @param opponentAbility - Opponent's ability
 * @returns Damage amount
 */
export function getBadDreamsDamage(pokemon: AIPokemon, opponentAbility: string, field?: FieldConditions): number {
	// Only triggers if opponent has Bad Dreams
	if (toID(opponentAbility) !== 'baddreams') {
		return 0;
	}

	const abilityId = effectiveAbility(pokemon, field);

	// Magic Guard prevents Bad Dreams damage
	if (abilityId === 'magicguard') {
		return 0;
	}

	// Only affects sleeping Pokemon
	if (pokemon.status !== 'slp') {
		return 0;
	}

	const maxHp = pokemon.maxHp || Math.floor(pokemon.hp / (pokemon.hpPercent / 100));

	// Bad Dreams: 1/8 max HP
	return Math.max(1, Math.floor(maxHp / 8));
}

/**
 * Calculate total secondary effect damage at end of turn
 * Based on CFRU ai_util.c CalcSecondaryEffectDamage
 * @param pokemon - Pokemon taking damage
 * @param weather - Current weather
 * @param opponentAbility - Opponent's ability (for Bad Dreams)
 * @returns Total damage from all end-of-turn effects
 */
export function getSecondaryEffectDamage(
	pokemon: AIPokemon,
	weather: string,
	opponentAbility = '',
	field?: FieldConditions
): number {
	return residualEvents(pokemon, weather, opponentAbility, field)
		.reduce((sum, event) => sum + Math.max(0, event.damage), 0);
}

/** Signed HP changes in simulator residual order; healing cannot revive an earlier KO. */
function residualEvents(pokemon: AIPokemon, weather: string, opponentAbility: string, field?: FieldConditions,
	wishRecovery = 0) {
	const dex = rulesDex(field || {});
	const ability = effectiveAbility(pokemon, field);
	const item = effectiveItem(pokemon, field);
	const maxHp = pokemon.maxHp || 100;
	const portion = (divisor: number) => Math.max(1, Math.floor(maxHp / divisor));
	const events: { order: number, subOrder: number, damage: number }[] = [];
	const add = (damage: number,
		effect: { id?: string, onResidualOrder?: number, onResidualSubOrder?: number }, order = 0) => {
		if (!damage || damage > 0 && ability === 'magicguard') return;
		if (damage < 0 && pokemon.volatiles.has('healblock')) return;
		events.push({ damage, order: effect.onResidualOrder ?? order, subOrder: effect.onResidualSubOrder || 0 });
	};
	add(getSandstormDamage(pokemon, weather, field) + getHailDamage(pokemon, weather, field), {}, 1);
	add(-wishRecovery, dex.moves.get('wish').condition!);
	if (weather === 'rain' && item !== 'utilityumbrella') {
		if (ability === 'raindish') add(-portion(16), {}, 1);
		if (ability === 'dryskin') add(-portion(8), {}, 1);
	}
	if (weather === 'hail' && ability === 'icebody') add(-portion(16), {}, 1);
	if (weather === 'sun' && ['dryskin', 'solarpower'].includes(ability) && item !== 'utilityumbrella') {
		add(portion(8), {}, 1);
	}
	if (field?.terrain === 'grassy' && grounded(pokemon, field)) {
		add(-portion(16), dex.moves.get('grassyterrain').condition!);
	}
	if (item === 'leftovers' || item === 'blacksludge' && pokemon.types.includes('Poison')) {
		add(-portion(16), dex.items.get(item));
	} else if (item === 'blacksludge' || item === 'stickybarb') {
		add(portion(8), dex.items.get(item));
	}
	add(getPoisonDamage(pokemon, true, field), dex.conditions.get(pokemon.status));
	if (ability === 'poisonheal' && ['psn', 'tox'].includes(pokemon.status)) {
		add(-portion(8), dex.conditions.get(pokemon.status));
	}
	add(getBurnDamage(pokemon, field), dex.conditions.get('brn'));
	add(getTrapDamage(pokemon, field), dex.conditions.get('partiallytrapped'));
	for (const [id, damage] of [
		['leechseed', getLeechSeedDamage(pokemon, field)], ['curse', getCurseDamage(pokemon, field)],
		['nightmare', getNightmareDamage(pokemon, field)], ['saltcure', getSaltCureDamage(pokemon, field)],
	] as const) add(damage, dex.moves.get(id).condition!);
	add(getBadDreamsDamage(pokemon, opponentAbility, field), dex.abilities.get('baddreams'));
	return events.sort((a, b) => a.order - b.order || a.subOrder - b.subOrder);
}

/**
 * Check if Pokemon is taking any secondary damage
 * Based on CFRU ai_util.c IsTakingSecondaryDamage
 * @param pokemon - Pokemon to check
 * @param weather - Current weather
 * @param opponentAbility - Opponent's ability
 * @param checkConfusion - Whether to include confusion
 * @returns True if Pokemon is taking secondary damage
 */
export function isTakingSecondaryDamage(
	pokemon: AIPokemon,
	weather: string,
	opponentAbility: string = '',
	checkConfusion = false,
	field?: FieldConditions
): boolean {
	if (getSecondaryEffectDamage(pokemon, weather, opponentAbility, field) > 0) {
		return true;
	}

	if (checkConfusion && pokemon.volatiles.has('confusion')) {
		return true;
	}

	return false;
}

/**
 * Check if Pokemon will faint from secondary damage
 * Based on CFRU ai_util.c WillFaintFromSecondaryDamage
 * @param pokemon - Pokemon to check
 * @param weather - Current weather
 * @param opponentAbility - Opponent's ability
 * @returns True if Pokemon will faint from secondary damage
 */
export function willFaintFromSecondaryDamage(
	pokemon: AIPokemon,
	weather: string,
	opponentAbility = '',
	field?: FieldConditions
): boolean {
	return getEffectiveHpAfterSecondary(pokemon, weather, opponentAbility, field) <= 0;
}

/**
 * Calculate effective HP considering secondary damage
 * Useful for determining if a move can KO after accounting for end-of-turn damage
 * @param defender - Defending Pokemon
 * @param weather - Current weather
 * @param attackerAbility - Attacker's ability (for Bad Dreams)
 * @returns Effective current HP after secondary damage
 */
export function getEffectiveHpAfterSecondary(
	defender: AIPokemon,
	weather: string,
	attackerAbility = '',
	field?: FieldConditions,
	/** Stop before this residual order when checking whether an effect's source survives. */
	beforeOrder = Infinity,
	/** Recovery due this turn, inserted at the ruleset's Wish residual order. */
	wishRecovery = 0
): number {
	if (defender.hp <= 0 || beforeOrder === Infinity && defender.volatiles.has('perish0')) return 0;
	let hp = defender.hp;
	for (const event of residualEvents(defender, weather, attackerAbility, field, wishRecovery)) {
		if (event.order >= beforeOrder) break;
		hp = Math.min(defender.maxHp || 100, hp - event.damage);
		if (hp <= 0) return 0;
	}
	return hp;
}

/**
 * Check if a move can KO considering secondary effect damage
 * Based on CFRU usage in CanKnockOutAfterHealing context (but for damage instead)
 * @param attacker - Attacking Pokemon
 * @param defender - Defending Pokemon
 * @param move - Move being used
 * @param field - Field conditions
 * @param cache - Optional cache
 * @returns True if move + secondary damage can KO
 */
export function canKnockOutWithSecondary(
	attacker: AIPokemon,
	defender: AIPokemon,
	move: AIMove,
	field: FieldConditions,
	cache?: AICache
): boolean {
	const damage = calculateDamage(attacker, defender, move, field, cache);
	const hp = Math.max(0, defender.hp - damage.average);
	return willFaintFromSecondaryDamage({ ...defender, hp, hpPercent: hp / (defender.maxHp || 100) * 100 },
		field.weather, effectiveAbility(attacker, field), field);
}
