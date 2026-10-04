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

import type { ObjectReadWriteStream } from '../../../lib/streams';
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
import { buildBattleState, buildBattleStateWithTracker, buildMovesFromRequest, buildAIMove } from './cfru/state-builder';
import { createCache, updateCacheTurn } from './cfru/util/cache';
import { AIDecisionLogger, LogLevel, createBattleLogger, SwitchScoreLog } from './cfru/logger';
import { BattleTracker, createBattleTracker, TrackedPokemon } from './cfru/util/battle-tracker';

/** NormalAI configuration options */
export interface NormalAIOptions {
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
			'p2',
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
	override receiveRequest(request: AnyObject): void {
		// Update turn and cache
		const newTurn = this.battleRef?.turn ?? this.currentTurn + 1;
		if (newTurn !== this.currentTurn) {
			this.currentTurn = newTurn;
			this.aiCache = updateCacheTurn(this.aiCache, newTurn);
			this.scoringEngine.updateCache(this.aiCache);
		}

		// Build battle state from request
		// Use tracker for server environment where battle.sides is not available
		this.battleState = buildBattleStateWithTracker(request, this.battleRef, this.tracker, this.cfruConfig);

		// Update doubles setting
		if (request.active && request.active.length > 1) {
			this.cfruConfig.isDoubles = true;
			this.scoringEngine.updateConfig(this.cfruConfig);
		}

		// Call parent implementation
		super.receiveRequest(request);
	}

	/**
	 * Make decision for current turn using CFRU scoring
	 * @param activeIndex - Index of the active Pokemon (0 or 1 in doubles)
	 */
	protected override makeDecision(
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
		// Filter out disabled moves
		const availableMoves = moves.filter(m => !m.disabled);

		// If no moves available, must switch or struggle
		if (availableMoves.length === 0) {
			if (switches.length > 0) {
				const switchTarget = this.chooseSwitch(active, switches);
				return {
					type: 'switch',
					target: switchTarget,
				};
			}
			return { type: 'move', slot: 1 }; // Struggle
		}

		// Check if we should switch
		if (this.config.canSwitch && switches.length > 0) {
			const switchResult = this.evaluateSwitching(active, availableMoves, switches);
			if (switchResult.shouldSwitch) {
				// Log switch decision
				if (this.battleState) {
					const currentPokemon = this.battleState.self.active[activeIndex];
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
						const target = opponents.find(p => p.slot === slot);
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
			targetPos = bestTargetPos || this.getTargetPosition(bestMove, active);
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

		// In doubles, evaluate moves against each opponent and find the best move+target combo
		let bestScore = -Infinity;
		let bestMoves: { move: MoveChoice; aiMove: AIMove; targetSlot: number }[] = [];
		const allScoresByTarget: Map<number, MoveScore[]> = new Map(); // slot -> scores

		// First pass: collect all scores for all targets
		for (const target of opponents) {
			const targetSlot = target.slot;

			// Score all moves against this target
			const scores = this.scoringEngine.scoreMoves(
				this.battleState,
				attacker,
				aiMoves,
				target
			);

			// Store scores for this target (for logging)
			allScoresByTarget.set(targetSlot, scores);
		}

		// Second pass: find best move
		// - For spread moves: use maximum score across all targets
		// - For single-target moves: compare against each target separately
		for (let i = 0; i < aiMoves.length; i++) {
			const moveTarget = moves[i].target;
			const isSpreadMove = moveTarget === 'allAdjacentFoes' || moveTarget === 'allAdjacent' || moveTarget === 'all';

			if (isSpreadMove) {
				// For spread moves, use the maximum score across all targets
				let maxScore = -Infinity;
				let maxTargetSlot = opponents[0].slot;
				for (const [slot, scores] of allScoresByTarget) {
					if (scores[i].score > maxScore) {
						maxScore = scores[i].score;
						maxTargetSlot = slot;
					}
				}

				if (maxScore > bestScore) {
					bestScore = maxScore;
					bestMoves = [{ move: moves[i], aiMove: aiMoves[i], targetSlot: maxTargetSlot }];
				} else if (maxScore === bestScore) {
					bestMoves.push({ move: moves[i], aiMove: aiMoves[i], targetSlot: maxTargetSlot });
				}
			} else {
				// For single-target moves, check each target separately
				for (const [slot, scores] of allScoresByTarget) {
					const score = scores[i].score;
					if (score > bestScore) {
						bestScore = score;
						bestMoves = [{ move: moves[i], aiMove: aiMoves[i], targetSlot: slot }];
					} else if (score === bestScore) {
						bestMoves.push({ move: moves[i], aiMove: aiMoves[i], targetSlot: slot });
					}
				}
			}
		}

		// Store scores for logging - combine scores from all targets
		// For now, store the scores for the best target (or first if single target)
		const chosenTargetSlot = bestMoves.length > 0 ? bestMoves[0].targetSlot : opponents[0].slot;
		this.lastMoveScores = allScoresByTarget.get(chosenTargetSlot) || [];

		// Also store all scores by target for detailed logging
		this.lastMoveScoresByTarget = allScoresByTarget;

		// If all moves scored 0, fall back to random damaging move
		if (bestScore <= 0) {
			const damagingMoves = moves.filter(m => m.category !== 'Status');
			if (damagingMoves.length > 0) {
				const bestMove = this.prng.sample(damagingMoves);
				return {
					bestMove,
					chosenMove: this.convertToAIMoves([bestMove], active)[0],
					bestTargetPos: '1',
				};
			}
		}

		// Return random among best moves (for unpredictability)
		const chosen = this.prng.sample(bestMoves);

		// Determine target position (1 or 2 for opponents, in PS doubles format)
		// Use the actual slot from the target Pokemon
		let bestTargetPos: string | undefined;
		if (this.cfruConfig.isDoubles) {
			const moveTarget = chosen.move.target;
			const isSpreadMove = moveTarget === 'allAdjacentFoes' || moveTarget === 'allAdjacent' || moveTarget === 'all';

			if (!isSpreadMove && (moveTarget === 'normal' || moveTarget === 'any')) {
				// Single-target move: use the target's actual slot
				bestTargetPos = String(chosen.targetSlot);
			}
		}

		return {
			bestMove: chosen.move,
			chosenMove: chosen.aiMove,
			bestTargetPos,
		};
	}

	/**
	 * Convert MoveChoice to AIMove
	 */
	private convertToAIMoves(moves: MoveChoice[], active: AnyObject): AIMove[] {
		// 直接委托给 state-builder 的统一实现；MoveChoice 的字段是 buildAIMove 入参的超集
		return moves.map(m => buildAIMove(m, m.slot));
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

	/** Switch evaluation result */
	private evaluateSwitching(
		active: AnyObject,
		moves: MoveChoice[],
		switches: SwitchChoice[]
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

		const attacker = this.battleState.self.active[0];
		const target = this.battleState.opponent.active[0];

		if (!attacker || !target) return noSwitch;

		// Don't switch if trapped
		if (active.trapped) {
			return { ...noSwitch, reason: 'Trapped, cannot switch' };
		}

		// Score all moves
		const aiMoves = this.convertToAIMoves(moves, active);
		const scores = this.scoringEngine.scoreMoves(
			this.battleState,
			attacker,
			aiMoves,
			target
		);

		// Separate attack and status move scores
		let maxAttackScore = -Infinity;
		let maxStatusScore = -Infinity;
		for (let i = 0; i < scores.length; i++) {
			const score = scores[i].score;
			const category = aiMoves[i].category;
			if (category === 'Status') {
				if (score > maxStatusScore) maxStatusScore = score;
			} else {
				if (score > maxAttackScore) maxAttackScore = score;
			}
		}

		// If no attack moves, use -Infinity (will trigger switch consideration)
		// If no status moves, use -Infinity
		const maxScore = Math.max(maxAttackScore, maxStatusScore);

		// Dynamic threshold: consider switching if both attack and status moves score low
		// This means we're in a bad matchup where we can't do much
		const shouldConsiderSwitch =
			(maxAttackScore <= NormalAI.SWITCH_THRESHOLD_ATTACK || maxAttackScore === -Infinity) &&
			(maxStatusScore <= NormalAI.SWITCH_THRESHOLD_STATUS || maxStatusScore === -Infinity);

		if (shouldConsiderSwitch) {
			// Score all switch options with improved logic
			const switchScores: SwitchScoreLog[] = [];
			let bestSwitchSlot = 0;
			let bestSwitchScore = -Infinity;
			let bestSwitchPokemon = '';

			for (const switchOption of switches) {
				const { score, reasons } = this.scoreSwitchOption(switchOption.pokemon, target);

				// Get Pokemon name
				const pokemonName = switchOption.pokemon.details?.split(',')[0]?.trim() || `Slot ${switchOption.slot}`;

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

			// Switch if we found a switch-in that scores better than staying
			// Compare switch score against (maxScore - 100) to normalize the comparison
			// A switch score > 0 means the switch-in has positive attributes
			// A maxScore < 90 means our current moves are weak
			if (bestSwitchScore > 5) {
				return {
					shouldSwitch: true,
					switchTarget: bestSwitchSlot,
					switchScores,
					reason: `Weak position (atk:${Math.floor(maxAttackScore)}, status:${Math.floor(maxStatusScore)}), switching to ${bestSwitchPokemon} (score:${Math.floor(bestSwitchScore)})`,
				};
			}

			// Return scores even if we don't switch
			return {
				shouldSwitch: false,
				switchTarget: 0,
				switchScores,
				reason: `Weak position but no better switch-in (best: ${Math.floor(bestSwitchScore)})`,
			};
		}

		return noSwitch;
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

		// Get Pokemon types and species data
		let types: string[] = [];
		let speciesData: AnyObject = {};
		if (pokemon.types) {
			types = pokemon.types;
		} else if (pokemon.details) {
			const speciesName = pokemon.details.split(',')[0].trim();
			speciesData = Dex.species.get(speciesName);
			types = speciesData.types || [];
		}

		// Get Pokemon's known moves
		const pokemonMoves = pokemon.moves || [];

		// 1. Check resistance to opponent's known damaging moves
		let resistsCount = 0;
		let immuneCount = 0;
		let weakCount = 0;
		for (const moveId of target.moves) {
			const move = Dex.moves.get(moveId);
			if (move.category === 'Status') continue;

			let effectiveness = 1;
			for (const type of types) {
				const eff = Dex.getEffectiveness(move.type, type);
				if (eff === 1) effectiveness *= 2;
				else if (eff === -1) effectiveness *= 0.5;
				else if (eff === 0 || Dex.data.TypeChart[type]?.damageTaken?.[move.type] === 3) {
					effectiveness = 0;
					break;
				}
			}

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
			const move = Dex.moves.get(moveId);
			if (move.category === 'Status' || move.basePower < 50) continue;

			// Check if STAB
			const isSTAB = types.includes(move.type);

			// Check effectiveness against target
			let effectiveness = 1;
			for (const targetType of target.types) {
				const eff = Dex.getEffectiveness(move.type, targetType);
				if (eff === 1) effectiveness *= 2;
				else if (eff === -1) effectiveness *= 0.5;
				else if (eff === 0) {
					effectiveness = 0;
					break;
				}
			}

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
			let effectiveness = 1;
			for (const myType of types) {
				const eff = Dex.getEffectiveness(opponentType, myType);
				if (eff === 1) effectiveness *= 2;
				else if (eff === -1) effectiveness *= 0.5;
			}

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
	 * Check if a Pokemon has a better matchup against the target
	 */
	private hasBetterMatchup(pokemon: AnyObject, target: AIPokemon): boolean {
		// Get Pokemon types
		let types: string[] = [];
		if (pokemon.types) {
			types = pokemon.types;
		} else if (pokemon.details) {
			const speciesName = pokemon.details.split(',')[0].trim();
			const species = Dex.species.get(speciesName);
			types = species.types || [];
		}

		// Check if we resist opponent's known moves
		for (const moveId of target.moves) {
			const move = Dex.moves.get(moveId);
			if (move.category === 'Status') continue;

			let effectiveness = 1;
			for (const type of types) {
				const eff = Dex.getEffectiveness(move.type, type);
				if (eff === 1) effectiveness *= 2;
				else if (eff === -1) effectiveness *= 0.5;
				else if (eff === 0 || Dex.data.TypeChart[type]?.damageTaken?.[move.type] === 3) {
					effectiveness = 0;
					break;
				}
			}

			// If we resist this move, that's good
			if (effectiveness < 1) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Choose Pokemon to switch to
	 * Uses the same scoring logic as evaluateSwitching for consistency
	 */
	protected override chooseSwitch(active: AnyObject | undefined, switches: SwitchChoice[]): number {
		if (!this.battleState || this.battleState.opponent.active.length === 0) {
			return this.prng.sample(switches).slot;
		}

		const target = this.battleState.opponent.active[0];

		// Score each switch option using the improved scoring method
		const scored: { switch: SwitchChoice; score: number }[] = [];

		for (const sw of switches) {
			const { score } = this.scoreSwitchOption(sw.pokemon, target);
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
	private getTargetPosition(move: MoveChoice, active: AnyObject): string {
		// For moves that need a target, default to first opponent (position 1)
		if (move.target === 'normal' || move.target === 'any') {
			return '1'; // First opponent (positive = foe)
		}
		// For ally-targeting moves
		if (move.target === 'adjacentAlly' || move.target === 'adjacentAllyOrSelf') {
			return '-2'; // Partner (negative = ally, -2 is typically the partner slot)
		}
		return '';
	}

	/**
	 * NormalAI doesn't strategically Dynamax yet
	 */
	protected override shouldDynamax(active: AnyObject): boolean {
		// 25% chance for now - strategic Dynamax comes with HardAI
		return this.prng.randomChance(1, 4);
	}
}
