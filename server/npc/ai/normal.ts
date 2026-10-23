/**
 * NormalAI - Normal Difficulty NPC Battle AI
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * A smart AI that uses the CFRU scoring system for move selection.
 * Features:
 * - Full damage calculation (type, STAB, abilities, items)
 * - Basic switching logic (trapped, Wonder Guard, bad moves)
 * - Status move evaluation
 * - Singles and doubles support
 * - Decision logging for debugging
 *
 * @license MIT
 */

import { moveTargets, protectsPendingWish, recoveryCuresStatus, mustSkipMove, estimatedMoveAccuracy } from './cfru/util/move-effects';
import { effectiveAbility, effectiveItem, replaceActivePokemon } from './cfru/util/mechanics';
import { needsResidualReset, entryHazardDamage } from './cfru/util/turn-outcome';
import { megaEvolutionState } from './cfru/util/forms';

import type { ObjectReadWriteStream } from '../../../lib/streams';
import type { ChoiceRequest } from '../../../sim/side';
import type { PRNGSeed } from '../../../sim/prng';
import { PRNG } from '../../../sim/prng';
import { Dex, toID } from '../../../sim/dex';
import { NPCBattleAI, MoveChoice, SwitchChoice, AIConfig } from './index';
import {
	CFRUAIConfig,
	DEFAULT_AI_CONFIG,
	AICache,
	BattleState,
	AIMove,
	AIPokemon,
	MoveScore,
	createAICache,
} from './cfru/types';
import { createScoringEngine, ScoringEngine } from './cfru/scoring';
import {
	buildBattleStateWithTracker, buildAIMove, buildPokemonFromRequest,
} from './cfru/state-builder';
import { calculateDamage, getEffectiveHpAfterSecondary } from './cfru/util/damage-calc';
import { resolveMove } from './cfru/util/type-calc';
import { attacksFirst } from './cfru/util/speed';
import { getOpponentThreatMoves } from './cfru/util/opponent-presets';
import { createCache, updateCacheTurn } from './cfru/util/cache';
import { AIDecisionLogger, LogLevel, createBattleLogger, SwitchScoreLog } from './cfru/logger';
import { BattleTracker, createBattleTracker, TrackedPokemon } from './cfru/util/battle-tracker';

/** NormalAI configuration options */
export interface NormalAIOptions {
	/** Side label used by the Multi coordinator's per-player decision log. */
	side?: 'p2' | 'p4';
	/** PRNG seed */
	seed?: PRNG | PRNGSeed | null;

	/** CFRU AI config */
	cfruConfig?: Partial<CFRUAIConfig>;

	/** Logging options */
	logging?: {
		/** Console log level */
		console?: LogLevel;
		/** File log level */
		file?: LogLevel;
		/** Log directory (for file logging) */
		logDir?: string;
	};

	/** Battle ID for logging */
	battleId?: string;
}

/**
 * NormalAI - Uses CFRU scoring system for smart decisions
 */
export class NormalAI extends NPCBattleAI {
	readonly difficulty = 'normal';

	protected override chooseTeamPreview(team: AnyObject[]): string {
		return `team ${this.prng.sample(team.map((_, index) => index + 1))}`;
	}

	/** CFRU AI configuration */
	private cfruConfig: CFRUAIConfig;

	/** Scoring engine */
	private scoringEngine: ScoringEngine;

	/** AI calculation cache */
	private aiCache: AICache;

	/** Current battle state */
	private battleState: BattleState | null = null;

	/** Reference to battle object (set during requests) */
	private battleRef: AnyObject | null = null;

	/** Current turn number */
	private currentTurn: number = 0;
	private activeSlotOffset = 0;

	/** Decision logger */
	private logger: AIDecisionLogger;

	/** Last move scores (for logging) */
	private lastMoveScores: MoveScore[] = [];

	/** Last move scores by target slot (for doubles logging) */
	private lastMoveScoresByTarget: Map<number, MoveScore[]> = new Map();

	/** Battle state tracker for opponent info */
	protected tracker: BattleTracker;

	constructor(
		playerStream: ObjectReadWriteStream<string>,
		options: NormalAIOptions = {},
		debug = false
	) {
		// NormalAI config: use status moves, basic switching, full damage calc
		const config: Partial<AIConfig> = {
			useStatusMoves: true,
			canSwitch: true,
			damageCalc: 'full',
		};

		super(playerStream, config, { seed: options.seed }, debug);

		// CFRU configuration
		this.cfruConfig = {
			...DEFAULT_AI_CONFIG,
			...options.cfruConfig,
		};

		// Initialize cache
		this.aiCache = createCache(0);

		// Initialize scoring engine
		this.scoringEngine = createScoringEngine(this.cfruConfig, this.aiCache);

		// Initialize logger
		this.logger = createBattleLogger(
			options.battleId || `battle-${Date.now()}`,
			options.side || 'p2',
			{
				console: options.logging?.console ?? LogLevel.NONE,
				file: options.logging?.file ?? LogLevel.NONE,
				logDir: options.logging?.logDir,
			}
		);

		// Create battle tracker (we are p2, opponent is p1)
		this.tracker = createBattleTracker('p2');
	}

	/**
	 * Set battle reference for accessing full battle state
	 * Also attaches the tracker to the battle stream
	 */
	setBattle(battle: AnyObject): void {
		this.battleRef = battle;
		this.tracker.setFormat(battle.format || '');

		// Update formatId in cfruConfig for level resolution
		if (battle.format) {
			this.cfruConfig = {
				...this.cfruConfig,
				formatId: battle.format,
			};
		}

		// Attach tracker to battle stream for opponent monitoring
		if (battle.stream) {
			this.tracker.attachToStream(battle.stream);
		}
	}

	/**
	 * Get the battle tracker (for subclasses or external access)
	 */
	getTracker(): BattleTracker {
		return this.tracker;
	}

	/**
	 * Get the decision logger for external access
	 */
	getLogger(): AIDecisionLogger {
		return this.logger;
	}

	/**
	 * Enable/disable console logging
	 */
	setConsoleLogging(level: LogLevel): void {
		this.logger.updateConfig({ consoleLevel: level });
	}

	/**
	 * Enable file logging
	 */
	setFileLogging(level: LogLevel, logDir: string): void {
		this.logger.updateConfig({
			fileLevel: level,
			logFilePath: `${logDir}/ai-log-${this.logger['config'].battleId}-p2.txt`,
		});
	}

	/**
	 * Override receiveRequest to update battle state
	 */
	override receiveRequest(request: ChoiceRequest): void {
		if (request.wait) return;
		const state = buildBattleStateWithTracker(request, this.battleRef, this.tracker, this.cfruConfig);
		state.turn = this.battleRef?.turn ?? (this.tracker.getTurn() || this.currentTurn + 1);
		this.receiveRequestWithState(request, state);
	}

	/** Multi supplies the public team state; switch candidates still come only from this player's request. */
	receiveRequestWithState(request: ChoiceRequest, state: BattleState, activeSlot = 1): void {
		this.currentTurn = state.turn;
		this.aiCache = updateCacheTurn(this.aiCache, state.turn);
		this.scoringEngine.updateCache(this.aiCache);
		this.battleState = state;
		this.cfruConfig.isDoubles = state.isDoubles;
		this.scoringEngine.updateConfig(this.cfruConfig);
		this.activeSlotOffset = activeSlot - 1;
		try {
			super.receiveRequest(request);
		} finally {
			this.activeSlotOffset = 0;
		}
	}

	/**
	 * Make decision for current turn using CFRU scoring
	 * @param activeIndex - Index of the active Pokemon (0 or 1 in doubles)
	 */
	protected override makeDecision(...args: Parameters<NormalAI['decide']>): ReturnType<NormalAI['decide']> {
		const state = this.battleState;
		const actor = state?.self.active.find(p => p.slot === (args[4] || 0) + this.activeSlotOffset + 1);
		const mega = state && actor && args[3].canMegaEvo ? megaEvolutionState(state, actor) : null;
		if (mega) this.battleState = mega;
		try {
			return this.decide(...args);
		} finally {
			this.battleState = state;
		}
	}

	private decide(
		active: AnyObject,
		moves: MoveChoice[],
		switches: SwitchChoice[],
		flags: {
			canMegaEvo: boolean;
			canUltraBurst: boolean;
			canZMove: boolean;
			canDynamax: boolean;
			canTerastallize: boolean;
		},
		activeIndex = 0
	): {
		type: 'move' | 'switch';
		slot?: number;
		target?: number;
		targetPos?: string;
		zMove?: boolean;
		transform?: 'mega' | 'ultra' | 'dynamax' | 'terastallize';
	} {
		activeIndex += this.activeSlotOffset;
		// Filter out disabled moves
		const availableMoves = moves.filter(m => !m.disabled);

		// Check if we should switch
		if (this.config.canSwitch && switches.length > 0) {
			const switchResult = this.evaluateSwitching(active, availableMoves, switches, activeIndex);
			if (switchResult.shouldSwitch) {
				// Log switch decision
				if (this.battleState) {
					const currentPokemon = this.battleState.self.active.find(p => p.slot === activeIndex + 1);
					const switchTo = this.battleState.self.reserve.find(p => p.slot === switchResult.switchTarget);
					if (currentPokemon && switchTo) {
						this.logger.logSwitchDecision(
							this.currentTurn,
							currentPokemon,
							switchTo,
							switchResult.switchScores,
							switchResult.reason,
							this.battleState
						);
					}
				}

				return {
					type: 'switch',
					target: switchResult.switchTarget,
				};
			}
		}

		// With no safe voluntary switch, use Struggle if no moves are available.
		if (!availableMoves.length) return { type: 'move', slot: 1 };

		// Score all moves and choose the best one
		const { bestMove, chosenMove, bestTargetPos } = this.chooseBestMoveWithScores(active, availableMoves, activeIndex);

		// Log move decision
		if (this.battleState && this.lastMoveScores.length > 0) {
			// Find attacker by slot (activeIndex + 1), not array index
			const attackerSlot = activeIndex + 1;
			const attacker = this.battleState.self.active.find(p => p.slot === attackerSlot);
			if (attacker) {
				const reasoning: string[] = [];
				const chosenScore = this.lastMoveScores.find(s => s.move.slot === bestMove.slot);
				if (chosenScore) {
					if (chosenScore.flags.canKO) reasoning.push('Can KO');
					if (chosenScore.flags.goesFirst) reasoning.push('Goes first');
					if (chosenScore.flags.isSuperEffective) reasoning.push('Super effective');
				}

				// Convert slot-based scores to name-based for logging
				let scoresByTargetName: Map<string, MoveScore[]> | undefined;
				let chosenTargetName: string | undefined;

				if (this.cfruConfig.isDoubles && this.lastMoveScoresByTarget.size > 0) {
					scoresByTargetName = new Map();
					const opponents = this.battleState.opponent.active.filter(p => !p.fainted);

					for (const [slot, scores] of this.lastMoveScoresByTarget) {
						const target = slot < 0 ? this.battleState.self.active.find(p => p.slot === -slot) :
							opponents.find(p => p.slot === slot);
						const targetName = target ? target.species : `Slot ${slot}`;
						scoresByTargetName.set(targetName, scores);

						// Track chosen target name
						if (bestTargetPos && parseInt(bestTargetPos) === slot) {
							chosenTargetName = targetName;
						}
					}
				}

				this.logger.logMoveDecision(
					this.currentTurn,
					attacker,
					this.lastMoveScores,
					chosenMove,
					this.battleState,
					reasoning,
					scoresByTargetName,
					chosenTargetName
				);
			}
		}

		// Use the best target position determined during scoring
		// (for doubles, this is the target that maximizes damage)
		let targetPos: string | undefined;
		if (this.cfruConfig.isDoubles && bestMove.target) {
			targetPos = bestTargetPos || this.getTargetPosition(bestMove, activeIndex);
		}

		return {
			type: 'move',
			slot: bestMove.slot,
			targetPos,
			zMove: bestMove.zMove,
		};
	}

	/**
	 * Choose the best move using CFRU scoring system
	 */
	protected chooseBestMove(active: AnyObject, moves: MoveChoice[]): MoveChoice {
		return this.chooseBestMoveWithScores(active, moves, 0).bestMove;
	}

	/**
	 * Choose the best move and return scores for logging
	 * In doubles, evaluates each move against all opponents and chooses best target
	 * @param activeIndex - Index of the attacking Pokemon (0 or 1 in doubles)
	 */
	private chooseBestMoveWithScores(active: AnyObject, moves: MoveChoice[], activeIndex = 0): {
		bestMove: MoveChoice;
		chosenMove: AIMove;
		bestTargetPos?: string;
	} {
		if (!this.battleState || this.battleState.opponent.active.length === 0) {
			// Fallback to random if no battle state
			const bestMove = this.prng.sample(moves);
			this.lastMoveScores = [];
			return {
				bestMove,
				chosenMove: this.convertToAIMoves([bestMove], active)[0],
			};
		}

		// Get attacker Pokemon using slot (activeIndex + 1)
		// In doubles, self.active only contains non-fainted Pokemon, so we need to find by slot
		const attackerSlot = activeIndex + 1;
		const attacker = this.battleState.self.active.find(p => p.slot === attackerSlot);
		if (!attacker) {
			const bestMove = this.prng.sample(moves);
			this.lastMoveScores = [];
			return {
				bestMove,
				chosenMove: this.convertToAIMoves([bestMove], active)[0],
			};
		}

		// Convert moves to AIMove format
		const aiMoves = this.convertToAIMoves(moves, active);

		// Get all active opponents (filter out fainted)
		const opponents = this.battleState.opponent.active.filter(p => !p.fainted);
		if (opponents.length === 0) {
			const bestMove = this.prng.sample(moves);
			this.lastMoveScores = [];
			return {
				bestMove,
				chosenMove: this.convertToAIMoves([bestMove], active)[0],
			};
		}

		const allScoresByTarget = new Map<number, MoveScore[]>();
		let candidates: { choice: MoveChoice, score: MoveScore, position: number }[] = [];
		for (const target of [...opponents, ...this.battleState.self.active.filter(p => !p.fainted)]) {
			const eligible = aiMoves.filter(move => moveTargets(this.battleState!, attacker, move).includes(target));
			if (!eligible.length) continue;
			const scores = this.scoringEngine.scoreMoves(this.battleState, attacker, eligible, target);
			this.preferReliableKOs(attacker, target, scores);
			const position = this.battleState.self.active.includes(target) ? -target.slot : target.slot;
			allScoresByTarget.set(position, scores);
			for (let i = 0; i < eligible.length; i++) {
				candidates.push({ choice: moves[aiMoves.indexOf(eligible[i])], score: scores[i], position });
			}
		}
		// Keep a legal fallback for an entire set of unusable ally-only moves.
		if (!candidates.length) {
			const bestMove = this.prng.sample(moves);
			this.lastMoveScores = this.scoringEngine.scoreMoves(this.battleState, attacker, aiMoves, opponents[0]);
			return { bestMove, chosenMove: aiMoves[moves.indexOf(bestMove)] };
		}
		// Preserve one candidate per spread move and stable move order for seeded tie-breaking.
		candidates = candidates.filter(candidate => {
			if (!['allAdjacent', 'allAdjacentFoes', 'all'].includes(candidate.score.move.target)) return true;
			const sameMove = candidates.filter(c => c.choice === candidate.choice);
			const maximum = Math.max(...sameMove.map(c => c.score.score));
			return sameMove.find(c => c.score.score === maximum) === candidate;
		});
		candidates.sort((a, b) => moves.indexOf(a.choice) - moves.indexOf(b.choice));
		const bestScore = Math.max(...candidates.map(c => c.score.score));
		const chosen = this.prng.sample(candidates.filter(c => c.score.score === bestScore));
		this.lastMoveScores = moves.flatMap(choice => {
			const options = candidates.filter(c => c.choice === choice);
			const best = options.sort((a, b) => b.score.score - a.score.score)[0];
			return best ? [best.score] : [];
		});
		this.lastMoveScoresByTarget = allScoresByTarget;
		// Use the request's targeting contract: dynamic spread moves still accept their original target input.
		const targeted = ['normal', 'any', 'adjacentFoe', 'adjacentAlly', 'adjacentAllyOrSelf'].includes(chosen.choice.target);
		return {
			bestMove: chosen.choice,
			chosenMove: chosen.score.move,
			bestTargetPos: this.cfruConfig.isDoubles && targeted ? String(chosen.position) : undefined,
		};
	}

	/**
	 * Convert MoveChoice to AIMove
	 */
	private convertToAIMoves(moves: MoveChoice[], active: AnyObject): AIMove[] {
		// 直接委托给 state-builder 的统一实现；MoveChoice 的字段是 buildAIMove 入参的超集
		return moves.map(m => buildAIMove(m, m.slot, this.cfruConfig.formatId));
	}

	/** Switch evaluation thresholds
	 * Analysis based on docs/ai-logic/NormalAI/logic.md:
	 *
	 * Attack threshold (95):
	 * - 100 - 2(resist) - 5(very low dmg) = 93 < 95 → triggers (correct: weak position)
	 * - 100 + 3(STAB) - 5(double resist) = 98 > 95 → no trigger (correct: STAB compensates)
	 * - 100 - 5(double resist) - 5(very low dmg) = 90 < 95 → triggers (correct: very weak)
	 *
	 * Status threshold (90):
	 * - 100 - 10~15(target has status) = 85~90 → triggers at 85 (correct: status useless)
	 * - 100 - 20(ability immune) = 80 < 90 → triggers (correct: completely blocked)
	 * - 100 + positive bonuses = 100+ > 90 → no trigger (correct: status useful)
	 */
	private static readonly SWITCH_THRESHOLD_ATTACK = 95;  // Attack move score below this triggers switch consideration
	private static readonly SWITCH_THRESHOLD_STATUS = 90;  // Status move score below this triggers switch consideration
	private static readonly SWITCH_THREAT_TRIGGER = 0.7;
	private static readonly SWITCH_THREAT_LIMIT = 0.4;

	/** Immediate, usable attacks that KO using the existing average-damage estimate. */
	private canKOWithAverageDamage(attacker: AIPokemon, target: AIPokemon, move: AIMove): boolean {
		const state = this.battleState!;
		move = resolveMove(attacker, move, state.field, target);
		if (move.disabled || move.category === 'Status' || attacker.volatiles.has('mustrecharge')) return false;
		if (attacker.status === 'slp' && attacker.sleepTurns !== 1 && move.id !== 'snore') return false;
		if (attacker.status === 'frz' && !move.flags.defrost) return false;
		// These attacks do not deal their calculated damage before the opponent acts this turn.
		if (['counter', 'mirrorcoat', 'metalburst', 'focuspunch', 'beakblast', 'shelltrap',
			'futuresight', 'doomdesire', 'suckerpunch'].includes(move.id)) return false;
		if (move.flags.charge && !attacker.volatiles.has(move.id) && !attacker.volatiles.has('twoturnmove') &&
			effectiveItem(attacker, state.field) !== 'powerherb' &&
			!(['solarbeam', 'solarblade'].includes(move.id) && state.field.weather === 'sun')) return false;
		if (target.volatiles.has('substitute') && !move.flags.sound &&
			effectiveAbility(attacker, state.field) !== 'infiltrator') return false;
		const numAliveTargets = this.battleState!.opponent.active.filter(p => !p.fainted).length +
			(move.target === 'allAdjacent' ? state.self.active.filter(p => !p.fainted && p !== attacker).length : 0);
		return calculateDamage(attacker, target, move, state.field, undefined,
			{ isDoubles: state.isDoubles, numAliveTargets, defenderAllies: state.opponent.active,
				activePokemon: [...state.self.active, ...state.opponent.active],
				attackerSideConditions: state.self.conditions,
				defenderSideConditions: state.opponent.conditions }).average >= target.hp;
	}

	/** A likely KO before the sole opponent acts takes precedence over incoming damage. */
	private canKOFirst(attacker: AIPokemon, target: AIPokemon, move: AIMove): boolean {
		if (!this.canKOWithAverageDamage(attacker, target, move)) return false;
		const state = this.battleState!;
		const knowledge = target.moveKnowledge;
		const responseIds = knowledge ? [...knowledge.revealedMoves, ...knowledge.presetCandidates] :
			getOpponentThreatMoves(target.species, target.moves, this.cfruConfig.formatId);
		const responses = responseIds.map(id => buildAIMove({ id }, 1, this.cfruConfig.formatId));
		// No known moves still means an ordinary-priority action, not a free turn.
		if (!responses.length) responses.push(buildAIMove({ id: 'tackle' }, 1, this.cfruConfig.formatId));
		if (!attacksFirst(attacker, target, move, responses, state.field, state.self.conditions, state.opponent.conditions)) {
			return false;
		}
		return true;
	}

	/** Prefer accuracy among lethal moves; retain ordinary scores as the tie-breaker. */
	private preferReliableKOs(attacker: AIPokemon, target: AIPokemon, scores: MoveScore[]): void {
		const kos = scores.filter(s => !s.flags.hasNoEffect && !s.flags.isImmune &&
			this.canKOWithAverageDamage(attacker, target, s.move));
		// Do not penalize a first-strike KO in favour of a more accurate move that goes second.
		const first = kos.filter(s => this.canKOFirst(attacker, target, s.move));
		const candidates = first.length ? first : kos;
		if (candidates.length < 2) return;
		const accuracy = (move: AIMove) => estimatedMoveAccuracy(attacker, target, move, this.battleState!.field);
		const reliable = candidates.reduce((best, candidate) =>
			accuracy(candidate.move) > accuracy(best.move) ||
			(accuracy(candidate.move) === accuracy(best.move) && candidate.score > best.score) ? candidate : best);
		for (const candidate of candidates) {
			if (accuracy(candidate.move) >= accuracy(reliable.move) || candidate.score < reliable.score) continue;
			const penalty = reliable.score - candidate.score - 1;
			candidate.score += penalty;
			candidate.breakdown.negatives += penalty;
			candidate.breakdown.final = candidate.score;
			candidate.breakdown.details.push({
				reason: `Prefer reliable KO: ${reliable.move.name} (${accuracy(reliable.move)}% vs ${accuracy(candidate.move)}%)`,
				amount: penalty, category: 'negative',
			});
		}
	}

	/** Sum of each opponent's strongest estimated attack, relative to the defender's current HP. */
	private getIncomingThreat(defender: AIPokemon, opponents: AIPokemon[], replacing = defender): number {
		if (defender.hp <= 0) return Infinity;
		const state = replacing === defender ? this.battleState! :
			replaceActivePokemon(this.battleState!, replacing, defender);
		let threat = 0;
		for (const opponent of opponents) {
			let strongest = 0;
			const knowledge = opponent.moveKnowledge;
			const moves = knowledge ? [...knowledge.revealedMoves, ...knowledge.presetCandidates] :
				getOpponentThreatMoves(opponent.species, opponent.moves, this.cfruConfig.formatId);
			const models = opponent.presetModels || [{ pokemon: opponent,
				moves: moves.map(id => ({ id })),
			}];
			for (const model of models) {
				if (mustSkipMove(model.pokemon, model.moves.map(m => m.id), state.field)) continue;
				const projected = replaceActivePokemon(state, opponent, model.pokemon);
				for (const { id: moveId } of model.moves) {
					const move = buildAIMove({ id: moveId }, 1, this.cfruConfig.formatId);
					if (move.category === 'Status') continue;
					const numAliveTargets = state.self.active.filter(p => !p.fainted).length +
						(move.target === 'allAdjacent' ? opponents.length - 1 : 0);
					// Reversed sides and bench slots can collide with the outgoing damage cache.
					const damage = calculateDamage(model.pokemon, defender, move, projected.field, undefined, {
						isDoubles: state.isDoubles, numAliveTargets,
						defenderAllies: state.self.active.filter(p => p !== defender),
						activePokemon: [...projected.self.active, ...projected.opponent.active],
						attackerSideConditions: state.opponent.conditions, defenderSideConditions: state.self.conditions,
					});
					strongest = Math.max(strongest, damage.average / defender.hp);
				}
			}
			threat += strongest;
		}
		return threat;
	}

	/** Switch evaluation result */
	private evaluateSwitching(
		active: AnyObject,
		moves: MoveChoice[],
		switches: SwitchChoice[],
		activeIndex = 0
	): {
		shouldSwitch: boolean;
		switchTarget: number;
		switchScores: SwitchScoreLog[];
		reason: string;
	} {
		const noSwitch = {
			shouldSwitch: false,
			switchTarget: 0,
			switchScores: [],
			reason: '',
		};

		if (!this.battleState) return noSwitch;

		const attacker = this.battleState.self.active.find(p => p.slot === activeIndex + 1);
		const opponents = this.battleState.opponent.active.filter(p => !p.fainted);

		if (!attacker || !opponents.length) return noSwitch;

		// Don't switch if trapped
		if (active.trapped) {
			return { ...noSwitch, reason: 'Trapped, cannot switch' };
		}

		// Score all moves
		const aiMoves = this.convertToAIMoves(moves, active);
		// Staying is useful if at least one living opponent offers a good move/target combination.
		let maxAttackScore = -Infinity;
		let maxStatusScore = -Infinity;
		let canClearAttrition = false;
		for (const target of opponents) {
			const scores = this.scoringEngine.scoreMoves(this.battleState, attacker, aiMoves, target);
			for (let i = 0; i < scores.length; i++) {
				if (opponents.length === 1 && !scores[i].flags.hasNoEffect && !scores[i].flags.isImmune &&
					this.canKOFirst(attacker, target, aiMoves[i])) {
					return { ...noSwitch, reason: 'Can KO first with average damage (ignoring accuracy)' };
				}
				const score = scores[i].score;
				if (score >= 115 && !scores[i].flags.hasNoEffect &&
					protectsPendingWish(this.battleState, attacker, aiMoves[i])) {
					return { ...noSwitch, reason: 'Protect to receive pending Wish' };
				}
				if (score > 60 && (aiMoves[i].id === 'rest' || recoveryCuresStatus(aiMoves[i]))) canClearAttrition = true;
				if (aiMoves[i].category === 'Status') {
					maxStatusScore = Math.max(maxStatusScore, score);
				} else {
					maxAttackScore = Math.max(maxAttackScore, score);
				}
			}
		}

		const threat = this.getIncomingThreat(attacker, opponents);
		const field = this.battleState.field;
		const foeAbility = opponents.some(p => effectiveAbility(p, field) === 'baddreams') ? 'baddreams' : '';
		const resetResidual = !canClearAttrition && needsResidualReset(attacker, field, foeAbility);
		const residualLoss = Math.max(0, attacker.hp - getEffectiveHpAfterSecondary(attacker, field.weather, foeAbility, field));
		// A reset can justify a costlier entry if it improves on staying under escalating attrition.
		const switchLimit = resetResidual ? Math.max(NormalAI.SWITCH_THREAT_LIMIT,
			Math.min(1, threat + residualLoss / attacker.hp)) : NormalAI.SWITCH_THREAT_LIMIT;
		const shouldConsiderSwitch = (
			maxAttackScore <= NormalAI.SWITCH_THRESHOLD_ATTACK &&
			maxStatusScore <= NormalAI.SWITCH_THRESHOLD_STATUS
		) || threat >= NormalAI.SWITCH_THREAT_TRIGGER ||
		resetResidual;

		if (shouldConsiderSwitch) {
			// Score all switch options with improved logic
			const switchScores: SwitchScoreLog[] = [];
			let bestSwitchSlot = 0;
			let bestSwitchScore = -Infinity;
			let bestSwitchPokemon = '';
			const position = `Position (atk:${Math.floor(maxAttackScore)}, status:${Math.floor(maxStatusScore)}, threat:${(threat * 100).toFixed(1)}%)`;

			for (const switchOption of switches) {
				// Get Pokemon name
				const pokemonName = switchOption.pokemon.details?.split(',')[0]?.trim() || `Slot ${switchOption.slot}`;
				// Build from this player's request: Multi teammates can have identical party slots.
				const defender = buildPokemonFromRequest(switchOption.pokemon, switchOption.slot, false, this.cfruConfig.formatId);
				const switchThreat = this.getIncomingThreat(defender, opponents, attacker);
				const hp = defender.hp - entryHazardDamage(defender, this.battleState.self.conditions, field) -
					defender.hp * switchThreat;
				const endHp = getEffectiveHpAfterSecondary({ ...defender, hp, hpPercent: 100 * hp / defender.maxHp },
					field.weather, foeAbility, field);
				if (switchThreat >= 1 || switchThreat > switchLimit || endHp <= 0) {
					switchScores.push({
						pokemon: pokemonName,
						score: 0,
						reasons: [endHp <= 0 ? 'Ineligible: cannot survive entry, the attack, and residual damage' :
							`Ineligible: incoming threat ${(switchThreat * 100).toFixed(1)}% exceeds ${(switchLimit * 100).toFixed(1)}%`],
					});
					continue;
				}
				const { score, reasons } = this.scoreSwitchMatchups(switchOption.pokemon, opponents);
				reasons.push(`Incoming threat ${(switchThreat * 100).toFixed(1)}%`);
				if (resetResidual) reasons.push('Reset escalating residual damage with a surviving replacement');

				switchScores.push({
					pokemon: pokemonName,
					score,
					reasons,
				});

				if (score > bestSwitchScore) {
					bestSwitchScore = score;
					bestSwitchSlot = switchOption.slot;
					bestSwitchPokemon = pokemonName;
				}
			}

			// Retain the existing threshold for a viable replacement.
			if (bestSwitchScore > 5) {
				return {
					shouldSwitch: true,
					switchTarget: bestSwitchSlot,
					switchScores,
					reason: `${position}, switching to ${bestSwitchPokemon} (score:${Math.floor(bestSwitchScore)})`,
				};
			}

			// Return scores even if we don't switch
			return {
				shouldSwitch: false,
				switchTarget: 0,
				switchScores,
				reason: `${position}, no eligible switch-in with score > 5 (best: ${Math.floor(bestSwitchScore)})`,
			};
		}

		return noSwitch;
	}

	/** Use the least favorable living opponent matchup for voluntary and forced replacements. */
	private scoreSwitchMatchups(pokemon: AnyObject, opponents: AIPokemon[]): { score: number; reasons: string[] } {
		const matchups = opponents.map(target => ({ target, ...this.scoreSwitchOption(pokemon, target) }));
		return {
			score: Math.min(...matchups.map(matchup => matchup.score)),
			reasons: matchups.flatMap(matchup => matchup.reasons.map(reason =>
				opponents.length > 1 ? `${matchup.target.species}: ${reason}` : reason
			)),
		};
	}

	/**
	 * Score a potential switch-in Pokemon
	 * Improved logic considering:
	 * 1. Type advantages (resist opponent moves, STAB super effective)
	 * 2. Survivability (HP percentage)
	 * 3. Dangerous switch-in penalties (weak to opponent STAB)
	 */
	private scoreSwitchOption(pokemon: AnyObject, target: AIPokemon): { score: number; reasons: string[] } {
		let score = 0;
		const reasons: string[] = [];

		const dex = this.cfruConfig.formatId ? Dex.forFormat(this.cfruConfig.formatId) : Dex;
		// Get Pokemon types and species data
		let types: string[] = [];
		let speciesData: AnyObject = {};
		if (pokemon.types) {
			types = pokemon.types;
		} else if (pokemon.details) {
			const speciesName = pokemon.details.split(',')[0].trim();
			speciesData = dex.species.get(speciesName);
			types = speciesData.types || [];
		}

		// Get Pokemon's known moves
		const pokemonMoves = pokemon.moves || [];

		// 1. Check resistance to opponent's known damaging moves
		let resistsCount = 0;
		let immuneCount = 0;
		let weakCount = 0;
		for (const moveId of target.moves) {
			const move = dex.moves.get(moveId);
			if (move.category === 'Status') continue;

			const effectiveness = dex.getImmunity(move.type, types) ? 2 ** dex.getEffectiveness(move.type, types) : 0;

			if (effectiveness === 0) {
				immuneCount++;
			} else if (effectiveness < 1) {
				resistsCount++;
			} else if (effectiveness > 1) {
				weakCount++;
			}
		}

		// Award points for resistances and immunities
		if (immuneCount > 0) {
			score += 12;
			reasons.push(`Immune to ${immuneCount} move(s)`);
		}
		if (resistsCount > 0) {
			score += 6 * Math.min(resistsCount, 2); // Cap at 2 for diminishing returns
			reasons.push(`Resists ${resistsCount} move(s)`);
		}

		// 2. Check if we have STAB super effective moves against target
		for (const moveId of pokemonMoves) {
			const move = dex.moves.get(moveId);
			if (move.category === 'Status' || move.basePower < 50) continue;

			// Check if STAB
			const isSTAB = types.includes(move.type);

			// Check effectiveness against target
			const effectiveness = dex.getImmunity(move.type, target.types) ?
				2 ** dex.getEffectiveness(move.type, target.types) : 0;

			if (effectiveness >= 2 && isSTAB) {
				score += 8;
				reasons.push(`STAB super effective (${move.name})`);
				break; // Only count once
			} else if (effectiveness >= 2) {
				score += 4;
				reasons.push(`Super effective (${move.name})`);
				break;
			}
		}

		// 3. Survivability - HP percentage
		const hpParts = pokemon.condition.split('/');
		if (hpParts.length === 2) {
			const currentHp = parseInt(hpParts[0]);
			const maxHp = parseInt(hpParts[1].split(' ')[0]);
			const hpPercent = (currentHp / maxHp) * 100;

			// HP bonus: 0-10 points based on HP%
			score += Math.floor(hpPercent / 10);
			if (hpPercent >= 80) {
				reasons.push(`High HP (${hpPercent.toFixed(0)}%)`);
			}

			// 4. Dangerous switch-in penalty
			// If low HP and weak to opponent's moves, big penalty
			if (hpPercent < 40 && weakCount > 0) {
				score -= 10;
				reasons.push(`Low HP + weak to opponent`);
			} else if (weakCount >= 2) {
				// Multiple weaknesses is dangerous even at full HP
				score -= 8;
				reasons.push(`Weak to ${weakCount} moves`);
			} else if (weakCount === 1 && hpPercent < 60) {
				score -= 5;
				reasons.push(`Weak to opponent move`);
			}
		}

		// 5. Check opponent's STAB types specifically (high priority danger)
		for (const opponentType of target.types) {
			// Check if we're weak to this type (opponent likely has STAB moves)
			const effectiveness = dex.getImmunity(opponentType, types) ?
				2 ** dex.getEffectiveness(opponentType, types) : 0;

			if (effectiveness >= 2) {
				// Already penalized above for known moves, add small extra penalty for STAB threat
				score -= 3;
				reasons.push(`Weak to ${opponentType} STAB`);
				break;
			}
		}

		return { score, reasons };
	}

	/**
	 * Choose Pokemon to switch to
	 * Uses the same scoring logic as evaluateSwitching for consistency
	 */
	protected override chooseSwitch(active: AnyObject | undefined, switches: SwitchChoice[]): number {
		const opponents = this.battleState?.opponent.active.filter(p => !p.fainted) || [];
		if (!opponents.length) {
			return this.prng.sample(switches).slot;
		}

		// Score each switch option using the improved scoring method
		const scored: { switch: SwitchChoice, score: number }[] = [];

		for (const sw of switches) {
			const { score } = this.scoreSwitchMatchups(sw.pokemon, opponents);
			scored.push({ switch: sw, score });
		}

		// Sort by score
		scored.sort((a, b) => b.score - a.score);

		// Return best, with some randomness among top choices
		const topScore = scored[0].score;
		const topSwitches = scored.filter(s => s.score >= topScore - 5);

		return this.prng.sample(topSwitches).switch.slot;
	}

	/**
	 * Get target position for doubles
	 * Target positions in Pokemon Showdown:
	 * - Positive numbers (1, 2) = opponent's Pokemon
	 * - Negative numbers (-1, -2) = ally Pokemon
	 * - 0 = no specific target (auto-select)
	 */
	private getTargetPosition(move: MoveChoice, activeIndex: number): string {
		// For ally-targeting moves
		if (move.target === 'adjacentAlly' || move.target === 'adjacentAllyOrSelf') {
			const partner = this.battleState?.self.active.find(p => p.slot !== activeIndex + 1 && !p.fainted);
			if (partner) return String(-partner.slot);
		}
		return this.getDefaultTargetPosition(move, activeIndex);
	}

	/**
	 * NormalAI doesn't strategically Dynamax yet
	 */
	protected override shouldDynamax(active: AnyObject): boolean {
		// 25% chance for now - strategic Dynamax comes with HardAI
		return this.prng.randomChance(1, 4);
	}
}
