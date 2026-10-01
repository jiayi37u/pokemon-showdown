/**
 * CFRU AI - Speed Calculation Utilities
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Speed comparison and priority calculation functions.
 * Based on CFRU ai_util.c speed calculation logic.
 *
 * @license MIT
 */

import { Dex, toID } from '../../../../../sim/dex';
import type { AIPokemon, AIMove, AICache, FieldConditions, SideConditions } from '../types';
import { getEffectiveStat } from './damage-calc';

/**
 * Speed context for considering side conditions
 */
export interface SpeedContext {
	field: FieldConditions;
	attackerSideConditions?: SideConditions;
	defenderSideConditions?: SideConditions;
}

/**
 * Get effective speed for a Pokemon
 * @param pokemon - The Pokemon
 * @param field - Field conditions
 * @param sideConditions - Optional side conditions (for Tailwind)
 * @returns Effective speed value
 */
export function getEffectiveSpeed(
	pokemon: AIPokemon,
	field: FieldConditions,
	sideConditions?: SideConditions
): number {
	const baseSpeed = pokemon.baseStats.spe;
	let speed = getEffectiveStat(baseSpeed, pokemon.boosts.spe);

	const abilityId = toID(pokemon.ability);
	const itemId = toID(pokemon.item);

	// Ability modifiers
	// Chlorophyll (2x in sun)
	if (abilityId === 'chlorophyll' && field.weather === 'sun') {
		speed *= 2;
	}

	// Swift Swim (2x in rain)
	if (abilityId === 'swiftswim' && field.weather === 'rain') {
		speed *= 2;
	}

	// Sand Rush (2x in sand)
	if (abilityId === 'sandrush' && field.weather === 'sand') {
		speed *= 2;
	}

	// Slush Rush (2x in hail/snow)
	if (abilityId === 'slushrush' && (field.weather === 'hail' || field.weather === 'snow')) {
		speed *= 2;
	}

	// Surge Surfer (2x in Electric Terrain)
	if (abilityId === 'surgesurfer' && field.terrain === 'electric') {
		speed *= 2;
	}

	// Unburden (2x if item was consumed)
	// Note: This requires tracking item consumption, simplified here
	if (abilityId === 'unburden' && !pokemon.item) {
		speed *= 2;
	}

	// Quick Feet (1.5x when statused, ignores paralysis penalty)
	if (abilityId === 'quickfeet' && pokemon.status) {
		speed = Math.floor(speed * 1.5);
	}

	// Slow Start (0.5x for first 5 turns)
	// Note: Requires turn tracking, simplified
	if (abilityId === 'slowstart') {
		// Assume it's active
	}

	// Paralysis penalty (unless Quick Feet)
	if (pokemon.status === 'par' && abilityId !== 'quickfeet') {
		speed = Math.floor(speed * 0.5);
	}

	// Item modifiers
	// Choice Scarf (1.5x)
	if (itemId === 'choicescarf') {
		speed = Math.floor(speed * 1.5);
	}

	// Iron Ball (0.5x)
	if (itemId === 'ironball') {
		speed = Math.floor(speed * 0.5);
	}

	// Macho Brace / Power items (0.5x)
	if (['machobrace', 'powerweight', 'powerbracer', 'powerbelt', 'powerlens', 'powerband', 'poweranklet'].includes(itemId)) {
		speed = Math.floor(speed * 0.5);
	}

	// Tailwind (2x)
	if (sideConditions && sideConditions.tailwind > 0) {
		speed = Math.floor(speed * 2);
	}

	return Math.floor(speed);
}

/**
 * Compare speeds of two Pokemon
 * @param pokemon1 - First Pokemon
 * @param pokemon2 - Second Pokemon
 * @param field - Field conditions
 * @param cache - Optional cache
 * @param pokemon1SideConditions - Side conditions for pokemon1
 * @param pokemon2SideConditions - Side conditions for pokemon2
 * @returns true if pokemon1 is faster (or ties)
 */
export function isFaster(
	pokemon1: AIPokemon,
	pokemon2: AIPokemon,
	field: FieldConditions,
	cache?: AICache,
	pokemon1SideConditions?: SideConditions,
	pokemon2SideConditions?: SideConditions
): boolean {
	// Check cache (note: cache doesn't account for side conditions)
	const cacheKey = `${pokemon1.slot}-${pokemon2.slot}`;
	if (cache?.speedComparison.has(cacheKey) && !pokemon1SideConditions && !pokemon2SideConditions) {
		return cache.speedComparison.get(cacheKey)!;
	}

	let speed1 = getEffectiveSpeed(pokemon1, field, pokemon1SideConditions);
	let speed2 = getEffectiveSpeed(pokemon2, field, pokemon2SideConditions);

	// Trick Room reversal
	if (field.trickroom) {
		[speed1, speed2] = [speed2, speed1];
	}

	const result = speed1 >= speed2;

	// Cache result
	if (cache) {
		cache.speedComparison.set(cacheKey, result);
	}

	return result;
}

/**
 * Check if a Pokemon outspeeds another considering move priority
 * @param attacker - Attacking Pokemon
 * @param defender - Defending Pokemon
 * @param attackerMove - Attacker's move
 * @param defenderMoves - Defender's known moves (for prediction)
 * @param field - Field conditions
 * @returns true if attacker goes first
 */
export function goesFirst(
	attacker: AIPokemon,
	defender: AIPokemon,
	attackerMove: AIMove,
	defenderMoves: AIMove[],
	field: FieldConditions
): boolean {
	// Get attacker's priority
	let attackerPriority = attackerMove.priority;

	// Ability priority modifiers
	const attackerAbility = toID(attacker.ability);

	// Gale Wings (+1 to Flying moves at full HP)
	if (attackerAbility === 'galewings' && attackerMove.type === 'Flying' && attacker.hpPercent === 100) {
		attackerPriority += 1;
	}

	// Prankster (+1 to status moves)
	if (attackerAbility === 'prankster' && attackerMove.category === 'Status') {
		attackerPriority += 1;
		// Dark types are immune to Prankster-boosted moves
		if (defender.types.includes('Dark')) {
			// Move fails, but we treat as going first for simplicity
		}
	}

	// Triage (+3 to healing moves)
	if (attackerAbility === 'triage' && attackerMove.flags['heal']) {
		attackerPriority += 3;
	}

	// Estimate defender's highest priority move
	let defenderPriority = 0;
	for (const move of defenderMoves) {
		let priority = move.priority;

		const defenderAbility = toID(defender.ability);

		if (defenderAbility === 'galewings' && move.type === 'Flying' && defender.hpPercent === 100) {
			priority += 1;
		}
		if (defenderAbility === 'prankster' && move.category === 'Status') {
			priority += 1;
		}
		if (defenderAbility === 'triage' && move.flags['heal']) {
			priority += 3;
		}

		if (priority > defenderPriority) {
			defenderPriority = priority;
		}
	}

	// If priorities differ, higher wins
	if (attackerPriority !== defenderPriority) {
		return attackerPriority > defenderPriority;
	}

	// Same priority, compare speed
	return isFaster(attacker, defender, field);
}

/**
 * Check if a Pokemon can use a priority move to KO
 * Based on CFRU GetFastestMonThatCanKO
 */
export function canPriorityKO(
	attacker: AIPokemon,
	defender: AIPokemon,
	moves: AIMove[],
	field: FieldConditions
): { canKO: boolean; move: AIMove | null } {
	for (const move of moves) {
		if (move.disabled || move.category === 'Status') continue;

		// Check if this is a priority move
		let priority = move.priority;
		const attackerAbility = toID(attacker.ability);

		if (attackerAbility === 'galewings' && move.type === 'Flying' && attacker.hpPercent === 100) {
			priority += 1;
		}

		if (priority > 0) {
			// Import damage calc here to avoid circular dependency
			const { canKnockOut } = require('./damage-calc');
			if (canKnockOut(attacker, defender, move, field)) {
				return { canKO: true, move };
			}
		}
	}

	return { canKO: false, move: null };
}

/**
 * Get all priority moves for a Pokemon
 */
export function getPriorityMoves(pokemon: AIPokemon, moves: AIMove[]): AIMove[] {
	const priorityMoves: AIMove[] = [];
	const abilityId = toID(pokemon.ability);

	for (const move of moves) {
		if (move.disabled) continue;

		let priority = move.priority;

		// Ability adjustments
		if (abilityId === 'galewings' && move.type === 'Flying' && pokemon.hpPercent === 100) {
			priority += 1;
		}
		if (abilityId === 'prankster' && move.category === 'Status') {
			priority += 1;
		}
		if (abilityId === 'triage' && move.flags['heal']) {
			priority += 3;
		}

		if (priority > 0) {
			priorityMoves.push(move);
		}
	}

	return priorityMoves;
}

/**
 * Check if a Pokemon is "slow" (would benefit from Trick Room)
 */
export function isSlow(pokemon: AIPokemon): boolean {
	// Consider a Pokemon slow if base speed is below 60
	return pokemon.baseStats.spe < 60;
}

/**
 * Get speed tier classification
 */
export function getSpeedTier(pokemon: AIPokemon): 'very_slow' | 'slow' | 'medium' | 'fast' | 'very_fast' {
	const speed = pokemon.baseStats.spe;

	if (speed < 40) return 'very_slow';
	if (speed < 70) return 'slow';
	if (speed < 100) return 'medium';
	if (speed < 120) return 'fast';
	return 'very_fast';
}
