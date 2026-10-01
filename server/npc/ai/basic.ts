/**
 * BasicAI - Basic NPC Battle AI
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * A simple AI that prioritizes maximum damage moves.
 * - Prioritizes attacking moves over status moves
 * - Chooses the move with highest estimated damage
 * - Considers type effectiveness, ability immunity, item immunity
 * - Does not voluntarily switch
 * - Switches only when all moves have no PP
 *
 * @license MIT
 */

import type { ObjectReadWriteStream } from '../../../lib/streams';
import type { PRNGSeed } from '../../../sim/prng';
import { PRNG } from '../../../sim/prng';
import { Dex, toID } from '../../../sim/dex';
import { NPCBattleAI, MoveChoice, SwitchChoice, AIConfig } from './index';
import type { ChoiceRequest } from '../../../sim/side';
import { BattleTracker, createBattleTracker } from './cfru/util/battle-tracker';
import { getExpectedHitCount, getWeightBasedPower, getWeightRatioPower } from './cfru/util/damage-calc';

/** Type effectiveness chart cache */
const TYPE_CHART = Dex.data.TypeChart;

/**
 * BasicAI - Prioritizes maximum damage
 */
export class BasicAI extends NPCBattleAI {
	readonly difficulty = 'basic';

	/** Reference to battle object */
	private battleRef: AnyObject | null = null;

	/** Last request for opponent info */
	private lastRequest: ChoiceRequest | null = null;

	/** Battle state tracker for opponent info */
	protected tracker: BattleTracker;

	constructor(
		playerStream: ObjectReadWriteStream<string>,
		options: { seed?: PRNG | PRNGSeed | null } = {},
		debug = false
	) {
		// BasicAI config: no status moves, no voluntary switching, type-based damage calc
		const config: Partial<AIConfig> = {
			useStatusMoves: false,
			canSwitch: false,
			damageCalc: 'type',
		};

		super(playerStream, config, options, debug);

		// Create battle tracker (we are p2, opponent is p1)
		this.tracker = createBattleTracker('p2');
	}

	/**
	 * Set battle reference and start tracking opponent
	 */
	setBattle(battle: AnyObject): void {
		this.battleRef = battle;

		// Attach tracker to battle stream
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
	 * Override receiveRequest to store request data
	 */
	override receiveRequest(request: ChoiceRequest): void {
		this.lastRequest = request;
		super.receiveRequest(request);
	}

	/**
	 * Make decision for current turn
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
		}
	): {
		type: 'move' | 'switch';
		slot?: number;
		target?: number;
		targetPos?: string;
		zMove?: boolean;
		transform?: 'mega' | 'ultra' | 'dynamax' | 'terastallize';
	} {
		// Filter out moves with no PP (if we have PP info)
		const availableMoves = moves.filter(m => !m.disabled);

		// Check if all moves have no PP - need to switch
		if (availableMoves.length === 0) {
			if (switches.length > 0) {
				return {
					type: 'switch',
					target: this.chooseSwitch(active, switches),
				};
			}
			// No switches available, use Struggle (slot 1)
			return { type: 'move', slot: 1 };
		}

		// Get attacking moves (non-Status)
		const attackingMoves = availableMoves.filter(m => m.category !== 'Status');

		// If we have attacking moves, choose the best one
		if (attackingMoves.length > 0) {
			const { move: bestMove, targetPos } = this.chooseBestMoveWithTarget(active, attackingMoves);
			return {
				type: 'move',
				slot: bestMove.slot,
				targetPos,
				zMove: bestMove.zMove,
			};
		}

		// Only status moves available - pick randomly and add target if needed
		const randomMove = this.prng.sample(availableMoves);
		const targetPos = this.getDefaultTargetPos(randomMove);
		return {
			type: 'move',
			slot: randomMove.slot,
			targetPos,
			zMove: randomMove.zMove,
		};
	}

	/**
	 * Choose the best attacking move based on estimated damage
	 */
	protected chooseBestMove(active: AnyObject, moves: MoveChoice[]): MoveChoice {
		return this.chooseBestMoveWithTarget(active, moves).move;
	}

	/**
	 * Choose the best attacking move and target (for doubles support)
	 * Evaluates moves against all active opponents and returns the best move+target combo
	 *
	 * For spread moves (e.g., Earthquake, Rock Slide), calculates total damage against
	 * all opponents with 0.75x spread damage reduction.
	 */
	protected chooseBestMoveWithTarget(active: AnyObject, moves: MoveChoice[]): { move: MoveChoice; targetPos?: string } {
		if (moves.length === 0) {
			throw new Error('No moves available');
		}

		if (moves.length === 1) {
			// Even with one move, we may need a target in doubles
			const move = moves[0];
			const targetPos = this.getDefaultTargetPos(move);
			return { move, targetPos };
		}

		// Get all active opponents from tracker
		const opponents = this.tracker.getActiveOpponents();

		// If no opponent info, fall back to simple evaluation with default targeting
		if (opponents.length === 0) {
			const opponent = this.getOpponentInfo();

			// Calculate estimated damage for each move
			const movesWithDamage = moves.map(move => ({
				move,
				damage: this.estimateDamage(move, active, opponent),
			}));

			// Sort by damage (highest first)
			movesWithDamage.sort((a, b) => b.damage - a.damage);

			// If top moves have similar damage, pick randomly among them
			const topDamage = movesWithDamage[0].damage;
			const topMoves = movesWithDamage.filter(m => m.damage >= topDamage * 0.9);

			const chosenMove = topMoves.length > 1 ? this.prng.sample(topMoves).move : movesWithDamage[0].move;
			// Provide default target for single-target moves in doubles
			const targetPos = this.getDefaultTargetPos(chosenMove);
			return { move: chosenMove, targetPos };
		}

		// Doubles (or singles with known opponent): evaluate each move against each opponent
		let bestDamage = -1;
		let bestMoves: { move: MoveChoice; targetSlot: number }[] = [];

		// First, evaluate spread moves separately (calculate total damage against all opponents)
		for (const move of moves) {
			const isSpreadMove = move.target === 'allAdjacentFoes' || move.target === 'allAdjacent';
			if (!isSpreadMove) continue;

			// Calculate total damage against all opponents
			let totalDamage = 0;
			for (const { pokemon: target } of opponents) {
				const opponentInfo = {
					species: target.species,
					types: target.types,
					ability: target.ability,
					item: target.item,
				};
				totalDamage += this.estimateDamage(move, active, opponentInfo);
			}

			// Apply spread move damage reduction (0.75x in doubles)
			if (opponents.length > 1) {
				totalDamage *= 0.75;
			}

			if (totalDamage > bestDamage) {
				bestDamage = totalDamage;
				bestMoves = [{ move, targetSlot: 0 }]; // Spread moves don't need specific target
			} else if (totalDamage === bestDamage) {
				bestMoves.push({ move, targetSlot: 0 });
			}
		}

		// Then, evaluate single-target moves against each opponent
		for (const { position, pokemon: target } of opponents) {
			// Extract slot from position (e.g., "p1a" -> 1, "p1b" -> 2)
			const slotChar = position.charAt(position.length - 1);
			const targetSlot = slotChar === 'a' ? 1 : 2;

			const opponentInfo = {
				species: target.species,
				types: target.types,
				ability: target.ability,
				item: target.item,
			};

			for (const move of moves) {
				// Skip spread moves (already evaluated above)
				const isSpreadMove = move.target === 'allAdjacentFoes' || move.target === 'allAdjacent';
				if (isSpreadMove) continue;

				const damage = this.estimateDamage(move, active, opponentInfo);

				if (damage > bestDamage) {
					bestDamage = damage;
					bestMoves = [{ move, targetSlot }];
				} else if (damage === bestDamage) {
					bestMoves.push({ move, targetSlot });
				}
			}
		}

		// Safety check: if no valid moves found, fall back to first move
		if (bestMoves.length === 0) {
			console.log(`[BasicAI] Warning: No valid move+target combo found, using first move`);
			return { move: moves[0] };
		}

		// Pick randomly among equally good options
		const chosen = this.prng.sample(bestMoves);
		const chosenMove = chosen.move;

		// Determine target position for single-target moves
		let targetPos: string | undefined;
		if (chosenMove.target === 'normal' || chosenMove.target === 'any') {
			targetPos = String(chosen.targetSlot);
		}

		return { move: chosenMove, targetPos };
	}

	/**
	 * Estimate damage for a move (simplified calculation)
	 * Considers base power, STAB, type effectiveness, multi-hit, and weight-based moves
	 */
	protected estimateDamage(
		move: MoveChoice,
		attacker: AnyObject,
		defender: AnyObject | null
	): number {
		// Status moves do no damage
		if (move.category === 'Status') {
			return 0;
		}

		// Get move data from Dex
		const dexMove = Dex.moves.get(move.move);
		const moveId = toID(move.move);

		// Get base power
		let power = move.basePower || dexMove.basePower || 0;

		// Handle weight-based moves
		const weightMoves = ['lowkick', 'grassknot'];
		const weightRatioMoves = ['heavyslam', 'heatcrash'];

		if (weightMoves.includes(moveId) || weightRatioMoves.includes(moveId)) {
			if (defender && defender.species) {
				if (weightMoves.includes(moveId)) {
					// Low Kick / Grass Knot - power based on target weight
					power = getWeightBasedPower(
						defender.species,
						defender.ability || '',
						defender.item || ''
					);
				} else {
					// Heavy Slam / Heat Crash - power based on weight ratio
					const attackerSpecies = this.getSpeciesName(attacker);
					power = getWeightRatioPower(
						attackerSpecies,
						attacker.ability || '',
						attacker.item || '',
						defender.species,
						defender.ability || '',
						defender.item || ''
					);
				}
			} else {
				// No defender info - use average power estimate
				power = 80;
			}
		}

		if (power === 0) return 0;

		// Handle multi-hit moves
		if (dexMove.multihit) {
			const attackerSpecies = this.getSpeciesName(attacker);
			const expectedHits = getExpectedHitCount(
				{
					id: moveId,
					multihit: dexMove.multihit,
				} as any,
				attacker.ability || '',
				attacker.item || '',
				attackerSpecies
			);
			power *= expectedHits;
		}

		// Get move type
		let moveType = move.type;
		if (!moveType || moveType === '???') {
			moveType = dexMove.type;
		}

		// STAB bonus (1.5x)
		const attackerTypes = this.getPokemonTypes(attacker);
		if (attackerTypes.includes(moveType)) {
			power *= 1.5;
		}

		// Type effectiveness (including ability and item immunities)
		// Use tracker for comprehensive immunity check
		if (this.tracker.isImmune(moveType)) {
			return 0;
		}

		// Get effectiveness from tracker (considers type matchup)
		const effectiveness = this.tracker.getEffectiveness(moveType);
		power *= effectiveness;

		return power;
	}

	/**
	 * Get species name from Pokemon object
	 */
	protected getSpeciesName(pokemon: AnyObject): string {
		if (pokemon.speciesForme) return pokemon.speciesForme;
		if (pokemon.species) return pokemon.species;
		if (pokemon.details) {
			return pokemon.details.split(',')[0].trim();
		}
		return '';
	}

	/**
	 * Get Pokemon types from battle state
	 */
	protected getPokemonTypes(pokemon: AnyObject): string[] {
		if (pokemon.types) {
			return pokemon.types;
		}

		if (pokemon.details) {
			// Parse from details string: "Species, L50, M" or "Species, L50, F"
			const speciesName = pokemon.details.split(',')[0].trim();
			const species = Dex.species.get(speciesName);
			if (species) {
				return species.types;
			}
		}

		if (pokemon.speciesForme || pokemon.species) {
			const species = Dex.species.get(pokemon.speciesForme || pokemon.species);
			if (species) {
				return species.types;
			}
		}

		return [];
	}

	/**
	 * Get type effectiveness multiplier
	 */
	protected getTypeEffectiveness(moveType: string, defenderTypes: string[]): number {
		let multiplier = 1;

		for (const defType of defenderTypes) {
			const effectiveness = Dex.getEffectiveness(moveType, defType);

			if (effectiveness === 1) {
				// Super effective
				multiplier *= 2;
			} else if (effectiveness === -1) {
				// Not very effective
				multiplier *= 0.5;
			} else if (effectiveness === -2 || effectiveness === 0) {
				// Immune (getEffectiveness returns 0 for immune in some cases)
				const typeData = TYPE_CHART[defType];
				if (typeData?.damageTaken?.[moveType] === 3) {
					return 0;
				}
			}
		}

		return multiplier;
	}

	/**
	 * Get opponent Pokemon info from tracker
	 */
	protected getOpponentInfo(): AnyObject | null {
		const opponent = this.tracker.getActiveOpponent();
		if (opponent) {
			return {
				species: opponent.species,
				types: opponent.types,
				ability: opponent.ability,
				item: opponent.item,
			};
		}
		return null;
	}

	/**
	 * Choose Pokemon to switch to (random for BasicAI)
	 */
	protected override chooseSwitch(active: AnyObject | undefined, switches: SwitchChoice[]): number {
		// BasicAI: random switch
		return this.prng.sample(switches).slot;
	}

	/**
	 * BasicAI doesn't Dynamax strategically
	 */
	protected override shouldDynamax(active: AnyObject): boolean {
		return false;
	}

	/**
	 * Get default target position for doubles
	 * Returns target position string for moves that need targeting
	 */
	private getDefaultTargetPos(move: MoveChoice): string | undefined {
		// Only single-target moves need explicit targeting
		if (move.target === 'normal' || move.target === 'any') {
			return '1'; // Default to first opponent
		}
		if (move.target === 'adjacentAlly' || move.target === 'adjacentAllyOrSelf') {
			return '-2'; // Partner slot
		}
		// Spread moves, self-targeting, etc. don't need a target
		return undefined;
	}
}
