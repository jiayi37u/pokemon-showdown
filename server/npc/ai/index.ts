/**
 * NPC Battle AI - Base Class
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Base class for NPC battle AI implementations.
 * Extends BattlePlayer to integrate with the battle stream system.
 *
 * @license MIT
 */

import type { ObjectReadWriteStream } from '../../../lib/streams';
import { BattlePlayer } from '../../../sim/battle-stream';
import { PRNG, PRNGSeed } from '../../../sim/prng';
import { Dex } from '../../../sim/dex';
import type { ChoiceRequest, SwitchRequest, MoveRequest, TeamPreviewRequest } from '../../../sim/side';

/** AI configuration options */
export interface AIConfig {
	/** Whether to use status moves */
	useStatusMoves: boolean;

	/** Whether to allow voluntary switching */
	canSwitch: boolean;

	/** Damage calculation precision: 'none' | 'type' | 'full' */
	damageCalc: 'none' | 'type' | 'full';

	// Reserved for future extension
	considerSpeed?: boolean;
	predictSwitch?: boolean;
	evaluateSetup?: boolean;
	considerItems?: boolean;
	considerAbilities?: boolean;
}

/** Move info for AI decision */
export interface MoveChoice {
	slot: number;
	move: string;
	target: string;
	zMove: boolean;
	disabled: boolean;
	basePower: number;
	type: string;
	category: string;
}

/** Switch info for AI decision */
export interface SwitchChoice {
	slot: number;
	pokemon: AnyObject;
}

/**
 * NPCBattleAI - Abstract base class for NPC AI
 */
export abstract class NPCBattleAI extends BattlePlayer {
	/** AI difficulty identifier */
	abstract readonly difficulty: string;

	/** AI configuration */
	protected config: AIConfig;

	/** Random number generator */
	protected prng: PRNG;

	constructor(
		playerStream: ObjectReadWriteStream<string>,
		config: Partial<AIConfig> = {},
		options: { seed?: PRNG | PRNGSeed | null } = {},
		debug = false
	) {
		super(playerStream, debug);

		// Default config
		this.config = {
			useStatusMoves: true,
			canSwitch: true,
			damageCalc: 'none',
			...config,
		};

		this.prng = options.seed ? PRNG.get(options.seed) : new PRNG();
	}

	/**
	 * Handle errors from battle stream
	 */
	override receiveError(error: Error): void {
		// Allow retry on unavailable choice
		if (error.message.startsWith('[Unavailable choice]')) return;
		throw error;
	}

	/**
	 * Handle battle requests
	 */
	override receiveRequest(request: ChoiceRequest): void {
		if (request.wait) {
			// Wait request - do nothing
			return;
		}

		if (request.forceSwitch) {
			// Forced switch request
			this.handleForceSwitch(request);
		} else if (request.teamPreview) {
			// Team preview request
			this.handleTeamPreview(request);
		} else if (request.active) {
			// Move request
			this.handleMoveRequest(request);
		}
	}

	/**
	 * Handle forced switch (e.g., after KO)
	 */
	protected handleForceSwitch(request: SwitchRequest): void {
		const pokemon = request.side.pokemon;
		const chosen: number[] = [];

		const choices = request.forceSwitch.map((mustSwitch: boolean, i: number) => {
			if (!mustSwitch) return 'pass';

			const canSwitch = this.getAvailableSwitches(pokemon, i, chosen, request.forceSwitch.length, !!pokemon[i]?.reviving);

			if (canSwitch.length === 0) return 'pass';

			const target = this.chooseSwitch(undefined, canSwitch);
			chosen.push(target);
			return `switch ${target}`;
		});

		this.choose(choices.join(', '));
	}

	/**
	 * Handle team preview
	 */
	protected handleTeamPreview(request: TeamPreviewRequest): void {
		const team = request.side.pokemon;
		this.choose(this.chooseTeamPreview(team));
	}

	/**
	 * Handle move request - main battle turn
	 */
	protected handleMoveRequest(request: MoveRequest): void {
		const pokemon = request.side.pokemon;
		const chosen: number[] = [];

		let [canMegaEvo, canUltraBurst, canZMove, canDynamax, canTerastallize] =
			[true, true, true, true, true];

		const choices = request.active.map((active: AnyObject, i: number) => {
			// Skip fainted or commanding Pokemon
			if (pokemon[i].condition.endsWith(' fnt') || pokemon[i].commanding) {
				return 'pass';
			}

			// Update transformation flags
			canMegaEvo = canMegaEvo && active.canMegaEvo;
			canUltraBurst = canUltraBurst && active.canUltraBurst;
			canZMove = canZMove && !!active.canZMove;
			canDynamax = canDynamax && !!active.canDynamax;
			canTerastallize = canTerastallize && !!active.canTerastallize;

			// Get available moves
			const useMaxMoves = (!active.canDynamax && active.maxMoves) || (canDynamax && this.shouldDynamax(active));
			const possibleMoves = useMaxMoves ? active.maxMoves.maxMoves : active.moves;

			const moves = this.getAvailableMoves(possibleMoves, active, request.active.length > 1, i, pokemon);

			// Add Z-moves if available
			if (canZMove && active.canZMove) {
				for (let j = 0; j < active.canZMove.length; j++) {
					if (active.canZMove[j]) {
						moves.push({
							slot: j + 1,
							move: active.canZMove[j].move,
							target: active.canZMove[j].target,
							zMove: true,
							disabled: false,
							basePower: active.canZMove[j].basePower || 0,
							type: active.canZMove[j].type || '???',
							category: active.canZMove[j].category || 'Status',
						});
					}
				}
			}

			// Get available switches
			const canSwitch = active.trapped ? [] : this.getAvailableSwitches(pokemon, i, chosen, 1, false);

			// Make decision
			const decision = this.makeDecision(active, moves, canSwitch, {
				canMegaEvo,
				canUltraBurst,
				canZMove,
				canDynamax,
				canTerastallize,
			}, i);

			// Handle switch decision
			if (decision.type === 'switch') {
				chosen.push(decision.target!);
				return `switch ${decision.target}`;
			}

			// Handle move decision
			let moveStr = `move ${decision.slot}`;

			// Add target for doubles
			if (decision.targetPos) {
				moveStr += ` ${decision.targetPos}`;
			}

			// Add Z-move flag
			if (decision.zMove) {
				canZMove = false;
				moveStr += ' zmove';
			}

			// Add transformation
			if (decision.transform) {
				switch (decision.transform) {
				case 'mega':
					canMegaEvo = false;
					moveStr += ' mega';
					break;
				case 'ultra':
					canUltraBurst = false;
					moveStr += ' ultra';
					break;
				case 'dynamax':
					canDynamax = false;
					moveStr += ' dynamax';
					break;
				case 'terastallize':
					canTerastallize = false;
					moveStr += ' terastallize';
					break;
				}
			}

			return moveStr;
		});

		this.choose(choices.join(', '));
	}

	/**
	 * Get available moves for current Pokemon
	 */
	protected getAvailableMoves(
		possibleMoves: AnyObject[],
		active: AnyObject,
		isDoubles: boolean,
		activeIndex: number,
		allPokemon: AnyObject[]
	): MoveChoice[] {
		const moves: MoveChoice[] = [];

		for (let j = 0; j < possibleMoves.length; j++) {
			const move = possibleMoves[j];
			if (move.disabled) continue;

			// Get move data from Dex if not provided in request
			const dexMove = Dex.moves.get(move.move);

			moves.push({
				slot: j + 1,
				move: move.move,
				target: move.target || dexMove.target,
				zMove: false,
				disabled: move.disabled,
				basePower: move.basePower || dexMove.basePower || 0,
				type: move.type || dexMove.type || '???',
				category: move.category || dexMove.category || 'Status',
			});
		}

		return moves;
	}

	/**
	 * Get available Pokemon for switching
	 */
	protected getAvailableSwitches(
		pokemon: AnyObject[],
		activeIndex: number,
		alreadyChosen: number[],
		activeCount: number,
		reviving: boolean
	): SwitchChoice[] {
		const switches: SwitchChoice[] = [];

		for (let j = 0; j < pokemon.length; j++) {
			const slot = j + 1;
			const mon = pokemon[j];

			// Skip if doesn't exist
			if (!mon) continue;

			// Skip if already active (unless reviving)
			if (slot <= activeCount && !reviving) continue;

			// Skip if already chosen for switch
			if (alreadyChosen.includes(slot)) continue;

			// Handle fainted status based on reviving
			const isFainted = mon.condition.endsWith(' fnt');
			if (isFainted !== reviving) continue;

			switches.push({ slot, pokemon: mon });
		}

		return switches;
	}

	/**
	 * Decision result type
	 * @param activeIndex - Index of the active Pokemon making the decision (0 or 1 in doubles)
	 */
	protected makeDecision(
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
		// To be implemented by subclasses
		// Default: random move
		if (moves.length > 0) {
			const move = this.chooseMove(active, moves);
			return {
				type: 'move',
				slot: move.slot,
				zMove: move.zMove,
			};
		}

		// No moves available, must switch
		if (switches.length > 0) {
			return {
				type: 'switch',
				target: this.chooseSwitch(active, switches),
			};
		}

		// Fallback
		return { type: 'move', slot: 1 };
	}

	/**
	 * Choose team order for team preview
	 * Override in subclass for custom logic
	 */
	protected chooseTeamPreview(team: AnyObject[]): string {
		return 'default';
	}

	/**
	 * Choose a move from available moves
	 * Override in subclass for custom logic
	 */
	protected chooseMove(active: AnyObject, moves: MoveChoice[]): MoveChoice {
		return this.prng.sample(moves);
	}

	/**
	 * Choose a Pokemon to switch to
	 * Override in subclass for custom logic
	 */
	protected chooseSwitch(active: AnyObject | undefined, switches: SwitchChoice[]): number {
		return this.prng.sample(switches).slot;
	}

	/**
	 * Decide whether to Dynamax
	 * Override in subclass for custom logic
	 */
	protected shouldDynamax(active: AnyObject): boolean {
		return this.prng.randomChance(1, 3); // 33% chance by default
	}
}
