/**
 * CFRU AI - Speed Calculation Utilities
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Speed comparison and priority calculation functions.
 * Based on CFRU ai_util.c speed calculation logic.
 *
 * @license MIT
 */

import { toID } from '../../../../../sim/dex';
import { pokemonCacheId } from './cache';
import type { AIPokemon, AIMove, AICache, BattleState, FieldConditions, SideConditions } from '../types';
import { effectiveAbility, effectiveItem, effectivePriority, getEffectiveStat, rulesDex } from './mechanics';
import { resolveMove } from './type-calc';

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

	const abilityId = effectiveAbility(pokemon, field);
	const itemId = effectiveItem(pokemon, field);

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

	// Unknown or initially absent items do not activate Unburden. Switching clears the loss marker.
	if (abilityId === 'unburden' && !pokemon.item &&
		(pokemon.volatiles.has('itemlost') || pokemon.volatiles.has('unburden'))) {
		speed *= 2;
	}

	// Quick Feet (1.5x when statused, ignores paralysis penalty)
	if (abilityId === 'quickfeet' && pokemon.status) {
		speed = Math.floor(speed * 1.5);
	}

	if (abilityId === 'slowstart' && pokemon.volatiles.has('slowstart')) speed *= 0.5;

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

	if (abilityId && pokemon.abilityStatMod?.stat === 'spe') speed *= pokemon.abilityStatMod.multiplier;
	if (pokemon.status === 'par' && abilityId !== 'quickfeet') {
		const dex = rulesDex(field);
		speed = Math.floor(speed * (dex.gen <= 6 && dex.currentMod !== 'mmo' ? 0.25 : 0.5));
	}
	return Math.max(1, Math.floor(speed));
}

/**
 * Compare speeds of two Pokemon
 * @param pokemon1 - First Pokemon
 * @param pokemon2 - Second Pokemon
 * @param field - Field conditions
 * @param cache - Optional cache
 * @param pokemon1SideConditions - Side conditions for pokemon1
 * @param pokemon2SideConditions - Side conditions for pokemon2
 * @returns true only if pokemon1 is strictly faster in the current room
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
	const cacheKey = `${pokemonCacheId(pokemon1)}-${pokemonCacheId(pokemon2)}-${JSON.stringify(field)}`;
	if (cache?.speedComparison.has(cacheKey) && !pokemon1SideConditions && !pokemon2SideConditions) {
		return cache.speedComparison.get(cacheKey)!;
	}

	const result = compareSpeedOrder(pokemon1, pokemon2, field, pokemon1SideConditions, pokemon2SideConditions) > 0;

	// Cache result
	if (cache && !pokemon1SideConditions && !pokemon2SideConditions) {
		cache.speedComparison.set(cacheKey, result);
	}

	return result;
}

/** Positive means first, zero means a speed tie, negative means second. */
export type ActionOrder = -1 | 0 | 1;
type PriorityMove = Pick<AIMove, 'priority' | 'category' | 'type' | 'flags'> &
	Partial<Pick<AIMove, 'id' | 'calledMove'>>;

export function compareSpeedOrder(
	actor: AIPokemon, target: AIPokemon, field: FieldConditions,
	actorSide?: SideConditions, targetSide?: SideConditions
): ActionOrder {
	const a = getEffectiveSpeed(actor, field, actorSide);
	const b = getEffectiveSpeed(target, field, targetSide);
	if (a === b) return 0;
	return (a > b) !== !!field.trickroom ? 1 : -1;
}

/** Compare actions using the same mechanics for every difficulty and battle mode. */
export function compareActionOrder(
	actor: AIPokemon, target: AIPokemon, move: PriorityMove, responses: readonly PriorityMove[],
	field: FieldConditions, actorSide?: SideConditions, targetSide?: SideConditions
): ActionOrder {
	const priority = effectivePriority(actor, move, field);
	const responsePriority = responses.length ? Math.max(...responses.map(response =>
		effectivePriority(target, response, field))) : 0;
	if (priority !== responsePriority) return priority > responsePriority ? 1 : -1;
	return compareSpeedOrder(actor, target, field, actorSide, targetSide);
}

/** A tie is not a reliable first strike. */
export function goesFirst(
	attacker: AIPokemon, defender: AIPokemon, attackerMove: AIMove, defenderMoves: AIMove[],
	field: FieldConditions, attackerSideConditions?: SideConditions, defenderSideConditions?: SideConditions
): boolean {
	return compareActionOrder(attacker, defender, attackerMove, defenderMoves,
		field, attackerSideConditions, defenderSideConditions) > 0;
}

/** Attack races ignore defensive status options such as Protect, but retain attacking priority. */
export function attacksFirst(
	attacker: AIPokemon, defender: AIPokemon, move: AIMove, responses: AIMove[],
	field: FieldConditions, attackerSide?: SideConditions, defenderSide?: SideConditions
): boolean {
	const attacks = responses.map(response => resolveMove(defender, response, field))
		.filter(response => response.category !== 'Status');
	return goesFirst(attacker, defender, move, attacks,
		field, attackerSide, defenderSide);
}

/** Order against public/preset responses, without reading the opponent's selected action. */
export function actsBeforeTarget(state: BattleState, attacker: AIPokemon, target: AIPokemon, move: AIMove): boolean {
	const knowledge = target.moveKnowledge;
	const moves = knowledge ? [...knowledge.revealedMoves, ...knowledge.presetCandidates] : target.moves;
	const dex = rulesDex(state.field);
	const side = state.self.active.includes(target) ? state.self : state.opponent;
	return compareActionOrder(attacker, target, move, moves.map(id => dex.moves.get(id)),
		state.field, state.self.conditions, side.conditions) > 0;
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

		const priority = effectivePriority(attacker, move, field);

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
export function getPriorityMoves(
	pokemon: AIPokemon, moves: AIMove[], field: Partial<FieldConditions> = {}
): AIMove[] {
	return moves.filter(move => !move.disabled && effectivePriority(pokemon, move, field) > 0);
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
