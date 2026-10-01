/**
 * CFRU AI - Knockout Calculation Utilities
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Knockout and survival calculation functions.
 * Based on CFRU ai_util.c knockout logic.
 *
 * @license MIT
 */

import type { AIPokemon, AIMove, KnockoutResult, AICache, FieldConditions } from '../types';
import { calculateDamage, findStrongestMove } from './damage-calc';
import { isFaster, goesFirst } from './speed';

/**
 * Full knockout analysis for a move against a target
 * Based on CFRU CanKnockOut, Can2HKO, etc.
 */
export function analyzeKnockout(
	attacker: AIPokemon,
	defender: AIPokemon,
	move: AIMove,
	defenderMoves: AIMove[],
	field: FieldConditions,
	cache?: AICache
): KnockoutResult {
	// Check cache
	const cacheKey = `ko-${attacker.slot}-${defender.slot}-${move.id}`;
	if (cache?.knockoutCalc.has(cacheKey)) {
		return cache.knockoutCalc.get(cacheKey)!;
	}

	const damage = calculateDamage(attacker, defender, move, field, cache);

	// Determine if attacker goes first
	const attackerGoesFirst = goesFirst(attacker, defender, move, defenderMoves, field);
	const opponentGoesFirst = !attackerGoesFirst;

	// Check if attacker can be revenge killed
	let canBeRevenged = false;
	if (opponentGoesFirst && defenderMoves.length > 0) {
		const strongestDefenderMove = findStrongestMove(defender, attacker, defenderMoves, field, cache);
		if (strongestDefenderMove && strongestDefenderMove.damage.canKO) {
			canBeRevenged = true;
		}
	}

	const result: KnockoutResult = {
		canKO: damage.canKO,
		can2HKO: damage.hitsToKO <= 2,
		can3HKO: damage.hitsToKO <= 3,
		guaranteedKO: damage.guaranteedKO,
		hitsToKO: damage.hitsToKO,
		opponentGoesFirst,
		canBeRevenged,
	};

	// Cache result
	if (cache) {
		cache.knockoutCalc.set(cacheKey, result);
	}

	return result;
}

/**
 * Check if a Pokemon will faint from the opponent's attack
 * Based on CFRU WillFaintFromSecondaryDamage and similar
 */
export function willFaintFromAttack(
	defender: AIPokemon,
	attacker: AIPokemon,
	attackerMoves: AIMove[],
	field: FieldConditions,
	cache?: AICache
): { willFaint: boolean; bestMove: AIMove | null } {
	const strongestMove = findStrongestMove(attacker, defender, attackerMoves, field, cache);

	if (!strongestMove) {
		return { willFaint: false, bestMove: null };
	}

	return {
		willFaint: strongestMove.damage.canKO,
		bestMove: strongestMove.move,
	};
}

/**
 * Check if attacker can KO before being KO'd
 * Critical for deciding whether to attack or switch
 */
export function canKOBeforeBeingKOd(
	attacker: AIPokemon,
	defender: AIPokemon,
	attackerMoves: AIMove[],
	defenderMoves: AIMove[],
	field: FieldConditions,
	cache?: AICache
): {
	canWin: boolean;
	attackerBestMove: AIMove | null;
	attackerGoesFirst: boolean;
	mutualKO: boolean;
} {
	const attackerBest = findStrongestMove(attacker, defender, attackerMoves, field, cache);
	const defenderBest = findStrongestMove(defender, attacker, defenderMoves, field, cache);

	if (!attackerBest) {
		return {
			canWin: false,
			attackerBestMove: null,
			attackerGoesFirst: false,
			mutualKO: false,
		};
	}

	const attackerGoesFirst = goesFirst(attacker, defender, attackerBest.move, defenderMoves, field);
	const attackerCanKO = attackerBest.damage.canKO;
	const defenderCanKO = defenderBest?.damage.canKO ?? false;

	// If attacker goes first and can KO, attacker wins
	if (attackerGoesFirst && attackerCanKO) {
		return {
			canWin: true,
			attackerBestMove: attackerBest.move,
			attackerGoesFirst: true,
			mutualKO: false,
		};
	}

	// If defender goes first and can KO, attacker loses (unless mutual KO)
	if (!attackerGoesFirst && defenderCanKO) {
		return {
			canWin: false,
			attackerBestMove: attackerBest.move,
			attackerGoesFirst: false,
			mutualKO: attackerCanKO, // If both can KO, mutual KO scenario
		};
	}

	// Neither can OHKO on the first turn
	// Compare turns to KO
	const attackerTurnsToKO = attackerBest.damage.hitsToKO;
	const defenderTurnsToKO = defenderBest?.damage.hitsToKO ?? Infinity;

	// Adjust for who goes first
	const effectiveAttackerTurns = attackerGoesFirst ? attackerTurnsToKO : attackerTurnsToKO;
	const effectiveDefenderTurns = attackerGoesFirst ? defenderTurnsToKO : defenderTurnsToKO - 1;

	return {
		canWin: effectiveAttackerTurns <= effectiveDefenderTurns,
		attackerBestMove: attackerBest.move,
		attackerGoesFirst,
		mutualKO: effectiveAttackerTurns === effectiveDefenderTurns,
	};
}

/**
 * Calculate survival turns for a Pokemon
 * How many turns can this Pokemon survive against the opponent?
 */
export function calculateSurvivalTurns(
	defender: AIPokemon,
	attacker: AIPokemon,
	attackerMoves: AIMove[],
	field: FieldConditions,
	cache?: AICache
): number {
	const strongestMove = findStrongestMove(attacker, defender, attackerMoves, field, cache);

	if (!strongestMove) {
		return Infinity; // Attacker has no damaging moves
	}

	return strongestMove.damage.hitsToKO;
}

/**
 * Check if a Pokemon can revenge kill (KO a weakened opponent)
 * Based on CFRU revenge killing logic
 */
export function canRevengeKill(
	revengeKiller: AIPokemon,
	target: AIPokemon,
	revengeKillerMoves: AIMove[],
	targetMoves: AIMove[],
	field: FieldConditions,
	cache?: AICache
): {
	canRevenge: boolean;
	move: AIMove | null;
	needsPriority: boolean;
} {
	// Check if revenge killer can OHKO
	const strongestMove = findStrongestMove(revengeKiller, target, revengeKillerMoves, field, cache);

	if (!strongestMove || !strongestMove.damage.canKO) {
		return { canRevenge: false, move: null, needsPriority: false };
	}

	// Check if revenge killer outspeeds
	const goesFirstWithStrongest = goesFirst(revengeKiller, target, strongestMove.move, targetMoves, field);

	if (goesFirstWithStrongest) {
		return {
			canRevenge: true,
			move: strongestMove.move,
			needsPriority: false,
		};
	}

	// Check priority moves
	for (const move of revengeKillerMoves) {
		if (move.disabled || move.category === 'Status' || move.priority <= 0) continue;

		const damage = calculateDamage(revengeKiller, target, move, field, cache);
		if (damage.canKO) {
			return {
				canRevenge: true,
				move,
				needsPriority: true,
			};
		}
	}

	return { canRevenge: false, move: null, needsPriority: false };
}

/**
 * Check if a Pokemon is in "KO range" (can be knocked out next turn)
 */
export function isInKORange(
	pokemon: AIPokemon,
	opponent: AIPokemon,
	opponentMoves: AIMove[],
	field: FieldConditions,
	cache?: AICache
): boolean {
	const strongestMove = findStrongestMove(opponent, pokemon, opponentMoves, field, cache);
	return strongestMove?.damage.canKO ?? false;
}

/**
 * Determine the best KO move against a target
 * Considers accuracy, secondary effects, etc.
 */
export function getBestKOMove(
	attacker: AIPokemon,
	defender: AIPokemon,
	moves: AIMove[],
	field: FieldConditions,
	cache?: AICache
): AIMove | null {
	const koMoves: { move: AIMove; score: number }[] = [];

	for (const move of moves) {
		if (move.disabled || move.category === 'Status') continue;

		const damage = calculateDamage(attacker, defender, move, field, cache);

		if (damage.canKO) {
			// Score based on reliability
			let score = 100;

			// Prefer guaranteed KO
			if (damage.guaranteedKO) {
				score += 20;
			}

			// Accuracy penalty
			if (move.accuracy !== true && move.accuracy < 100) {
				score -= (100 - move.accuracy);
			}

			// Prefer no recoil
			if (move.flags['recoil']) {
				score -= 10;
			}

			// Prefer no charge/recharge
			if (move.flags['charge'] || move.flags['recharge']) {
				score -= 30;
			}

			koMoves.push({ move, score });
		}
	}

	if (koMoves.length === 0) {
		return null;
	}

	// Sort by score
	koMoves.sort((a, b) => b.score - a.score);

	return koMoves[0].move;
}

/**
 * Check if switching is safer than staying in
 * Based on CFRU ShouldSwitchToAvoidDeath
 */
export function shouldSwitchToAvoidDeath(
	currentPokemon: AIPokemon,
	opponent: AIPokemon,
	opponentMoves: AIMove[],
	currentMoves: AIMove[],
	reserves: AIPokemon[],
	field: FieldConditions,
	cache?: AICache
): {
	shouldSwitch: boolean;
	reason: string;
	bestSwitch: AIPokemon | null;
} {
	// Check if current Pokemon will be KO'd
	if (!isInKORange(currentPokemon, opponent, opponentMoves, field, cache)) {
		return {
			shouldSwitch: false,
			reason: 'not_in_ko_range',
			bestSwitch: null,
		};
	}

	// Check if current Pokemon can KO first
	const koAnalysis = canKOBeforeBeingKOd(
		currentPokemon, opponent, currentMoves, opponentMoves, field, cache
	);

	if (koAnalysis.canWin) {
		return {
			shouldSwitch: false,
			reason: 'can_ko_first',
			bestSwitch: null,
		};
	}

	// Look for a better switch-in
	let bestSwitch: AIPokemon | null = null;
	let bestScore = -Infinity;

	for (const reserve of reserves) {
		if (reserve.fainted) continue;

		// Check if this reserve would be KO'd too
		if (isInKORange(reserve, opponent, opponentMoves, field, cache)) {
			continue;
		}

		// Score based on matchup
		let score = 0;

		// Bonus for resisting opponent's moves
		const strongestOpponentMove = findStrongestMove(opponent, reserve, opponentMoves, field, cache);
		if (strongestOpponentMove) {
			// Higher damage = worse
			score -= strongestOpponentMove.damage.averagePercent;
		}

		if (score > bestScore) {
			bestScore = score;
			bestSwitch = reserve;
		}
	}

	if (bestSwitch) {
		return {
			shouldSwitch: true,
			reason: 'found_better_switch',
			bestSwitch,
		};
	}

	// No good switch available, stay in (sacrifice)
	return {
		shouldSwitch: false,
		reason: 'no_safe_switch',
		bestSwitch: null,
	};
}
