/**
 * Coordinates the p2 and p4 requests using Normal or Hard controllers and shared public observations.
 * Battle state comes only from player requests and public protocol messages.
 */
import { ObjectReadWriteStream } from '../../../lib/streams';
import type { ChoiceRequest } from '../../../sim/side';
import type { PRNGSeed } from '../../../sim/prng';
import { DEFAULT_AI_CONFIG, type AIPokemon, type BattleState } from './cfru/types';
import type { LogLevel } from './cfru/logger';
import { type BattleTracker, createBattleTracker } from './cfru/util/battle-tracker';
import { buildPokemonFromRequest, buildBattleStateFromRequests } from './cfru/state-builder';
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
				self: { ...state.self, reserve },
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
		const requests = [];
		if (p2Request) requests.push({ side: 'p2', request: p2Request.request });
		if (p4Request) requests.push({ side: 'p4', request: p4Request.request });
		return buildBattleStateFromRequests(requests, this.tracker,
			{ ...DEFAULT_AI_CONFIG, isDoubles: true, formatId: this.roomBattle.format || '' }, this.currentTurn);
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
			reserve.push(buildPokemonFromRequest(mon, i + 1, false, this.roomBattle.format || ''));
		}
		return reserve;
	}
}
