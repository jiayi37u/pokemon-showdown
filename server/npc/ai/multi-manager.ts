/**
 * Coordinates the p2 and p4 requests using Normal or Hard controllers and shared public observations.
 * Battle state comes only from player requests and public protocol messages.
 */
import { ObjectReadWriteStream } from '../../../lib/streams';
import type { ChoiceRequest } from '../../../sim/side';
import type { PRNGSeed } from '../../../sim/prng';
import type { AIPokemon, BattleState, SideConditions } from './cfru/types';
import type { LogLevel } from './cfru/logger';
import { type BattleTracker, createBattleTracker } from './cfru/util/battle-tracker';
import { buildPokemonFromRequest, trackedPokemonToAIPokemon } from './cfru/state-builder';
import { NormalAI } from './normal';
import { HardAI } from './hard';

export interface NPCMultiManagerOptions {
	battleId?: string;
	difficulty?: string;
	partnerDifficulty?: string;
	seed?: PRNGSeed;
	logging?: {
		console?: LogLevel,
		file?: LogLevel,
		logDir?: string,
	};
}

type NPCSide = 'p2' | 'p4';
interface CachedRequest {
	request: ChoiceRequest;
	player: AnyObject;
	rqid: number;
	turn: number;
}

export class NPCMultiManager {
	private roomBattle: AnyObject;
	private tracker: BattleTracker;
	private controllers: Record<NPCSide, NormalAI | HardAI>;
	private currentTurn = 0;
	private pendingRequests: Partial<Record<NPCSide, CachedRequest>> = {};
	private latestRequests: Partial<Record<NPCSide, CachedRequest>> = {};
	private choices = new Map<NPCSide, string>();
	private pollHandle: ReturnType<typeof setTimeout> | null = null;
	private running = false;

	constructor(roomBattle: AnyObject, options: NPCMultiManagerOptions = {}) {
		this.roomBattle = roomBattle;
		this.tracker = createBattleTracker('p2', true);
		this.tracker.setFormat(roomBattle.format || '');
		if (roomBattle.stream) this.tracker.attachToStream(roomBattle.stream);
		const controller = (side: NPCSide) => {
			const difficulty = side === 'p4' ? options.partnerDifficulty || options.difficulty : options.difficulty;
			const Controller = difficulty === 'hard' ? HardAI : NormalAI;
			return new Controller(new ObjectReadWriteStream<string>({
				write: choice => { this.choices.set(side, choice); },
			}), {
				seed: options.seed,
				battleId: options.battleId,
				side,
				logging: options.logging,
				cfruConfig: { isDoubles: true, formatId: roomBattle.format || '' },
			});
		};
		this.controllers = { p2: controller('p2'), p4: controller('p4') };
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		const poll = () => {
			if (!this.running || this.roomBattle.ended) {
				this.stop();
				return;
			}
			this.checkSideRequest('p2', this.roomBattle.p2);
			this.checkSideRequest('p4', this.roomBattle.p4);
			this.tryMakeDecision();
			this.pollHandle = setTimeout(poll, 100);
		};
		this.pollHandle = setTimeout(poll, 200);
	}

	stop(): void {
		this.running = false;
		if (this.pollHandle) clearTimeout(this.pollHandle);
		this.pollHandle = null;
	}

	private checkSideRequest(side: NPCSide, player: AnyObject | null): void {
		if (!player) return;
		const envelope = player.request;
		if (!envelope?.request) return;
		try {
			let cached = this.latestRequests[side];
			if (!cached || cached.rqid !== envelope.rqid) {
				cached = { request: JSON.parse(envelope.request), player, rqid: envelope.rqid, turn: this.roomBattle.turn ?? 0 };
				this.latestRequests[side] = cached;
				delete this.pendingRequests[side];
			}
			// Waiting players still supply current public team data for partner evaluation.
			if (cached.request.wait || envelope.isWait) return;
			this.pendingRequests[side] = cached;
		} catch (err) {
			console.error(`[NPCMultiManager] Error parsing ${side} request:`, err);
		}
	}

	private tryMakeDecision(): void {
		const sides = (['p2', 'p4'] as const).filter(side => this.pendingRequests[side]);
		if (!sides.length) return;
		for (const side of sides) {
			const request = this.pendingRequests[side]!.request;
			const partner = side === 'p2' ? 'p4' : 'p2';
			const partnerRequest = this.latestRequests[partner];
			const partnerWaiting = partnerRequest?.request.wait && partnerRequest.turn === this.pendingRequests[side]!.turn;
			// Team preview and replacements can proceed independently. Moves need the partner's
			// request or an explicit wait request, not merely an already-submitted old choice.
			if ('active' in request && !this.pendingRequests[partner] && !partnerWaiting) return;
		}
		this.makeCoordinatedDecision();
	}

	private makeCoordinatedDecision(): void {
		this.currentTurn = this.roomBattle.turn ?? this.currentTurn + 1;
		const state = this.buildVirtualDoublesState(this.latestRequests.p2, this.latestRequests.p4);
		this.choices.clear();
		const requests = this.pendingRequests;
		this.pendingRequests = {};
		for (const side of ['p2', 'p4'] as const) {
			const cached = requests[side];
			if (!cached) continue;
			// Slot numbers in a player's request belong only to that player's team.
			const reserve = this.extractReserve(cached.request);
			const ownState = {
				...state,
				self: { ...state.self, reserve, team: [...state.self.active, ...reserve] },
			};
			this.controllers[side].receiveRequestWithState(cached.request, ownState, side === 'p2' ? 1 : 2);
		}
		// Compute both decisions before writing either choice to the simulator.
		for (const [side, choice] of this.choices) {
			const cached = requests[side]!;
			const envelope = cached.player.request;
			if (envelope.rqid !== cached.rqid) continue;
			envelope.isWait = true;
			envelope.choice = choice;
			void this.roomBattle.stream.write(`>${side} ${choice}`);
		}
	}

	/**
	 * Build virtual doubles state from multi battle
	 * Combines p2 and p4 as "our side" and p1 and p3 as "opponents"
	 * Uses BattleTracker to get opponent info (since sim Battle is in separate process)
	 */
	private buildVirtualDoublesState(
		p2Request: CachedRequest | undefined,
		p4Request: CachedRequest | undefined
	): BattleState {
		const selfActive: AIPokemon[] = [];
		const selfReserve: AIPokemon[] = [];
		const opponentActive: AIPokemon[] = [];

		// Build self active from p2 and p4 requests
		if (p2Request) {
			const p2Active = this.extractActivePokemon(p2Request.request, 1);
			if (p2Active) selfActive.push(p2Active);
			selfReserve.push(...this.extractReserve(p2Request.request));
		}

		if (p4Request) {
			const p4Active = this.extractActivePokemon(p4Request.request, 2);
			if (p4Active) selfActive.push(p4Active);
			selfReserve.push(...this.extractReserve(p4Request.request));
		}

		// Build opponent active from tracker (tracks p1 AND p3 for multi battles)
		const trackedOpponents = this.tracker.getActiveOpponents();

		for (const { position, pokemon } of trackedOpponents) {
			// Multi field positions: p1a -> 1, p3b -> 2
			const side = position.slice(0, 2); // 'p1' or 'p3'
			const slot = side === 'p1' ? 1 : 2;
			// Pass formatId for consistent level resolution
			const formatId = this.roomBattle?.format || '';
			opponentActive.push(trackedPokemonToAIPokemon(
				pokemon, slot, true, formatId, this.tracker.getSleepTurns(position, pokemon.ability)
			));
		}

		// Get field and side conditions from tracker
		const fieldConditions = this.tracker.getFieldConditions();
		const opponentSideConditions = this.tracker.getOpponentSideConditions();
		const ourSideConditions = this.tracker.getOurSideConditions();

		return {
			turn: this.currentTurn,
			isDoubles: true,
			self: {
				active: selfActive,
				reserve: selfReserve,
				team: [...selfActive, ...selfReserve],
				conditions: this.convertSideConditions(ourSideConditions),
			},
			opponent: {
				remaining: this.tracker.getRemainingOpponents(),
				active: opponentActive,
				reserve: [], // Don't track opponent reserves in tracker yet
				team: opponentActive,
				conditions: this.convertSideConditions(opponentSideConditions),
			},
			field: {
				weather: fieldConditions.weather || '',
				weatherTurns: 0,
				terrain: fieldConditions.terrain || '',
				terrainTurns: 0,
				trickroom: fieldConditions.trickRoom,
				trickroomTurns: 0,
				gravity: false,
				magicroom: false,
				wonderroom: false,
			},
		};
	}

	/**
	 * Convert tracker side conditions to BattleState format
	 */
	private convertSideConditions(conditions: AnyObject): SideConditions {
		return {
			stealthrock: conditions.stealthrock || false,
			spikes: conditions.spikes || 0,
			toxicspikes: conditions.toxicspikes || 0,
			stickyweb: conditions.stickyweb || false,
			lightscreen: conditions.lightscreen || 0,
			reflect: conditions.reflect || 0,
			auroraveil: conditions.auroraveil || 0,
			tailwind: conditions.tailwind || 0,
			wish: 0,
			futuremove: 0,
		};
	}

	/**
	 * Extract active Pokemon from request
	 * @param request - The request object
	 * @param slot - The slot number (1 for p2, 2 for p4)
	 */
	private extractActivePokemon(request: AnyObject, slot: number): AIPokemon | null {
		const pokemon = request.side?.pokemon;
		if (!pokemon || pokemon.length === 0) return null;

		const activeMon = pokemon[0]; // Active Pokemon is first in the list
		if (!activeMon || activeMon.active === false || activeMon.condition.endsWith(' fnt')) return null;

		// Determine side based on slot (1 = p2, 2 = p4)
		const side = slot === 1 ? 'p2' : 'p4';
		return this.buildAIPokemon(activeMon, slot, true, side);
	}

	/**
	 * Extract reserve Pokemon from request
	 */
	private extractReserve(request: AnyObject): AIPokemon[] {
		const pokemon = request.side?.pokemon;
		if (!pokemon) return [];

		const reserve: AIPokemon[] = [];
		for (let i = 1; i < pokemon.length; i++) {
			const mon = pokemon[i];
			if (!mon || mon.active || mon.condition.endsWith(' fnt')) continue;
			reserve.push(this.buildAIPokemon(mon, i + 1, false));
		}
		return reserve;
	}

	/** Share request parsing with singles/doubles, then add publicly tracked active state. */
	private buildAIPokemon(mon: AnyObject, slot: number, isActive: boolean, side?: NPCSide): AIPokemon {
		const pokemon = buildPokemonFromRequest(mon, slot, isActive);
		if (isActive && side) {
			const position = side === 'p2' ? 'p2a' : 'p4b';
			pokemon.boosts = this.tracker.getOurActiveBoosts(position);
			pokemon.abilityStatMod = this.tracker.getOurAbilityStatMod(position);
			pokemon.lastMove = this.tracker.getOurLastMove(position);
			pokemon.sleepTurns = pokemon.status === 'slp' ? this.tracker.getSleepTurns(position, pokemon.ability) : 0;
			pokemon.volatiles = this.tracker.getVolatiles(position);
			pokemon.activeMoveActions = this.tracker.hasActed(position) ? 1 : 0;
		}
		return pokemon;
	}
}
