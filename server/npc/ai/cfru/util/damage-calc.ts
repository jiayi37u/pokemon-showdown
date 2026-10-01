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
import type { AIPokemon, AIMove, DamageResult, AICache, FieldConditions } from '../types';
import { getTypeEffectiveness, getSTABMultiplier, getAbilityTypeImmunity, wonderGuardBlocks } from './type-calc';

/** Damage roll range (0.85 to 1.0) */
const MIN_ROLL = 0.85;
const MAX_ROLL = 1.0;

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
export function getEffectiveStat(base: number, boost: number): number {
	if (boost === 0) return base;

	if (boost > 0) {
		return Math.floor(base * (2 + boost) / 2);
	} else {
		return Math.floor(base * 2 / (2 - boost));
	}
}

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
	field: FieldConditions
): number {
	const isPhysical = move.category === 'Physical';
	const baseStat = isPhysical ? attacker.baseStats.atk : attacker.baseStats.spa;
	const boost = isPhysical ? attacker.boosts.atk : attacker.boosts.spa;

	let stat = getEffectiveStat(baseStat, boost);

	// Ability modifiers
	const abilityId = toID(attacker.ability);

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
	const itemId = toID(attacker.item);

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
	field: FieldConditions
): number {
	// Special case: Psyshock, Psystrike, Secret Sword use physical defense
	const moveId = toID(move.id);
	const usesPhysicalDef = move.category === 'Physical' ||
		moveId === 'psyshock' || moveId === 'psystrike' || moveId === 'secretsword';

	const baseStat = usesPhysicalDef ? defender.baseStats.def : defender.baseStats.spd;
	const boost = usesPhysicalDef ? defender.boosts.def : defender.boosts.spd;

	let stat = getEffectiveStat(baseStat, boost);

	// Ability modifiers
	const abilityId = toID(defender.ability);

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
	const itemId = toID(defender.item);

	// Eviolite (1.5x both defenses for NFE Pokemon)
	if (itemId === 'eviolite') {
		const species = Dex.species.get(defender.species);
		if (species.nfe) {
			stat = Math.floor(stat * 1.5);
		}
	}

	// Assault Vest (1.5x SpD)
	if (itemId === 'assaultvest' && !usesPhysicalDef) {
		stat = Math.floor(stat * 1.5);
	}

	// Sandstorm SpD boost for Rock types
	if (field.weather === 'sand' && !usesPhysicalDef && defender.types.includes('Rock')) {
		stat = Math.floor(stat * 1.5);
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
	field: FieldConditions
): number {
	let basePower = move.basePower;
	if (basePower === 0) return 0;

	const moveId = toID(move.id);
	const attackerAbility = toID(attacker.ability);
	const defenderAbility = toID(defender.ability);

	// Variable base power moves
	basePower = getVariableBasePower(attacker, defender, move, basePower);

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
	if (attackerAbility === 'reckless' && (move.flags['recoil'] || moveId === 'jumpkick' || moveId === 'highjumpkick')) {
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

	// Weather effects on moves
	if (field.weather === 'sun') {
		if (move.type === 'Fire') basePower = Math.floor(basePower * 1.5);
		if (move.type === 'Water') basePower = Math.floor(basePower * 0.5);
	}
	if (field.weather === 'rain') {
		if (move.type === 'Water') basePower = Math.floor(basePower * 1.5);
		if (move.type === 'Fire') basePower = Math.floor(basePower * 0.5);
	}

	// Terrain effects
	if (field.terrain === 'electric' && move.type === 'Electric' && !attacker.volatiles.has('magnetrise') && !toID(attacker.ability).includes('levitate')) {
		basePower = Math.floor(basePower * 1.3);
	}
	if (field.terrain === 'grassy' && move.type === 'Grass' && !attacker.volatiles.has('magnetrise') && !toID(attacker.ability).includes('levitate')) {
		basePower = Math.floor(basePower * 1.3);
	}
	if (field.terrain === 'psychic' && move.type === 'Psychic' && !attacker.volatiles.has('magnetrise') && !toID(attacker.ability).includes('levitate')) {
		basePower = Math.floor(basePower * 1.3);
	}

	// Item modifiers
	const itemId = toID(attacker.item);

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

	return basePower;
}

/**
 * Handle variable base power moves
 */
function getVariableBasePower(
	attacker: AIPokemon,
	defender: AIPokemon,
	move: AIMove,
	basePower: number
): number {
	const moveId = toID(move.id);

	// Facade: doubles when statused
	if (moveId === 'facade' && attacker.status) {
		return 140;
	}

	// Hex: doubles when target is statused
	if (moveId === 'hex' && defender.status) {
		return 130;
	}

	// Venoshock: doubles when target is poisoned
	if (moveId === 'venoshock' && (defender.status === 'psn' || defender.status === 'tox')) {
		return 130;
	}

	// Brine: doubles when target is below 50% HP
	if (moveId === 'brine' && defender.hpPercent <= 50) {
		return 130;
	}

	// Low Kick / Grass Knot: based on target's weight
	// CFRU damage_calc.c lines 3521-3539
	if (moveId === 'lowkick' || moveId === 'grassknot') {
		return getWeightBasedPower(defender.species, defender.ability, defender.item);
	}

	// Heavy Slam / Heat Crash: based on weight ratio (attacker / defender)
	// CFRU damage_calc.c lines 3542-3569
	if (moveId === 'heavyslam' || moveId === 'heatcrash') {
		return getWeightRatioPower(
			attacker.species, attacker.ability, attacker.item,
			defender.species, defender.ability, defender.item
		);
	}

	// Gyro Ball: based on speed ratio (simplified)
	if (moveId === 'gyroball') {
		// Would need actual speed calc, estimate based on base stats
		const speedRatio = defender.baseStats.spe / Math.max(attacker.baseStats.spe, 1);
		return Math.min(150, Math.floor(25 * speedRatio));
	}

	// Electro Ball: based on speed ratio (simplified)
	if (moveId === 'electroball') {
		const speedRatio = attacker.baseStats.spe / Math.max(defender.baseStats.spe, 1);
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
	if (moveId === 'acrobatics' && !attacker.item) {
		return 110;
	}

	// Knock Off: boosted if target has item
	if (moveId === 'knockoff' && defender.item) {
		return 97; // 65 * 1.5
	}

	// Weather Ball: type and power change in weather
	if (moveId === 'weatherball') {
		return 100; // Power doubles in weather
	}

	return basePower;
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
	spreadInfo?: { isDoubles: boolean; numAliveTargets: number }
): DamageResult {
	// Check cache - include spread info in key for doubles
	const spreadKey = spreadInfo?.isDoubles ? `-spread${spreadInfo.numAliveTargets}` : '';
	const cacheKey = `${attacker.slot}-${defender.slot}-${move.id}${spreadKey}`;
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

	// Check immunities
	const effectiveness = getTypeEffectiveness(move.type, defender.types, cache);

	// Type immunity
	if (effectiveness === 0) {
		const result: DamageResult = {
			min: 0,
			max: 0,
			average: 0,
			minPercent: 0,
			maxPercent: 0,
			averagePercent: 0,
			effectiveness: 0,
			canKO: false,
			guaranteedKO: false,
			hitsToKO: Infinity,
		};
		if (cache) cache.damageCalc.set(cacheKey, result);
		return result;
	}

	// Ability immunity
	const abilityImmunity = getAbilityTypeImmunity(move.type, defender.ability);
	if (abilityImmunity.immune) {
		const result: DamageResult = {
			min: 0,
			max: 0,
			average: 0,
			minPercent: 0,
			maxPercent: 0,
			averagePercent: 0,
			effectiveness: 0,
			canKO: false,
			guaranteedKO: false,
			hitsToKO: Infinity,
		};
		if (cache) cache.damageCalc.set(cacheKey, result);
		return result;
	}

	// Wonder Guard check
	if (wonderGuardBlocks(move.type, defender.types, defender.ability)) {
		const result: DamageResult = {
			min: 0,
			max: 0,
			average: 0,
			minPercent: 0,
			maxPercent: 0,
			averagePercent: 0,
			effectiveness: 0,
			canKO: false,
			guaranteedKO: false,
			hitsToKO: Infinity,
		};
		if (cache) cache.damageCalc.set(cacheKey, result);
		return result;
	}

	// Get stats
	const attack = getAttackStat(attacker, move, field);
	const defense = getDefenseStat(defender, move, field);
	const basePower = getModifiedBasePower(attacker, defender, move, field);

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

	// Base damage formula
	const level = attacker.level || 100;
	let baseDamage = Math.floor(Math.floor(Math.floor(2 * level / 5 + 2) * basePower * attack / defense) / 50 + 2);

	// STAB
	const stabMultiplier = getSTABMultiplier(move.type, attacker.types, attacker.ability);
	baseDamage = Math.floor(baseDamage * stabMultiplier);

	// Type effectiveness
	baseDamage = Math.floor(baseDamage * effectiveness);

	// Burn penalty (physical moves, except Guts/Facade)
	if (attacker.status === 'brn' && move.category === 'Physical' &&
		toID(attacker.ability) !== 'guts' && toID(move.id) !== 'facade') {
		baseDamage = Math.floor(baseDamage * 0.5);
	}

	// Life Orb
	if (toID(attacker.item) === 'lifeorb') {
		baseDamage = Math.floor(baseDamage * 1.3);
	}

	// Expert Belt
	if (toID(attacker.item) === 'expertbelt' && effectiveness > 1) {
		baseDamage = Math.floor(baseDamage * 1.2);
	}

	// Screens
	if (move.category === 'Physical' && defender.volatiles.has('reflect')) {
		baseDamage = Math.floor(baseDamage * 0.5);
	}
	if (move.category === 'Special' && defender.volatiles.has('lightscreen')) {
		baseDamage = Math.floor(baseDamage * 0.5);
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

	// Get multi-hit count
	const hitCount = getExpectedHitCount(move, attacker.ability, attacker.item, attacker.species);

	// Calculate single hit damage with rolls
	const singleMinDamage = Math.floor(baseDamage * MIN_ROLL);
	const singleMaxDamage = Math.floor(baseDamage * MAX_ROLL);

	// Calculate total damage for multi-hit moves
	// For multi-hit moves, need to consider Multiscale/Shadow Shield on first hit
	let minDamage: number;
	let maxDamage: number;

	if (hitCount > 1) {
		// Check if first hit damage is halved (Multiscale/Shadow Shield at full HP)
		const defenderAbility = toID(defender.ability);
		const firstHitHalved = defender.hpPercent >= 100 &&
			(defenderAbility === 'multiscale' || defenderAbility === 'shadowshield');

		if (firstHitHalved) {
			// First hit halved, subsequent hits normal
			// Total = (first_hit * 0.5) + (remaining_hits * normal)
			const firstHitMin = Math.floor(singleMinDamage * 0.5);
			const firstHitMax = Math.floor(singleMaxDamage * 0.5);
			const remainingHits = hitCount - 1;
			minDamage = firstHitMin + Math.floor(singleMinDamage * remainingHits);
			maxDamage = firstHitMax + Math.floor(singleMaxDamage * remainingHits);
		} else {
			// All hits normal damage
			minDamage = Math.floor(singleMinDamage * hitCount);
			maxDamage = Math.floor(singleMaxDamage * hitCount);
		}
	} else {
		minDamage = singleMinDamage;
		maxDamage = singleMaxDamage;
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

	for (const move of moves) {
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
export function getPoisonDamage(pokemon: AIPokemon, forAI: boolean = true): number {
	const abilityId = toID(pokemon.ability);

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
		// toxicCounter starts at 1 and increases each turn
		// For AI, we assume next turn will do more damage
		const toxicCounter = (pokemon.toxicCounter || 1) + (forAI ? 1 : 0);
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
export function getBurnDamage(pokemon: AIPokemon): number {
	const abilityId = toID(pokemon.ability);

	// Magic Guard prevents burn damage
	if (abilityId === 'magicguard') {
		return 0;
	}

	if (pokemon.status !== 'brn') {
		return 0;
	}

	const maxHp = pokemon.maxHp || Math.floor(pokemon.hp / (pokemon.hpPercent / 100));

	// Heatproof halves burn damage
	if (abilityId === 'heatproof') {
		return Math.max(1, Math.floor(maxHp / 32));
	}

	// Standard burn: 1/16 max HP (modern mechanics)
	return Math.max(1, Math.floor(maxHp / 16));
}

/**
 * Calculate sandstorm damage at end of turn
 * Based on CFRU general_bs_commands.c GetSandstormDamage
 * @param pokemon - Pokemon taking damage
 * @param weather - Current weather
 * @returns Damage amount
 */
export function getSandstormDamage(pokemon: AIPokemon, weather: string): number {
	if (weather !== 'sand' && weather !== 'sandstorm') {
		return 0;
	}

	const abilityId = toID(pokemon.ability);

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
	if (toID(pokemon.item) === 'safetygoggles') {
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
export function getHailDamage(pokemon: AIPokemon, weather: string): number {
	// Hail or Snow (snow doesn't do damage in Gen 9+, but older gens it does)
	if (weather !== 'hail') {
		return 0;
	}

	const abilityId = toID(pokemon.ability);

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
	if (toID(pokemon.item) === 'safetygoggles') {
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
export function getLeechSeedDamage(pokemon: AIPokemon): number {
	const abilityId = toID(pokemon.ability);

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
export function getTrapDamage(pokemon: AIPokemon): number {
	const abilityId = toID(pokemon.ability);

	// Magic Guard prevents trap damage
	if (abilityId === 'magicguard') {
		return 0;
	}

	// Check if trapped (via volatiles - partialtrap)
	if (!pokemon.volatiles.has('partiallytrapped')) {
		return 0;
	}

	const maxHp = pokemon.maxHp || Math.floor(pokemon.hp / (pokemon.hpPercent / 100));

	// Trap damage: 1/8 max HP (Binding Band increases to 1/6)
	// Simplified to 1/8 for now
	return Math.max(1, Math.floor(maxHp / 8));
}

/**
 * Calculate curse (ghost) damage at end of turn
 * @param pokemon - Pokemon taking damage
 * @returns Damage amount
 */
export function getCurseDamage(pokemon: AIPokemon): number {
	const abilityId = toID(pokemon.ability);

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
export function getNightmareDamage(pokemon: AIPokemon): number {
	const abilityId = toID(pokemon.ability);

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
export function getSaltCureDamage(pokemon: AIPokemon): number {
	const abilityId = toID(pokemon.ability);

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
export function getBadDreamsDamage(pokemon: AIPokemon, opponentAbility: string): number {
	// Only triggers if opponent has Bad Dreams
	if (toID(opponentAbility) !== 'baddreams') {
		return 0;
	}

	const abilityId = toID(pokemon.ability);

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
	opponentAbility: string = ''
): number {
	const abilityId = toID(pokemon.ability);

	// Magic Guard prevents all secondary effect damage
	if (abilityId === 'magicguard') {
		return 0;
	}

	let totalDamage = 0;

	// Weather damage
	totalDamage += getSandstormDamage(pokemon, weather);
	totalDamage += getHailDamage(pokemon, weather);

	// Status damage
	totalDamage += getPoisonDamage(pokemon, true);
	totalDamage += getBurnDamage(pokemon);

	// Volatile damage
	totalDamage += getLeechSeedDamage(pokemon);
	totalDamage += getTrapDamage(pokemon);
	totalDamage += getCurseDamage(pokemon);
	totalDamage += getNightmareDamage(pokemon);
	totalDamage += getSaltCureDamage(pokemon);

	// Ability damage
	totalDamage += getBadDreamsDamage(pokemon, opponentAbility);

	return totalDamage;
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
	checkConfusion: boolean = false
): boolean {
	if (getSecondaryEffectDamage(pokemon, weather, opponentAbility) > 0) {
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
	opponentAbility: string = ''
): boolean {
	// Check perish song
	if (pokemon.volatiles.has('perishsong')) {
		// Would need to check perish count, but if it's at 0 they will faint
		// For simplicity, assume they're at risk
		return true;
	}

	const currentHp = Math.floor((pokemon.maxHp || 100) * pokemon.hpPercent / 100);
	const secondaryDamage = getSecondaryEffectDamage(pokemon, weather, opponentAbility);

	// Consider Leftovers/Black Sludge recovery
	const itemId = toID(pokemon.item);
	let recovery = 0;
	if (itemId === 'leftovers' || (itemId === 'blacksludge' && pokemon.types.includes('Poison'))) {
		const maxHp = pokemon.maxHp || Math.floor(pokemon.hp / (pokemon.hpPercent / 100));
		recovery = Math.floor(maxHp / 16);
	}

	return secondaryDamage - recovery >= currentHp;
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
	attackerAbility: string = ''
): number {
	const currentHp = Math.floor((defender.maxHp || 100) * defender.hpPercent / 100);
	const secondaryDamage = getSecondaryEffectDamage(defender, weather, attackerAbility);

	return Math.max(0, currentHp - secondaryDamage);
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
	const secondaryDamage = getSecondaryEffectDamage(defender, field.weather, attacker.ability);
	const currentHp = Math.floor((defender.maxHp || 100) * defender.hpPercent / 100);

	return damage.average + secondaryDamage >= currentHp;
}
