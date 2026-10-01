/**
 * NPCMultiManager - Multi Battle AI Coordinator
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Coordinates AI decisions for p2 and p4 in multi battles.
 * Treats the two NPC sides as a virtual doubles team for strategic coordination.
 *
 * Architecture:
 * - Receives requests from both p2 and p4
 * - Waits for both requests to sync before making coordinated decisions
 * - Builds a virtual doubles state from the multi battle
 * - Uses existing CFRU scoring system for move evaluation
 * - Considers partner (p2 <-> p4) when evaluating moves
 *
 * @license MIT
 */

import { Dex, toID } from '../../../sim/dex';
import { PRNG } from '../../../sim/prng';
import {
	CFRUAIConfig,
	DEFAULT_AI_CONFIG,
	BattleState,
	AIPokemon,
	AIMove,
	MoveScore,
} from './cfru/types';
import { createScoringEngine, ScoringEngine } from './cfru/scoring';
import { createCache, updateCacheTurn } from './cfru/util/cache';
import { AIDecisionLogger, LogLevel, createBattleLogger } from './cfru/logger';
import { BattleTracker, createBattleTracker } from './cfru/util/battle-tracker';
import { trackedPokemonToAIPokemon } from './cfru/state-builder';

/** NPCMultiManager configuration options */
export interface NPCMultiManagerOptions {
	/** Battle ID for logging */
	battleId?: string;

	/** AI difficulty level */
	difficulty?: string;

	/** Logging options */
	logging?: {
		/** Console log level */
		console?: LogLevel;
		/** File log level */
		file?: LogLevel;
		/** Log directory */
		logDir?: string;
	};
}

/** Cached request from a side */
interface CachedRequest {
	request: AnyObject;
	player: AnyObject;
	timestamp: number;
}

/**
 * NPCMultiManager - Coordinates AI for p2 and p4 in multi battles
 */
export class NPCMultiManager {
	/** RoomBattle reference (server-side battle wrapper) */
	private roomBattle: AnyObject;

	/** CFRU AI configuration */
	private cfruConfig: CFRUAIConfig;

	/** Scoring engine */
	private scoringEngine: ScoringEngine;

	/** AI cache */
	private aiCache: ReturnType<typeof createCache>;

	/** PRNG for randomness */
	private prng: PRNG;

	/** Decision logger for p2 */
	private p2Logger: AIDecisionLogger;

	/** Decision logger for p4 */
	private p4Logger: AIDecisionLogger;

	/** Battle tracker for opponent info */
	private tracker: BattleTracker;

	/** Current turn number */
	private currentTurn: number = 0;

	/** Pending requests from p2 and p4 */
	private pendingRequests: {
		p2?: CachedRequest;
		p4?: CachedRequest;
	} = {};

	/** Last processed request IDs */
	private lastProcessedRqid: {
		p2: number;
		p4: number;
	} = { p2: 0, p4: 0 };

	/** Polling interval handle */
	private pollHandle: ReturnType<typeof setTimeout> | null = null;

	/** Is manager running */
	private running: boolean = false;

	constructor(roomBattle: AnyObject, options: NPCMultiManagerOptions = {}) {
		this.roomBattle = roomBattle;
		this.prng = new PRNG(PRNG.generateSeed());

		// CFRU configuration - always use doubles mode for multi battles
		this.cfruConfig = {
			...DEFAULT_AI_CONFIG,
			isDoubles: true,
		};

		// Initialize cache
		this.aiCache = createCache(0);

		// Initialize scoring engine
		this.scoringEngine = createScoringEngine(this.cfruConfig, this.aiCache);

		// Initialize loggers for p2 and p4
		const battleId = options.battleId || `multi-${Date.now()}`;
		this.p2Logger = createBattleLogger(
			battleId,
			'p2',
			{
				console: options.logging?.console ?? LogLevel.NONE,
				file: options.logging?.file ?? LogLevel.NONE,
				logDir: options.logging?.logDir,
			}
		);
		this.p4Logger = createBattleLogger(
			battleId,
			'p4',
			{
				console: options.logging?.console ?? LogLevel.NONE,
				file: options.logging?.file ?? LogLevel.NONE,
				logDir: options.logging?.logDir,
			}
		);

		// Create battle tracker for multi battle - tracks p1 AND p3 as opponents
		this.tracker = createBattleTracker('p2', true); // isMulti = true

		// Attach tracker to battle stream
		if (roomBattle.stream) {
			this.tracker.attachToStream(roomBattle.stream);
		}
	}

	/**
	 * Get the sim Battle object (contains Side objects with active Pokemon)
	 */
	private get simBattle(): AnyObject {
		return this.roomBattle.stream?.battle;
	}

	/**
	 * Start the manager - begin polling for requests
	 */
	start(): void {
		if (this.running) return;
		this.running = true;
		this.startPolling();
	}

	/**
	 * Stop the manager
	 */
	stop(): void {
		this.running = false;
		if (this.pollHandle) {
			clearTimeout(this.pollHandle);
			this.pollHandle = null;
		}
	}

	/**
	 * Start polling for requests from p2 and p4
	 */
	private startPolling(): void {
		const checkRequests = () => {
			if (!this.running || !this.roomBattle || this.roomBattle.ended) {
				this.stop();
				return;
			}

			// Check for new requests from p2 and p4 (RoomBattlePlayer objects)
			this.checkSideRequest('p2', this.roomBattle.p2);
			this.checkSideRequest('p4', this.roomBattle.p4);

			// Try to make coordinated decision if both requests are ready
			this.tryMakeDecision();

			// Continue polling
			this.pollHandle = setTimeout(checkRequests, 100);
		};

		// Start after a short delay
		this.pollHandle = setTimeout(checkRequests, 200);
	}

	/**
	 * Check for new request from a side
	 */
	private checkSideRequest(side: 'p2' | 'p4', player: AnyObject | null): void {
		if (!player) return;

		const request = player.request;
		if (!request || !request.request || request.isWait) return;

		try {
			const requestData = JSON.parse(request.request);
			const rqid = request.rqid;

			// Skip if already processed
			if (rqid === this.lastProcessedRqid[side]) return;

			// Handle team preview
			if (requestData.teamPreview) {
				this.handleTeamPreview(side, player, requestData);
				this.lastProcessedRqid[side] = rqid;
				request.isWait = true;
				return;
			}

			// Handle different request types
			if (requestData.forceSwitch) {
				// Force switch - handle immediately without waiting for other side
				this.handleForceSwitch(side, player, requestData);
				this.lastProcessedRqid[side] = rqid;
				request.isWait = true;
				return;
			}

			if (requestData.wait) {
				// This side is waiting - mark as null (no action needed)
				this.pendingRequests[side] = undefined;
				this.lastProcessedRqid[side] = rqid;
				request.isWait = true;
				return;
			}

			// Normal request - cache it
			this.pendingRequests[side] = {
				request: requestData,
				player,
				timestamp: Date.now(),
			};
			this.lastProcessedRqid[side] = rqid;

		} catch (err) {
			console.error(`[NPCMultiManager] Error parsing ${side} request:`, err);
		}
	}

	/**
	 * Try to make coordinated decision when both sides are ready
	 */
	private tryMakeDecision(): void {
		const p2Request = this.pendingRequests.p2;
		const p4Request = this.pendingRequests.p4;

		// Need at least one request to proceed
		if (!p2Request && !p4Request) return;

		const p2NeedsAction = p2Request !== undefined;
		const p4NeedsAction = p4Request !== undefined;

		// If one side doesn't need action, we can proceed with just the other
		// But if both need action, wait for both
		if (p2NeedsAction && p4NeedsAction && (!p2Request || !p4Request)) {
			return; // Wait for both
		}

		// Make coordinated decision
		this.makeCoordinatedDecision();

		// Clear pending requests
		this.pendingRequests = {};
	}

	/**
	 * Make coordinated decision for both p2 and p4
	 * Treats them as a virtual doubles team
	 */
	private makeCoordinatedDecision(): void {
		const p2Request = this.pendingRequests.p2;
		const p4Request = this.pendingRequests.p4;

		console.log(`[DEBUG] makeCoordinatedDecision called, p2Request=${!!p2Request}, p4Request=${!!p4Request}`);

		// Update turn and cache (roomBattle.turn is the current turn number)
		const newTurn = this.roomBattle.turn ?? this.currentTurn + 1;
		if (newTurn !== this.currentTurn) {
			this.currentTurn = newTurn;
			this.aiCache = updateCacheTurn(this.aiCache, newTurn);
			this.scoringEngine.updateCache(this.aiCache);
		}

		console.log(`[DEBUG] currentTurn=${this.currentTurn}`);

		// Build virtual doubles state
		const virtualState = this.buildVirtualDoublesState(p2Request, p4Request);

		console.log(`[DEBUG] virtualState built: self.active=${virtualState.self.active.length}, opponent.active=${virtualState.opponent.active.length}`);

		// Evaluate moves for each side that needs action
		if (p2Request) {
			const p2Choice = this.evaluateSideChoice(p2Request, virtualState, 0, 'p2');
			console.log(`[DEBUG] p2 choice: ${p2Choice}`);
			this.sendChoice('p2', p2Choice);
			p2Request.player.request.isWait = true;
		}

		if (p4Request) {
			// Dynamic selfIndex: if p2 is fainted (no request), p4 is at index 0
			const p4SelfIndex = p2Request ? 1 : 0;
			const p4Choice = this.evaluateSideChoice(p4Request, virtualState, p4SelfIndex, 'p4');
			console.log(`[DEBUG] p4 choice: ${p4Choice}`);
			this.sendChoice('p4', p4Choice);
			p4Request.player.request.isWait = true;
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
		console.log(`[DEBUG] tracker.getActiveOpponents() returned ${trackedOpponents.length} opponents`);

		for (const { position, pokemon } of trackedOpponents) {
			// Extract slot from position: p1a -> 1, p3a -> 2
			const side = position.slice(0, 2); // 'p1' or 'p3'
			const slot = side === 'p1' ? 1 : 2;
			console.log(`[DEBUG] Opponent from tracker: ${pokemon.species} at ${position} -> slot ${slot}`);
			// Pass formatId for consistent level resolution
			const formatId = this.roomBattle?.format || '';
			opponentActive.push(trackedPokemonToAIPokemon(pokemon, slot, true, formatId));
		}

		console.log(`[DEBUG] virtualState: self.active=${selfActive.length}, opponent.active=${opponentActive.length}`);

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
	private convertSideConditions(conditions: AnyObject): AnyObject {
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
		if (!activeMon || activeMon.condition.endsWith(' fnt')) return null;

		// Determine side based on slot (1 = p2, 2 = p4)
		const side = slot === 1 ? 'p2' : 'p4';
		return this.buildAIPokemon(activeMon, slot, true, request.active?.[0], side);
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
			if (!mon || mon.condition.endsWith(' fnt')) continue;
			reserve.push(this.buildAIPokemon(mon, i + 1, false));
		}
		return reserve;
	}

	/**
	 * Extract opponent's active Pokemon from Side object
	 * side.active is Pokemon[] array - in multi battles each side has 1 active Pokemon
	 */
	private extractOpponentActive(side: AnyObject | null, slot: number): AIPokemon | null {
		if (!side) return null;

		const active = side.active;
		if (!active || !Array.isArray(active) || active.length === 0) {
			console.log(`[DEBUG] extractOpponentActive: side.active is not valid array`);
			return null;
		}

		// In multi battles, each side has exactly 1 active Pokemon (at index 0)
		const activeMon = active[0];
		if (!activeMon || activeMon.fainted) {
			console.log(`[DEBUG] extractOpponentActive: activeMon is null or fainted`);
			return null;
		}

		console.log(`[DEBUG] extractOpponentActive: found ${activeMon.speciesForme || activeMon.species?.name || 'unknown'}`);
		return this.buildOpponentAIPokemon(activeMon, slot);
	}

	/**
	 * Build AIPokemon from our side's Pokemon data
	 * @param mon - The Pokemon data from request
	 * @param slot - The slot number
	 * @param isActive - Whether the Pokemon is active
	 * @param activeData - Optional active data with moves
	 * @param side - Optional side ('p2' or 'p4') for boost tracking in multi battles
	 */
	private buildAIPokemon(mon: AnyObject, slot: number, isActive: boolean, activeData?: AnyObject, side?: string): AIPokemon {
		const species = mon.details?.split(',')[0]?.trim() || mon.speciesForme || 'Unknown';
		const speciesData = Dex.species.get(species);

		// Parse condition
		const condition = mon.condition || '100/100';
		const [currentHp, maxHpPart] = condition.split('/');
		const maxHp = parseInt(maxHpPart?.split(' ')[0]) || 100;
		const hp = parseInt(currentHp) || 100;
		const hpPercent = Math.round((hp / maxHp) * 100);

		// Parse status
		let status = '';
		if (condition.includes(' ')) {
			status = condition.split(' ')[1];
		}

		// Get moves
		const moves: string[] = [];
		if (activeData?.moves) {
			for (const move of activeData.moves) {
				moves.push(toID(move.move || move.id));
			}
		} else if (mon.moves) {
			for (const move of mon.moves) {
				moves.push(toID(move));
			}
		}

		// Build baseStats
		// DEBUG: Uncomment to debug Pokemon stats in multi battle
		// console.log(`[DEBUG] buildAIPokemon: species=${species}, mon.stats=${JSON.stringify(mon.stats)}`);
		const baseStats = this.parseBaseStats(mon.stats, speciesData, maxHp);
		// console.log(`[DEBUG] buildAIPokemon: parsed baseStats=${JSON.stringify(baseStats)}`);

		// Get boosts from tracker for active Pokemon
		// In multi battles: p2 uses slot 'a', p4 uses slot 'b'
		let boosts;
		if (isActive && side) {
			// Multi battle slot mapping: p2->a, p4->b
			const slotChar = side === 'p2' ? 'a' : 'b';
			const boostKey = `${side}${slotChar}`;
			console.log(`[DEBUG] buildAIPokemon: species=${species}, isActive=${isActive}, side=${side}, boostKey=${boostKey}`);
			const trackerBoosts = this.tracker.getOurActiveBoosts(boostKey);
			console.log(`[DEBUG] buildAIPokemon: trackerBoosts for ${boostKey} = atk:${trackerBoosts.atk}, def:${trackerBoosts.def}`);
			boosts = {
				atk: trackerBoosts.atk,
				def: trackerBoosts.def,
				spa: trackerBoosts.spa,
				spd: trackerBoosts.spd,
				spe: trackerBoosts.spe,
				accuracy: trackerBoosts.accuracy,
				evasion: trackerBoosts.evasion,
			};
		} else {
			console.log(`[DEBUG] buildAIPokemon: species=${species}, isActive=${isActive}, side=${side} - using default boosts`);
			// Reserve Pokemon have no boosts
			boosts = {
				atk: 0,
				def: 0,
				spa: 0,
				spd: 0,
				spe: 0,
				accuracy: 0,
				evasion: 0,
			};
		}

		return {
			species,
			types: speciesData.types || ['???'],
			ability: mon.baseAbility || mon.ability || speciesData.abilities?.['0'] || '',
			item: mon.item || '',
			level: mon.level || 100,
			hp,
			maxHp,
			hpPercent,
			status,
			slot,
			isActive,
			fainted: hp === 0 || condition.endsWith(' fnt'),
			moves,
			lastMove: '',
			baseStats,
			boosts,
			volatiles: new Set<string>(),
			terastallized: mon.terastallized || null,
			teraType: mon.teraType || null,
		};
	}

	/**
	 * Build AIPokemon from opponent's Pokemon data
	 */
	private buildOpponentAIPokemon(mon: AnyObject, slot: number): AIPokemon {
		// Debug: Log the structure of mon object
		console.log(`[DEBUG] buildOpponentAIPokemon mon keys: ${Object.keys(mon).join(', ')}`);
		console.log(`[DEBUG] mon.speciesForme=${mon.speciesForme}, mon.species=${JSON.stringify(mon.species)}, mon.name=${mon.name}`);

		const species = mon.speciesForme || mon.species?.name || mon.species || mon.name || 'Unknown';
		const speciesData = Dex.species.get(species);

		console.log(`[DEBUG] Resolved species: ${species}, speciesData.exists=${speciesData.exists}`);

		// Get HP
		const hp = mon.hp ?? 100;
		const maxHp = mon.maxhp ?? 100;
		const hpPercent = Math.round((hp / maxHp) * 100);

		// Get moves from the Pokemon object directly (server-side has full access)
		// or from tracker for revealed moves
		let knownMoves: string[] = [];
		if (mon.moves) {
			// Direct access to moves (server-side)
			knownMoves = mon.moves.map((m: AnyObject) => toID(m.id || m.move || m));
		} else if (mon.baseMoveSlots) {
			// Alternative format
			knownMoves = mon.baseMoveSlots.map((m: AnyObject) => toID(m.id || m.move));
		} else if (mon.moveSlots) {
			// Another alternative format
			knownMoves = mon.moveSlots.map((m: AnyObject) => toID(m.id || m.move));
		} else {
			// Try to get from tracker
			const tracked = this.tracker.getOpponentTeam().find(p => p.species === species);
			if (tracked) {
				knownMoves = tracked.knownMoves;
			}
		}

		// Build baseStats - use species base stats if no specific stats available
		const baseStats = this.parseBaseStats(mon.stats || mon.storedStats, speciesData, maxHp);

		// Build boosts with all required fields
		const boosts = {
			atk: mon.boosts?.atk || 0,
			def: mon.boosts?.def || 0,
			spa: mon.boosts?.spa || 0,
			spd: mon.boosts?.spd || 0,
			spe: mon.boosts?.spe || 0,
			accuracy: mon.boosts?.accuracy || 0,
			evasion: mon.boosts?.evasion || 0,
		};

		return {
			species,
			types: speciesData.types || ['???'],
			ability: mon.ability?.name || mon.ability || mon.baseAbility || speciesData.abilities?.['0'] || '',
			item: mon.item?.name || mon.item || '',
			level: mon.level || 100,
			hp,
			maxHp,
			hpPercent,
			status: mon.status || '',
			slot,
			isActive: true,
			fainted: mon.fainted || hp === 0,
			moves: knownMoves,
			lastMove: mon.lastMove || '',
			baseStats,
			boosts,
			volatiles: new Set(Object.keys(mon.volatiles || {})),
			terastallized: mon.terastallized || null,
			teraType: mon.teraType || null,
		};
	}

	/**
	 * Parse baseStats from Pokemon data (includes hp)
	 *
	 * CFRU AI Fix: Use actual stats from request if available (same as state-builder.ts v1.2.8+)
	 * The `stats` parameter from request contains actual computed stats (not species base stats).
	 * trackedPokemonToAIPokemon calculates estimated stats using the same formula,
	 * so both sides should now use consistent stat values.
	 */
	private parseBaseStats(stats: AnyObject | null, speciesData: AnyObject, maxHp: number): AIPokemon['baseStats'] {
		// Use actual stats if available (from request.side.pokemon[].stats)
		if (stats) {
			return {
				hp: maxHp || 100,
				atk: stats.atk || 100,
				def: stats.def || 100,
				spa: stats.spa || 100,
				spd: stats.spd || 100,
				spe: stats.spe || 100,
			};
		}
		// Fallback to species base stats if no actual stats available
		const baseStats = speciesData.baseStats || {};
		return {
			hp: baseStats.hp || maxHp || 100,
			atk: baseStats.atk || 100,
			def: baseStats.def || 100,
			spa: baseStats.spa || 100,
			spd: baseStats.spd || 100,
			spe: baseStats.spe || 100,
		};
	}

	/**
	 * Extract side conditions
	 */
	private extractSideConditions(side: AnyObject | null): AnyObject {
		if (!side || !side.sideConditions) return {};

		const conditions: AnyObject = {};
		for (const [id, data] of Object.entries(side.sideConditions)) {
			conditions[id] = data;
		}
		return conditions;
	}

	/**
	 * Extract field conditions
	 */
	private extractFieldConditions(): AnyObject {
		const field = this.simBattle?.field;
		if (!field) return {};

		return {
			weather: field.weather || null,
			weatherTurnsLeft: field.weatherState?.duration || 0,
			terrain: field.terrain || null,
			terrainTurnsLeft: field.terrainState?.duration || 0,
			pseudoWeather: Object.keys(field.pseudoWeather || {}),
		};
	}

	/**
	 * Evaluate choice for a side
	 * @param cachedRequest - The cached request
	 * @param virtualState - The virtual doubles state
	 * @param selfIndex - Index in virtual state (0 for p2, 1 for p4)
	 * @param side - 'p2' or 'p4' for logging
	 */
	private evaluateSideChoice(
		cachedRequest: CachedRequest,
		virtualState: BattleState,
		selfIndex: number,
		side: 'p2' | 'p4'
	): string {
		const request = cachedRequest.request;
		const active = request.active?.[0];
		const logger = side === 'p2' ? this.p2Logger : this.p4Logger;

		// Debug: Log entry into evaluateSideChoice
		console.log(`[DEBUG] ${side} evaluateSideChoice called, turn=${this.currentTurn}, active=${!!active}`);

		if (!active) {
			// No active Pokemon - need to switch
			console.log(`[DEBUG] ${side} no active Pokemon, choosing switch`);
			return this.chooseSwitch(request, virtualState, side);
		}

		// Get available moves
		const moves = active.moves?.filter((m: AnyObject) => !m.disabled) || [];
		console.log(`[DEBUG] ${side} available moves: ${moves.length}`);

		if (moves.length === 0) {
			// No available moves - use struggle or switch
			const canSwitch = request.side?.pokemon?.some((p: AnyObject, i: number) =>
				i > 0 && !p.condition.endsWith(' fnt') && !p.active
			);
			if (canSwitch) {
				console.log(`[DEBUG] ${side} no moves, switching`);
				return this.chooseSwitch(request, virtualState, side);
			}
			console.log(`[DEBUG] ${side} no moves, using Struggle`);
			return 'move 1'; // Struggle
		}

		// Get attacker and targets
		const attacker = virtualState.self.active[selfIndex];
		const opponents = virtualState.opponent.active.filter(p => !p.fainted);

		console.log(`[DEBUG] ${side} selfIndex=${selfIndex}, attacker=${attacker?.species}, opponents=${opponents.map(o => o.species).join(',')}`);
		console.log(`[DEBUG] ${side} virtualState.self.active.length=${virtualState.self.active.length}`);
		// Debug: Log attacker's boosts to verify boost tracking
		if (attacker) {
			console.log(`[DEBUG] ${side} attacker boosts: atk=${attacker.boosts.atk}, def=${attacker.boosts.def}, spa=${attacker.boosts.spa}`);
		}

		if (!attacker || opponents.length === 0) {
			// Fallback to random move
			console.log(`[DEBUG] ${side} fallback: attacker=${!!attacker}, opponents=${opponents.length}`);
			const moveIdx = this.prng.random(moves.length) + 1;
			return `move ${moveIdx}`;
		}

		// Convert moves to AIMove format
		const aiMoves = this.convertToAIMoves(moves);

		// Score moves against each opponent
		let bestScore = -Infinity;
		let bestMoves: { moveIdx: number; targetSlot: number; scores: MoveScore[] }[] = [];
		const scoresByTarget = new Map<string, MoveScore[]>();

		for (const target of opponents) {
			const scores = this.scoringEngine.scoreMoves(
				virtualState,
				attacker,
				aiMoves,
				target
			);

			// Store scores for logging
			scoresByTarget.set(target.species, scores);

			for (let i = 0; i < scores.length; i++) {
				const score = scores[i].score;
				const move = moves[i];
				const moveTarget = move.target;

				// For spread moves, only evaluate once
				const isSpreadMove = moveTarget === 'allAdjacentFoes' || moveTarget === 'allAdjacent' || moveTarget === 'all';
				if (isSpreadMove && target !== opponents[0]) continue;

				if (score > bestScore) {
					bestScore = score;
					bestMoves = [{ moveIdx: i + 1, targetSlot: target.slot, scores }];
				} else if (score === bestScore) {
					bestMoves.push({ moveIdx: i + 1, targetSlot: target.slot, scores });
				}
			}
		}

		// Choose randomly among best moves
		const chosen = this.prng.sample(bestMoves);

		// Build choice string
		const moveData = moves[chosen.moveIdx - 1];
		const chosenMove = aiMoves[chosen.moveIdx - 1];
		const needsTarget = moveData.target === 'normal' || moveData.target === 'any';

		// Find target name for logging
		const chosenTarget = opponents.find(p => p.slot === chosen.targetSlot);
		const chosenTargetName = chosenTarget?.species || 'unknown';

		// Log the decision using the logger system
		const reasoning: string[] = [];
		const chosenScore = chosen.scores.find(s => s.move.slot === chosen.moveIdx);
		if (chosenScore) {
			if (chosenScore.flags.canKO) reasoning.push('Can KO');
			if (chosenScore.flags.goesFirst) reasoning.push('Goes first');
			if (chosenScore.flags.isSuperEffective) reasoning.push('Super effective');
		}

		logger.logMoveDecision(
			this.currentTurn,
			attacker,
			chosen.scores,
			chosenMove,
			virtualState,
			reasoning,
			scoresByTarget,
			chosenTargetName
		);

		if (needsTarget) {
			return `move ${chosen.moveIdx} ${chosen.targetSlot}`;
		}
		return `move ${chosen.moveIdx}`;
	}

	/**
	 * Convert moves from request to AIMove format
	 */
	private convertToAIMoves(moves: AnyObject[]): AIMove[] {
		return moves.map((move, index) => {
			const moveId = toID(move.move || move.id);
			const dexMove = Dex.moves.get(move.move || move.id);

			// Return/Frustration: PS sends "Return 102" format, Dex lookup fails
			const isReturn = moveId.startsWith('return') && moveId !== 'returntoearth';
			const isFrustration = moveId.startsWith('frustration');

			return {
				id: moveId,
				name: isReturn ? 'Return' : (isFrustration ? 'Frustration' : (dexMove.name || move.move || move.id)),
				slot: index + 1,
				type: isReturn || isFrustration ? 'Normal' : (dexMove.type || '???'),
				category: isReturn || isFrustration ? 'Physical' : ((dexMove.category || 'Status') as 'Physical' | 'Special' | 'Status'),
				basePower: isReturn ? 102 : (isFrustration ? 1 : (dexMove.basePower || 0)),
				accuracy: isReturn || isFrustration ? 100 : dexMove.accuracy,
				pp: move.pp ?? dexMove.pp ?? 10,
				maxPp: dexMove.pp || 10,
				priority: dexMove.priority || 0,
				target: move.target || dexMove.target || 'normal',
				flags: isReturn || isFrustration ? { contact: 1, protect: 1 } : (dexMove.flags || {}),
				secondaryChance: dexMove.secondary?.chance || 0,
				disabled: move.disabled || false,
				isZMove: false,
				isMaxMove: false,
			};
		});
	}

	/**
	 * Choose a Pokemon to switch to
	 */
	private chooseSwitch(request: AnyObject, virtualState?: BattleState, side?: 'p2' | 'p4'): string {
		const pokemon = request.side?.pokemon;
		if (!pokemon) return 'move 1';

		// Find first available switch target
		for (let i = 1; i < pokemon.length; i++) {
			const mon = pokemon[i];
			if (!mon.condition.endsWith(' fnt') && !mon.active) {
				return `switch ${i + 1}`;
			}
		}

		// No switch available - use move 1
		return 'move 1';
	}

	/**
	 * Handle force switch for a side
	 */
	private handleForceSwitch(side: 'p2' | 'p4', player: AnyObject, request: AnyObject): void {
		// Build a minimal virtual state for logging
		const virtualState = this.buildVirtualDoublesState(
			side === 'p2' ? { request, player, timestamp: Date.now() } : undefined,
			side === 'p4' ? { request, player, timestamp: Date.now() } : undefined
		);
		const choice = this.chooseSwitch(request, virtualState, side);
		this.sendChoice(side, choice);

		// Log force switch using logger
		const pokemon = request.side?.pokemon;
		const switchIdx = parseInt(choice.split(' ')[1]) - 1;
		const switchTo = pokemon?.[switchIdx];
		if (switchTo && virtualState) {
			const switchToPokemon = this.buildAIPokemon(switchTo, switchIdx + 1, false);
			const logger = side === 'p2' ? this.p2Logger : this.p4Logger;
			logger.logSwitchDecision(
				this.currentTurn,
				null, // No current Pokemon (fainted)
				switchToPokemon,
				[], // No switch scores for force switch
				'Force switch (previous Pokemon fainted)',
				virtualState
			);
		}
	}

	/**
	 * Handle team preview for a side
	 * In multi battle, each side has 3 Pokemon and needs to choose lead
	 */
	private handleTeamPreview(side: 'p2' | 'p4', player: AnyObject, request: AnyObject): void {
		// For now, just use default order (lead with first Pokemon)
		// Team preview format: "team 123" means order 1, 2, 3
		const pokemon = request.side?.pokemon;
		const teamSize = pokemon?.length || 3;

		// Build team order string (e.g., "123" for 3 Pokemon)
		let teamOrder = '';
		for (let i = 1; i <= teamSize; i++) {
			teamOrder += i;
		}

		const choice = `team ${teamOrder}`;
		this.sendChoice(side, choice);

		// Log team preview using logger
		const team: AIPokemon[] = (pokemon || []).map((mon: AnyObject, i: number) =>
			this.buildAIPokemon(mon, i + 1, false)
		);
		const order = Array.from({ length: teamSize }, (_, i) => i + 1);
		const logger = side === 'p2' ? this.p2Logger : this.p4Logger;
		logger.logTeamPreview(0, team, order, ['Default lead order']);
	}

	/**
	 * Send choice to battle stream
	 */
	private sendChoice(side: 'p2' | 'p4', choice: string): void {
		void this.roomBattle.stream.write(`>${side} ${choice}`);
	}
}
