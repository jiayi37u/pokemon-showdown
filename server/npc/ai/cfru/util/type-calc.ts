/**
 * CFRU AI - Type Calculation Utilities
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Type effectiveness calculation functions.
 *
 * @license MIT
 */

import { Dex, toID } from '../../../../../sim/dex';
import type { AIPokemon, AICache } from '../types';

/** Type effectiveness multipliers */
export const TYPE_EFFECTIVENESS = {
	IMMUNE: 0,
	QUARTER: 0.25,
	HALF: 0.5,
	NORMAL: 1,
	DOUBLE: 2,
	QUAD: 4,
} as const;

/**
 * Get type effectiveness multiplier for a move against a defender
 * Based on CFRU's AI_SpecialTypeCalc (damage_calc.c:1200)
 * @param moveType - The move's type
 * @param defenderTypes - The defender's types
 * @param cache - Optional cache for memoization
 * @returns Effectiveness multiplier (0, 0.25, 0.5, 1, 2, or 4)
 */
export function getTypeEffectiveness(
	moveType: string,
	defenderTypes: string[],
	cache?: AICache
): number {
	// Check cache
	const cacheKey = `${moveType}-${defenderTypes.join(',')}`;
	if (cache?.typeEffectiveness.has(cacheKey)) {
		return cache.typeEffectiveness.get(cacheKey)!;
	}

	// IMPORTANT: First check for immunity using Dex.getImmunity
	// getImmunity returns FALSE if immune (that's how PS Dex API works)
	// This handles Ground vs Flying, Normal/Fighting vs Ghost, etc.
	if (!Dex.getImmunity(moveType, defenderTypes)) {
		// Cache result
		if (cache) {
			cache.typeEffectiveness.set(cacheKey, 0);
		}
		return 0;
	}

	// Not immune, calculate effectiveness
	// Dex.getEffectiveness returns a sum: +1 for each super-effective, -1 for each resist
	const effectivenessSum = Dex.getEffectiveness(moveType, defenderTypes);

	// Convert sum to multiplier: sum of +2 = 4x, +1 = 2x, 0 = 1x, -1 = 0.5x, -2 = 0.25x
	const multiplier = Math.pow(2, effectivenessSum);

	// Cache result
	if (cache) {
		cache.typeEffectiveness.set(cacheKey, multiplier);
	}

	return multiplier;
}

/**
 * Check if a move type has STAB (Same Type Attack Bonus)
 * @param moveType - The move's type
 * @param attackerTypes - The attacker's types
 * @returns true if STAB applies
 */
export function hasSTAB(moveType: string, attackerTypes: string[]): boolean {
	return attackerTypes.includes(moveType);
}

/**
 * Get STAB multiplier
 * @param moveType - The move's type
 * @param attackerTypes - The attacker's types
 * @param ability - The attacker's ability (for Adaptability)
 * @returns STAB multiplier (1, 1.5, or 2 for Adaptability)
 */
export function getSTABMultiplier(
	moveType: string,
	attackerTypes: string[],
	ability: string
): number {
	if (!hasSTAB(moveType, attackerTypes)) {
		return 1;
	}

	// Adaptability increases STAB from 1.5x to 2x
	if (toID(ability) === 'adaptability') {
		return 2;
	}

	return 1.5;
}

/**
 * Check if a type is immune to a move type due to ability
 * @param moveType - The move's type
 * @param ability - The defender's ability
 * @returns Object with immunity status and the ability effect
 */
export function getAbilityTypeImmunity(
	moveType: string,
	ability: string
): { immune: boolean; effect?: string } {
	const abilityId = toID(ability);
	const moveTypeId = toID(moveType);

	// Electric immunities
	if (moveTypeId === 'electric') {
		if (['voltabsorb', 'lightningrod', 'motordrive'].includes(abilityId)) {
			return { immune: true, effect: abilityId };
		}
	}

	// Water immunities
	if (moveTypeId === 'water') {
		if (['waterabsorb', 'stormdrain', 'dryskin'].includes(abilityId)) {
			return { immune: true, effect: abilityId };
		}
	}

	// Fire immunities
	if (moveTypeId === 'fire') {
		if (['flashfire', 'wellbakedbody'].includes(abilityId)) {
			return { immune: true, effect: abilityId };
		}
		// Fluffy takes double damage from Fire, not immune
	}

	// Grass immunities
	if (moveTypeId === 'grass') {
		if (abilityId === 'sapsipper') {
			return { immune: true, effect: abilityId };
		}
	}

	// Ground immunities (Levitate is handled by type chart in most cases)
	if (moveTypeId === 'ground') {
		if (abilityId === 'levitate') {
			return { immune: true, effect: abilityId };
		}
		if (abilityId === 'eartheater') {
			return { immune: true, effect: abilityId };
		}
	}

	// Sound-based move immunity
	// Note: This requires checking move flags, handled separately

	// Bulletproof (ball/bomb moves) - handled by move flags

	return { immune: false };
}

/**
 * Check if Wonder Guard blocks a move
 * @param moveType - The move's type
 * @param defenderTypes - The defender's types
 * @param defenderAbility - The defender's ability
 * @returns true if Wonder Guard blocks the move
 */
export function wonderGuardBlocks(
	moveType: string,
	defenderTypes: string[],
	defenderAbility: string
): boolean {
	if (toID(defenderAbility) !== 'wonderguard') {
		return false;
	}

	const effectiveness = getTypeEffectiveness(moveType, defenderTypes);
	return effectiveness <= 1;
}

/**
 * Get all resistances for a Pokemon
 * @param types - The Pokemon's types
 * @returns Map of type -> multiplier for types it resists
 */
export function getResistances(types: string[]): Map<string, number> {
	const resistances = new Map<string, number>();

	const allTypes = Object.keys(Dex.data.TypeChart);

	for (const attackType of allTypes) {
		const effectiveness = getTypeEffectiveness(attackType, types);
		if (effectiveness < 1) {
			resistances.set(attackType, effectiveness);
		}
	}

	return resistances;
}

/**
 * Get all weaknesses for a Pokemon
 * @param types - The Pokemon's types
 * @returns Map of type -> multiplier for types it's weak to
 */
export function getWeaknesses(types: string[]): Map<string, number> {
	const weaknesses = new Map<string, number>();

	const allTypes = Object.keys(Dex.data.TypeChart);

	for (const attackType of allTypes) {
		const effectiveness = getTypeEffectiveness(attackType, types);
		if (effectiveness > 1) {
			weaknesses.set(attackType, effectiveness);
		}
	}

	return weaknesses;
}

/**
 * Get all immunities for a Pokemon (type-based only)
 * @param types - The Pokemon's types
 * @returns Array of types the Pokemon is immune to
 */
export function getImmunities(types: string[]): string[] {
	const immunities: string[] = [];

	const allTypes = Object.keys(Dex.data.TypeChart);

	for (const attackType of allTypes) {
		const effectiveness = getTypeEffectiveness(attackType, types);
		if (effectiveness === 0) {
			immunities.push(attackType);
		}
	}

	return immunities;
}

/**
 * Check if a Pokemon resists all of another Pokemon's known moves
 * @param defender - The defending Pokemon
 * @param attacker - The attacking Pokemon
 * @returns true if defender resists all known moves
 */
export function resistsAllMoves(defender: AIPokemon, attacker: AIPokemon): boolean {
	if (attacker.moves.length === 0) {
		// No known moves, can't determine
		return false;
	}

	for (const moveId of attacker.moves) {
		const move = Dex.moves.get(moveId);
		if (!move.exists || move.category === 'Status') {
			continue;
		}

		const effectiveness = getTypeEffectiveness(move.type, defender.types);

		// Check ability immunity
		const abilityImmunity = getAbilityTypeImmunity(move.type, defender.ability);
		if (abilityImmunity.immune) {
			continue;
		}

		// If any move is not resisted, return false
		if (effectiveness >= 1) {
			return false;
		}
	}

	return true;
}

/**
 * Check if attacker has a super effective move against defender
 * @param attacker - The attacking Pokemon
 * @param defender - The defending Pokemon
 * @returns true if attacker has a super effective move
 */
export function hasSuperEffectiveMove(attacker: AIPokemon, defender: AIPokemon): boolean {
	for (const moveId of attacker.moves) {
		const move = Dex.moves.get(moveId);
		if (!move.exists || move.category === 'Status') {
			continue;
		}

		// Check ability immunity first
		const abilityImmunity = getAbilityTypeImmunity(move.type, defender.ability);
		if (abilityImmunity.immune) {
			continue;
		}

		const effectiveness = getTypeEffectiveness(move.type, defender.types);
		if (effectiveness > 1) {
			return true;
		}
	}

	return false;
}
