/**
 * CFRU AI - Type Calculation Utilities
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Type effectiveness calculation functions.
 *
 * @license MIT
 */

import { Dex, toID } from '../../../../../sim/dex';
import type { AIPokemon, AIMove, AICache, FieldConditions } from '../types';
import { defensiveAbility, effectiveItem, effectivePriority, grounded, rulesDex } from './mechanics';

/** Resolve item-dependent move types from the AI's current item knowledge. */
export function resolveItemMoveType(attacker: AIPokemon, move: AIMove, field: FieldConditions): AIMove {
	const moveId = toID(move.id);
	if (!['judgment', 'multiattack', 'technoblast'].includes(moveId)) return move;
	let type = 'Normal';
	if (attacker.item && !attacker.itemLost && toID(attacker.ability) !== 'klutz' &&
		!field.magicroom && !attacker.volatiles.has('embargo')) {
		const item = Dex.items.get(attacker.item);
		const itemType = moveId === 'judgment' ? (!item.zMove && item.onPlate) :
			moveId === 'multiattack' ? item.onMemory : item.onDrive;
		if (typeof itemType === 'string') type = itemType;
	}
	return move.type === type ? move : { ...move, type };
}

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

/** Apply public ability bypass and grounding conditions to an ability's type immunity. */
export function getEffectiveAbilityTypeImmunity(
	attacker: AIPokemon, defender: AIPokemon, move: AIMove, field: FieldConditions
): { immune: boolean, effect?: string } {
	const immunity = getAbilityTypeImmunity(move.type, defensiveAbility(attacker, defender, move, field));
	if (immunity.effect === 'levitate' && (grounded(defender, field) || toID(move.id) === 'thousandarrows')) {
		return { immune: false };
	}
	return immunity;
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

/** Public active allies are needed for team-wide priority protection in doubles and multi. */
export interface MoveInteractionContext {
	defenderAllies?: readonly AIPokemon[];
	isAllyTarget?: boolean;
}

/** A rule result shared by damage, scoring and threat estimates; no strategy weights. */
export function getMoveInteraction(
	attacker: AIPokemon, defender: AIPokemon, move: AIMove, field: FieldConditions,
	context: MoveInteractionContext = {}
): { effectiveness: number, blockedBy?: string } {
	const dex = rulesDex(field);
	const data = dex.moves.get(move.id);
	const ability = defensiveAbility(attacker, defender, move, field);
	const block = (blockedBy: string) => ({ effectiveness: 0, blockedBy });
	const direct = ['normal', 'any', 'allAdjacent', 'allAdjacentFoes', 'adjacentAlly', 'adjacentAllyOrSelf']
		.includes(move.target) &&
		!(move.id === 'curse' && !attacker.types.includes('Ghost'));
	const foeTarget = direct && attacker !== defender && !context.isAllyTarget;
	if (foeTarget && move.category === 'Status' && toID(attacker.ability) === 'prankster' &&
		!dex.getImmunity('prankster', defender.types)) {
		return block('Dark target immune to Prankster status move');
	}
	if (foeTarget && effectivePriority(attacker, move, field) > 0) {
		if (field.terrain === 'psychic' && grounded(defender, field)) {
			return block('Psychic Terrain blocks priority moves');
		}
		for (const holder of [defender, ...(context.defenderAllies || [])]) {
			if (holder.fainted) continue;
			const protection = defensiveAbility(attacker, holder, move, field);
			if (['dazzling', 'queenlymajesty', 'armortail'].includes(protection)) {
				return block(`${holder.ability} blocks priority moves`);
			}
		}
	}
	if ((direct || move.id === 'perishsong') && attacker !== defender && ability === 'soundproof' && move.flags.sound) {
		return block('Soundproof blocks sound move');
	}
	if (ability === 'bulletproof' && move.flags.bullet) return block('Bulletproof blocks ball/bomb move');
	if (move.category === 'Status') return { effectiveness: 1 };

	let types = defender.volatiles.has('roost') ? defender.types.filter(t => t !== 'Flying') : defender.types;
	if (!types.length) types = [dex.gen >= 5 ? 'Normal' : '???'];
	const item = effectiveItem(defender, field);
	const arrows = move.id === 'thousandarrows';
	const isGrounded = grounded(defender, field, ability !== 'levitate');
	let exponent = 0;
	for (const type of types) {
		const ignoreImmunity = data.ignoreImmunity === true ||
			(typeof data.ignoreImmunity === 'object' && data.ignoreImmunity[move.type]) || item === 'ringtarget' ||
			(move.type === 'Ground' && (arrows || isGrounded)) ||
			(type === 'Ghost' && ['Normal', 'Fighting'].includes(move.type) &&
				['scrappy', 'mindseye'].includes(toID(attacker.ability)));
		if (!ignoreImmunity && !dex.getImmunity(move.type, type)) return block(`Type immunity (${move.type} vs ${type})`);
		exponent += move.id === 'freezedry' && type === 'Water' ? 1 : dex.getEffectiveness(move.type, type);
		if (move.id === 'flyingpress') exponent += dex.getEffectiveness('Flying', type);
	}
	// Iron Ball alone makes Ground neutral against Flying dual types, unlike Gravity/Smack Down.
	const ironBallNeutral = move.type === 'Ground' && item === 'ironball' && types.includes('Flying') &&
		!field.gravity && !defender.volatiles.has('ingrain') && !defender.volatiles.has('smackdown');
	const effectiveness = ironBallNeutral || (arrows && types.includes('Flying') && !isGrounded) ? 1 : 2 ** exponent;
	if (move.type === 'Ground' && !arrows && !isGrounded &&
		(item === 'airballoon' || defender.volatiles.has('magnetrise') || defender.volatiles.has('telekinesis'))) {
		return block('Airborne target immune to Ground');
	}
	if (getEffectiveAbilityTypeImmunity(attacker, defender, move, field).immune) {
		return block(`Ability immunity: ${defender.ability}`);
	}
	if (ability === 'wonderguard' && effectiveness <= 1) return block('Wonder Guard blocks non-super-effective move');
	return { effectiveness };
}
