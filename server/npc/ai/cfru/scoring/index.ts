/**
 * CFRU AI - Scoring Engine
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Main scoring engine that evaluates moves using the CFRU scoring system.
 * Scoring flow: Base (100) -> Negatives -> Positives -> Final
 *
 * @license MIT
 */

import { beneficialTargets } from '../util/move-effects';
import {
	BASE_SCORE,
	type AIPokemon,
	type AIMove,
	type BattleState,
	type MoveScore,
	type MoveScoreFlags,
	type ScoreBreakdown,
	type ScoreAdjustment,
	type CFRUAIConfig,
	type AICache,
} from '../types';
import type { Dex } from '../../../../../sim/dex';
import { calculateDamage } from '../util/damage-calc';
import { attacksFirst } from '../util/speed';
import { resolveMove } from '../util/type-calc';
import { rulesDex } from '../util/mechanics';
import { buildAIMove } from '../state-builder';

// Import all negative and positive scorers
import { allNegativeScorers } from './negatives';
import { allPositiveScorers } from './positives';

// Re-export for external use
export { allNegativeScorers } from './negatives';
export { allPositiveScorers } from './positives';

/**
 * Scoring context passed to negative/positive scoring functions
 */
export interface ScoringContext {
	/** Every scorer reads rules from this format, never the global default generation. */
	dex: ReturnType<typeof Dex.forFormat>;
	/** Battle state */
	state: BattleState;

	/** Attacking Pokemon */
	attacker: AIPokemon;

	/** Target Pokemon */
	target: AIPokemon;

	/** Move being scored */
	move: AIMove;

	/** AI configuration */
	config: CFRUAIConfig;

	/** Calculation cache */
	cache: AICache;
	/** Injected damage semantics, including the caller-owned calculation cache. */
	calculateDamage?: typeof calculateDamage;

	/** A discouraged action remains selectable but receives no positive rewards. */
	skipPositiveScoring?: boolean;

	/** Current score */
	score: number;

	/** Score adjustments for tracking */
	adjustments: ScoreAdjustment[];

	/** Pre-calculated damage result */
	damageResult: ReturnType<typeof calculateDamage> | null;

	/** Move score flags */
	flags: MoveScoreFlags;

	/** Whether the target is our partner (doubles only) */
	isTargetingPartner: boolean;

	/** Partner Pokemon (doubles only, null in singles) */
	partner: AIPokemon | null;
}

/**
 * Negative scoring function type
 */
export type NegativeScoringFunction = (ctx: ScoringContext) => number;

/**
 * Positive scoring function type
 */
export type PositiveScoringFunction = (ctx: ScoringContext) => number;

/** Cut the below-baseline group only across a clear gap at the baseline boundary.
 * Effects and tactical value belong exclusively to the scoring rules.
 */
export function selectMoveCandidates(scores: readonly MoveScore[], gap: number): MoveScore[] {
	if (!(gap > 0)) throw new Error('Score gap must be positive');
	const effective = scores.filter(s => !s.flags.hasNoEffect && !s.flags.isImmune);
	const candidates = effective.length ? effective : scores;
	const higher = candidates.filter(s => s.score >= BASE_SCORE);
	const lower = candidates.filter(s => s.score < BASE_SCORE);
	if (!higher.length || !lower.length) return [...candidates];
	const boundary = Math.min(...higher.map(s => s.score)) - Math.max(...lower.map(s => s.score));
	return boundary > gap ? higher : [...candidates];
}

/**
 * Scoring Engine - Main class for evaluating moves
 */
export class ScoringEngine {
	private config: CFRUAIConfig;
	private cache: AICache;
	private calculateDamage: typeof calculateDamage;
	private negativeScorers: NegativeScoringFunction[] = [];
	private positiveScorers: PositiveScoringFunction[] = [];

	constructor(config: CFRUAIConfig, cache: AICache, damage = calculateDamage) {
		this.calculateDamage = damage;
		this.config = config;
		this.cache = cache;

		// Register default scorers (basic ones for Normal AI)
		this.registerDefaultScorers();
	}

	/**
	 * Register default negative and positive scorers
	 */
	private registerDefaultScorers(): void {
		// Use all negative scorers from negatives.ts
		this.negativeScorers = [...allNegativeScorers];

		// Use all positive scorers from positives.ts
		this.positiveScorers = [...allPositiveScorers];
	}

	/**
	 * Add a negative scoring function
	 */
	addNegativeScorer(scorer: NegativeScoringFunction): void {
		this.negativeScorers.push(scorer);
	}

	/**
	 * Add a positive scoring function
	 */
	addPositiveScorer(scorer: PositiveScoringFunction): void {
		this.positiveScorers.push(scorer);
	}

	/**
	 * Score all moves for a Pokemon against a target
	 */
	scoreMoves(
		state: BattleState,
		attacker: AIPokemon,
		moves: AIMove[],
		target: AIPokemon
	): MoveScore[] {
		const scores: MoveScore[] = [];

		for (const move of moves) {
			if (move.disabled) {
				// Disabled moves get score 0
				scores.push(this.createDisabledScore(move, target));
				continue;
			}

			scores.push(this.scoreMove(state, attacker, move, target));
		}

		// Mark the best move
		if (scores.length > 0) {
			const maxScore = Math.max(...scores.map(s => s.score));
			for (const score of scores) {
				if (score.score === maxScore) {
					score.flags.isStrongestMove = true;
					break; // Only mark the first one if tied
				}
			}
		}

		return scores;
	}

	/**
	 * Score a single move against a target
	 */
	scoreMove(
		state: BattleState,
		attacker: AIPokemon,
		move: AIMove,
		target: AIPokemon
	): MoveScore {
		state = { ...state, field: { ...state.field, formatId: this.config.formatId || state.field.formatId } };
		const recipients = beneficialTargets(state, attacker, move);
		if (recipients && !recipients.includes(target)) target = recipients[0] || attacker;
		move = resolveMove(attacker, move, state.field, target);
		const isTargetingPartner = state.self.active.includes(target);
		const dex = rulesDex(state.field);
		// Pre-calculate damage for non-status moves
		let damageResult = null;
		if (move.category !== 'Status') {
			// Calculate spread move info for doubles/multi (CFRU: damage_calc.c:3239-3247)
			let spreadInfo: { isDoubles: boolean, numAliveTargets: number } | undefined;
			if (state.isDoubles) {
				const moveTarget = move.target;
				if (moveTarget === 'allAdjacentFoes') {
					// Count alive opponents
					const numAliveOpponents = state.opponent.active.filter(p => !p.fainted).length;
					spreadInfo = { isDoubles: true, numAliveTargets: numAliveOpponents };
				} else if (moveTarget === 'allAdjacent') {
					// Count all alive Pokemon except attacker (opponents + partner)
					const numAliveOpponents = state.opponent.active.filter(p => !p.fainted).length;
					const numAlivePartners = state.self.active.filter(p => p !== attacker && !p.fainted).length;
					spreadInfo = { isDoubles: true, numAliveTargets: numAliveOpponents + numAlivePartners };
				}
			}
			damageResult = this.calculateDamage(attacker, target, move, state.field, this.cache, {
				isDoubles: state.isDoubles, numAliveTargets: 1, ...spreadInfo,
				attackerSideConditions: state.self.conditions,
				defenderSideConditions: (isTargetingPartner ? state.self : state.opponent).conditions,
				isAllyTarget: isTargetingPartner,
				activePokemon: [...state.self.active, ...state.opponent.active],
				defenderAllies: (isTargetingPartner ? state.self : state.opponent).active,
			});
		}

		const knowledge = target.moveKnowledge;
		const responseIds = knowledge ? [...knowledge.revealedMoves, ...knowledge.presetCandidates] : target.moves;
		const responses = responseIds.map(id => buildAIMove({ id }, 1, state.field.formatId));

		// Initialize flags
		const flags: MoveScoreFlags = {
			canKO: damageResult?.canKO ?? false,
			can2HKO: !!damageResult && !dex.moves.get(move.id).selfdestruct && damageResult.hitsToKO <= 2,
			goesFirst: attacksFirst(attacker, target, move, responses, state.field,
				state.self.conditions, isTargetingPartner ? state.self.conditions : state.opponent.conditions),
			isStrongestMove: false,
			isImmune: damageResult?.effectiveness === 0,
			isSuperEffective: (damageResult?.effectiveness ?? 1) > 1,
			hasNoEffect: false,
		};

		// Find partner Pokemon (doubles only)
		let partner: AIPokemon | null = null;
		if (state.isDoubles) {
			partner = state.self.active.find(p => p !== attacker && !p.fainted) || null;
		}

		// Create scoring context
		const ctx: ScoringContext = {
			dex,
			state,
			attacker,
			target,
			move,
			config: this.config,
			cache: this.cache,
			calculateDamage: this.calculateDamage,
			score: BASE_SCORE,
			adjustments: [],
			damageResult,
			flags,
			isTargetingPartner,
			partner,
		};

		// Run negative scorers
		let totalNegatives = 0;
		for (const scorer of this.negativeScorers) {
			const adjustment = scorer(ctx);
			if (adjustment !== 0) {
				totalNegatives += adjustment;
				ctx.score += adjustment; // Negatives subtract

				// If score drops to 0 or below, stop early
				if (ctx.score <= 0) {
					ctx.score = 0;
					break;
				}
			}
		}

		// Run positive scorers (only if score > 0)
		let totalPositives = 0;
		if (ctx.score > 0 && !ctx.skipPositiveScoring && !ctx.flags.hasNoEffect && !ctx.flags.isImmune) {
			for (const scorer of this.positiveScorers) {
				const adjustment = scorer(ctx);
				if (adjustment !== 0) {
					totalPositives += adjustment;
					ctx.score += adjustment;
				}
			}
		}

		if (ctx.flags.fixedScore !== undefined && !ctx.flags.hasNoEffect && !ctx.flags.isImmune) {
			const adjustment = ctx.flags.fixedScore - ctx.score;
			if (adjustment) {
				ctx.adjustments.push({ reason: 'Fixed tactical score', amount: adjustment, category: 'negative' });
				totalNegatives += adjustment;
				ctx.score = ctx.flags.fixedScore;
			}
		}

		// Create breakdown
		const breakdown: ScoreBreakdown = {
			base: BASE_SCORE,
			negatives: totalNegatives,
			positives: totalPositives,
			styleAdjust: 0, // Will be added by advanced AI
			final: ctx.score,
			details: ctx.adjustments,
		};

		return {
			move,
			score: ctx.score,
			breakdown,
			flags,
			target,
		};
	}

	/**
	 * Create a score for a disabled move
	 */
	private createDisabledScore(move: AIMove, target: AIPokemon): MoveScore {
		return {
			move,
			score: 0,
			breakdown: {
				base: BASE_SCORE,
				negatives: -BASE_SCORE,
				positives: 0,
				styleAdjust: 0,
				final: 0,
				details: [{ reason: 'Move is disabled', amount: -BASE_SCORE, category: 'negative' }],
			},
			flags: {
				canKO: false,
				can2HKO: false,
				goesFirst: false,
				isStrongestMove: false,
				isImmune: false,
				isSuperEffective: false,
				hasNoEffect: true,
			},
			target,
		};
	}

	/**
	 * Update configuration
	 */
	updateConfig(config: Partial<CFRUAIConfig>): void {
		this.config = { ...this.config, ...config };
	}

	/**
	 * Update cache
	 */
	updateCache(cache: AICache): void {
		this.cache = cache;
	}

	/**
	 * Set custom scorers (for different AI difficulties)
	 */
	setScorers(
		negatives: NegativeScoringFunction[],
		positives: PositiveScoringFunction[]
	): void {
		this.negativeScorers = negatives;
		this.positiveScorers = positives;
	}

	/**
	 * Clear all scorers
	 */
	clearScorers(): void {
		this.negativeScorers = [];
		this.positiveScorers = [];
	}
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a new scoring engine with the given configuration
 */
export function createScoringEngine(config: CFRUAIConfig, cache: AICache): ScoringEngine {
	return new ScoringEngine(config, cache);
}

/**
 * Create a basic scoring engine with minimal scorers (for Easy AI)
 */
export function createBasicScoringEngine(config: CFRUAIConfig, cache: AICache): ScoringEngine {
	const engine = new ScoringEngine(config, cache);
	// Basic AI only uses essential scorers
	engine.clearScorers();
	// Will use the default scorers which are already comprehensive
	return engine;
}
