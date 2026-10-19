/**
 * CFRU AI - Battle State Tracker
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Tracks opponent Pokemon information from battle protocol messages.
 * This is necessary because in server environment, the Battle object
 * runs in a separate process and is not directly accessible.
 *
 * @license MIT
 */

import { Dex, toID } from '../../../../../sim/dex';
import { abilityStatModifier, effectiveAbility, hasNeutralizingGas, normalizeWeather } from './mechanics';
import { defaultBoosts, type AIPokemon } from '../types';

/** Only facts available in our request; never store inferred models or scoring state here. */
type RequestPokemonFacts = Pick<AIPokemon, 'species' | 'types' | 'baseStats' | 'ability' | 'moves' | 'item'>;

export interface TrackedTransformation {
	targetIdent: string;
	/** Public opponent state at the instant of Transform, before later switches or boosts. */
	target?: TrackedPokemon;
	/** Our own request data is legitimate knowledge of what the opponent copied. */
	pokemon?: RequestPokemonFacts;
	knownMoves: string[];
}

export { normalizeWeather } from './mechanics';

/**
 * Tracked Pokemon information
 */
export interface TrackedPokemon {
	sleepSelfInflicted?: boolean;
	transformation?: TrackedTransformation;
	/** Public identity scoped to a player, not the active position. */
	ident?: string;
	/** Public temporary effects; cleared when this Pokemon leaves the field. */
	volatiles?: Set<string>;
	/** Species name */
	species: string;

	/** Pokemon types */
	types: string[];

	/** Pokemon level (parsed from details, defaults to 100) */
	level: number;

	/** Known ability (may be empty if not revealed) */
	ability: string;
	/** Native ability, retained separately from temporary copies, swaps and suppression. */
	baseAbility?: string;
	/** Whether the current ability differs from the native ability during this stay. */
	abilityChanged?: boolean;

	/** Known item (may be empty if not revealed) */
	item: string;
	/** First public item, retained after consumption; acquired items do not identify the original set. */
	originalItem?: string;
	itemChanged?: boolean;
	recyclableItem?: string;
	itemKnockedOff?: boolean;

	/**
	 * Whether we know for sure the item was lost (consumed/knocked off)
	 * true = confirmed no item (saw -enditem message)
	 * false = item unknown or item is known to exist
	 */
	itemLost: boolean;

	/** Current HP percentage (0-100) */
	hpPercent: number;

	/** Status condition (empty if none) */
	status: string;

	/** Known moves (revealed through battle) */
	knownMoves: string[];

	/** Last move used (for Encore/Disable evaluation) */
	lastMove: string;

	/** Is currently active */
	active: boolean;

	/** Position identifier (e.g., 'p1a', 'p1b' for doubles) */
	position: string;

	/** Stat boosts (-6 to +6) */
	boosts: {
		atk: number;
		def: number;
		spa: number;
		spd: number;
		spe: number;
		accuracy: number;
		evasion: number;
	};
}

/** Identity-bound facts; position-bound effects remain in the active maps. */
interface IdentityMemory {
	timesAttacked?: number;
	restSleep?: number;
	sleepSource?: boolean;
	consumedItem?: string;
	knockedOff?: boolean;
	/** Presence with an unknown item records an unconfirmed opponent Natural Gift. */
	naturalGift?: { item?: string };
}

/** Bounded to one stay, so an Illusion reveal can reassign observations without replaying the battle. */
interface EntryObservations {
	receivedHits?: number;
	toxicTicks?: number;
	ident: string;
	/** Copy callbacks depending on the recipient's ability wait for public/authorized identity facts. */
	copyEffectsPending?: boolean;
	previous?: TrackedPokemon;
	memory: IdentityMemory;
	memoryUpdates: IdentityMemory;
	sleeping: boolean;
	sleepChecks: number;
	moves: Set<string>;
	item?: { item: string, itemLost: boolean, originalItem?: string, itemChanged?: boolean };
}

/**
 * Battle Tracker - Monitors battle protocol messages to track opponent state
 *
 * Usage:
 * ```typescript
 * const tracker = new BattleTracker('p2');  // We are p2
 * tracker.attachToStream(battle.stream);
 *
 * // Later, get opponent info
 * const opponent = tracker.getActiveOpponent();
 * if (opponent) {
 *     console.log(opponent.types, opponent.ability, opponent.item);
 * }
 * ```
 */
export class BattleTracker {
	/** Which player we are (p1 or p2) */
	private readonly ourSide: 'p1' | 'p2';

	/** Which player is opponent */
	private readonly opponentSide: 'p1' | 'p2';

	/** Tracked opponent Pokemon (keyed by position like 'p1a', 'p1b') */
	private opponentPokemon: Map<string, TrackedPokemon> = new Map();
	private activeVolatiles = new Map<string, Set<string>>();
	/** Protocol-declared effects expire either at the end of this turn or the holder's next action. */
	private transientEffects = new Map<string, Map<string, 'turn' | 'move'>>();
	private turn = 0;
	/** Raw PS logs can contain split private/public pairs; tracker consumes only their public branch. */
	private skipPrivateLine = false;
	private acted = new Set<string>();
	private slotEffects = new Map<string, { wish?: number, futuremove?: number }>();
	private pendingFutureMove?: { source: string, target: string };
	private pendingWishPosition = '';
	private teamSizes = new Map<string, number>();
	private formatId = '';
	private activeIdentities = new Map<string, string>();
	private identityMemory = new Map<string, IdentityMemory>();
	private entries = new Map<string, EntryObservations>();
	private yawnSources = new Map<string, string>();
	private lastMoveSource = '';
	private currentAttack?: { source: string, damaging: boolean, hits: Map<string, number> };
	private transformations = new Map<string, TrackedTransformation>();
	private ourPokemon = new Map<string, { ident: string, pokemon: RequestPokemonFacts }>();
	private activeAbilities = new Map<string, string>();

	/** All known opponent Pokemon (keyed by player and public nickname for team tracking) */
	private opponentTeam: Map<string, TrackedPokemon> = new Map();

	/** Temporary types revealed by battle protocol, shared by both teams. */
	private activeTypes = new Map<string, { types?: string[], added?: string }>();

	/** Field conditions */
	private fieldConditions: {
		weather: string,
		weatherId: string,
		terrain: string,
		trickRoom: boolean,
		gravity: boolean,
		magicRoom: boolean,
		wonderRoom: boolean,
	} = { weather: '', weatherId: '', terrain: '', trickRoom: false, gravity: false, magicRoom: false, wonderRoom: false };

	/** Opponent side conditions */
	private opponentSideConditions: {
		stealthrock: boolean;
		spikes: number;
		toxicspikes: number;
		stickyweb: boolean;
		reflect: number;
		lightscreen: number;
		auroraveil: number;
		tailwind: number;
		safeguard: number,
		mist: number,
	} = {
		stealthrock: false,
		spikes: 0,
		toxicspikes: 0,
		stickyweb: false,
		reflect: 0,
		lightscreen: 0,
		auroraveil: 0,
		tailwind: 0, safeguard: 0, mist: 0,
	};

	/** Our side conditions (for tracking hazards on our side) */
	private ourSideConditions: {
		stealthrock: boolean,
		spikes: number,
		toxicspikes: number,
		stickyweb: boolean,
		reflect: number,
		lightscreen: number,
		auroraveil: number,
		tailwind: number,
		safeguard: number,
		mist: number,
	} = {
		stealthrock: false,
		spikes: 0,
		toxicspikes: 0,
		stickyweb: false,
		reflect: 0,
		lightscreen: 0,
		auroraveil: 0,
		tailwind: 0, safeguard: 0, mist: 0,
	};

	/**
	 * Our active Pokemon boosts (tracked from stream messages)
	 * Keyed by position slot ('a', 'b' for doubles)
	 */
	private ourActiveBoosts: Map<string, {
		atk: number,
		def: number,
		spa: number,
		spd: number,
		spe: number,
		accuracy: number,
		evasion: number,
	}> = new Map();

	/**
	 * Our active Pokemon last move used (CFRU gLastResultingMoves[bankAtk])
	 * Keyed by position slot ('a', 'b' for doubles)
	 * Used for consecutive Protect detection
	 */
	private ourLastMove: Map<string, string> = new Map();

	/** Whether we've attached to a stream */
	private attached = false;

	/** Whether this is a multi battle */
	private isMultiBattle = false;

	/** Opponent sides (for multi battles: p1 & p3 or p2 & p4) */
	private opponentSides: Set<string>;

	/** Our team sides (for multi battles: p2 & p4 or p1 & p3) */
	private ourTeamSides: Set<string>;

	constructor(ourSide: 'p1' | 'p2' = 'p2', isMulti = false) {
		this.ourSide = ourSide;
		this.opponentSide = ourSide === 'p1' ? 'p2' : 'p1';
		this.isMultiBattle = isMulti;

		// In multi battles, track both opponent sides and our team sides
		// Team 1: p1 + p3, Team 2: p2 + p4
		if (isMulti) {
			if (ourSide === 'p1' || ourSide === 'p2') {
				// If we're p2 (or p1), opponents are p1 and p3 (or p2 and p4)
				this.opponentSides = new Set(ourSide === 'p2' ? ['p1', 'p3'] : ['p2', 'p4']);
				// Our team is the opposite
				this.ourTeamSides = new Set(ourSide === 'p2' ? ['p2', 'p4'] : ['p1', 'p3']);
			} else {
				this.opponentSides = new Set(['p1', 'p3']); // Default for p2/p4 perspective
				this.ourTeamSides = new Set(['p2', 'p4']);
			}
		} else {
			this.opponentSides = new Set([this.opponentSide]);
			this.ourTeamSides = new Set([this.ourSide]);
		}
	}

	/**
	 * Check if a side is an opponent
	 */
	private isOpponentSide(side: string): boolean {
		return this.opponentSides.has(side);
	}

	/**
	 * Check if a side is on our team (for multi battles: both p2 and p4)
	 */
	private isOurTeamSide(side: string): boolean {
		return this.ourTeamSides.has(side);
	}

	/**
	 * Attach to a battle stream to receive protocol messages
	 */
	attachToStream(stream: AnyObject): void {
		if (this.attached) return;
		this.attached = true;

		// Intercept stream.push to parse messages
		const originalPush = stream.push.bind(stream);
		stream.push = (chunk: string) => {
			if (chunk) {
				this.parseMessage(chunk);
			}
			return originalPush(chunk);
		};
	}

	/**
	 * Parse a battle protocol message
	 */
	parseMessage(message: string): void {
		const lines = message.split('\n');
		for (const line of lines) {
			this.parseLine(line);
		}
	}

	/**
	 * Parse a single protocol line
	 */
	private parseLine(line: string): void {
		if (!line) return;
		if (this.skipPrivateLine) {
			this.skipPrivateLine = false;
			return;
		}
		if (!line.startsWith('|')) return;

		const parts = line.slice(1).split('|');
		const command = parts[0];
		if (command === 'split') {
			this.skipPrivateLine = true;
			return;
		}
		this.handleAbilityEvent(parts);
		this.recordAttackHit(parts);
		const entry = this.entries.get(parts[1]?.split(':')[0].trim());
		if (entry && parts[0] === '-damage' && parts.includes('[from] psn')) entry.toxicTicks = (entry.toxicTicks || 0) + 1;
		if (entry && ['-status', '-curestatus'].includes(parts[0])) entry.toxicTicks = 0;

		switch (command) {
		case 'teamsize':
			this.teamSizes.set(parts[1], Number(parts[2]));
			break;
		case 'turn':
			this.currentAttack = undefined;
			this.clearTransientEffects('turn');
			this.lastMoveSource = '';
			this.turn = Number(parts[1]) || this.turn;
			break;
		case 'switch':
		case 'drag':
			this.handleSwitch(parts);
			break;
		case 'replace':
			this.handleReplace(parts);
			break;
		case 'swap':
			this.handleSwap(parts);
			break;
		case 'faint':
			this.handleFaint(parts);
			break;
		case '-transform':
			this.handleTransform(parts);
			break;
		case 'detailschange':
		case '-formechange': {
			const position = parts[1]?.split(':')[0].trim();
			this.activeTypes.delete(position);
			const tracked = this.opponentPokemon.get(position);
			if (tracked) {
				const species = (this.formatId ? Dex.forFormat(this.formatId) : Dex).species.get(parts[2].split(',')[0]);
				tracked.species = species.name;
				tracked.types = species.types;
				if (species.isMega || species.id === 'greninjaash') {
					tracked.ability = species.abilities[0];
					this.activeAbilities.set(position, tracked.ability);
					tracked.baseAbility = tracked.ability;
					tracked.abilityChanged = false;
				}
			}
			break;
		}
		case '-item':
		case '-enditem':
			this.handleItem(parts);
			break;
		case '-damage':
		case '-heal':
			this.handleHPChange(parts);
			const item = parts.find(p => p.startsWith('[from] item: '));
			if (item && !parts.some(p => p.startsWith('[of]'))) {
				this.handleItem(['-item', parts[1], item.slice('[from] item: '.length)], true);
			}
			break;
		case '-block':
		case '-activate':
			if (parts[2]?.startsWith('item: ')) this.handleItem(['-item', parts[1], parts[2].slice(6)], true);
			break;
		case '-status':
			this.handleStatus(parts);
			break;
		case '-curestatus':
		case '-cureteam':
			this.handleCureStatus(parts);
			break;
		case 'cant':
			this.clearTransientEffects('move', parts[1].split(':')[0].trim());
			this.acted.add(parts[1].split(':')[0].trim());
			if (parts[2] === 'slp') {
				const position = parts[1].split(':')[0];
				const decrement = this.getEffectiveAbility(position) === 'earlybird' ? 2 : 1;
				const entry = this.entries.get(position);
				if (entry) entry.sleepChecks += decrement;
				if (entry?.memory.restSleep !== undefined) {
					entry.memory.restSleep += decrement;
					if ('restSleep' in entry.memoryUpdates) entry.memoryUpdates.restSleep = entry.memory.restSleep;
				}
			}
			break;
		case 'move':
			this.currentAttack = { source: parts[1].split(':')[0].trim(),
				damaging: (this.formatId ? Dex.forFormat(this.formatId) : Dex).moves.get(parts[2]).category !== 'Status', hits: new Map() };
			this.clearTransientEffects('move', parts[1].split(':')[0].trim());
			this.acted.add(parts[1].split(':')[0].trim());
			this.pendingWishPosition = '';
			this.pendingFutureMove = ['futuresight', 'doomdesire'].includes(toID(parts[2])) ? {
				source: parts[1].split(':')[0].trim(), target: parts[3]?.split(':')[0].trim(),
			} : undefined;
			if (toID(parts[2]) === 'wish') {
				const position = parts[1].split(':')[0].trim();
				if (!this.getWish(position)) {
					this.setSlotEffect(position, 'wish', this.turn + 2);
					this.pendingWishPosition = position;
				}
			}
			this.handleMove(parts);
			break;
		case '-fail': {
			const position = parts[1]?.split(':')[0].trim();
			// A repeated Wish must not extend an existing timer; a failed new Wish creates none.
			if (position === this.pendingWishPosition) this.setSlotEffect(position, 'wish', 0);
			break;
		}
		case '-weather':
			this.handleWeather(parts);
			break;
		case '-fieldstart':
		case '-fieldend':
			this.handleField(parts);
			break;
		case '-boost':
		case '-unboost':
			this.handleBoost(parts);
			break;
		case '-setboost':
			this.handleSetBoost(parts);
			break;
		case '-clearboost':
		case '-clearallboost':
		case '-clearpositiveboost':
		case '-clearnegativeboost':
			this.handleClearBoost(parts);
			break;
		case '-sidestart':
		case '-sideend':
			this.handleSideCondition(parts);
			break;
		case '-start':
		case '-end':
			this.handleVolatileStatus(parts);
			break;
		case '-singleturn':
		case '-singlemove': {
			const position = parts[1].split(':')[0].trim();
			const effect = toID(parts[2].replace(/^(?:move|ability): /, ''));
			const effects = this.transientEffects.get(position) || new Map();
			effects.set(effect, command === '-singleturn' ? 'turn' : 'move');
			this.transientEffects.set(position, effects);
			this.handleVolatileStatus(['-start', parts[1], effect]);
			break;
		}
		case 'upkeep':
			this.currentAttack = undefined;
			this.clearTransientEffects('turn');
			break;
		}
	}

	/**
	 * Handle switch/drag
	 * Format: |switch|p1a: Nickname|Species, L50, M|100/100
	 *
	 * IMPORTANT: When our Pokemon switches out, its boosts are reset to 0.
	 * CFRU: protectUses and lastMove are also reset when switching
	 */
	private handleSwitch(parts: string[]): void {
		const positionPart = parts[1]; // "p1a: Nickname"
		if (!positionPart) return;

		const position = positionPart.split(':')[0].trim(); // "p1a"
		const side = position.slice(0, 2); // "p1"
		const slot = position.slice(2); // "a" or "b"
		const transfer = this.getSwitchTransfer(parts, position);

		const sleepIdent = this.publicIdentity(positionPart);
		const outgoingIdent = this.activeIdentities.get(position);
		const outgoingEntry = this.entries.get(position);
		if (outgoingEntry) this.identityMemory.set(outgoingEntry.ident, { ...outgoingEntry.memory });
		const entry: EntryObservations = {
			ident: sleepIdent, memory: { ...this.identityMemory.get(sleepIdent) }, memoryUpdates: {},
			sleeping: !!parts[3]?.split(' ').includes('slp'), sleepChecks: 0, moves: new Set(),
			copyEffectsPending: transfer.copyEffects,
		};
		this.entries.set(position, entry);
		// PS Gen 3–4 carries the recyclable item with the position when switching.
		if (outgoingIdent && outgoingIdent !== sleepIdent && this.formatId && Dex.forFormat(this.formatId).gen <= 4) {
			this.updateIdentityMemory(sleepIdent, { consumedItem: this.identityMemory.get(outgoingIdent)?.consumedItem });
			this.updateIdentityMemory(outgoingIdent, { consumedItem: undefined });
		}
		this.yawnSources.delete(position);
		this.activeIdentities.set(position, sleepIdent);
		entry.memory = this.memoryOnEntry(entry.memory, entry.sleeping);

		this.activeVolatiles.set(position, transfer.volatiles);
		this.transientEffects.set(position, transfer.transient);
		this.activeTypes.delete(position);
		this.acted.delete(position);
		this.transformations.delete(position);
		this.ourPokemon.delete(position);
		this.activeAbilities.delete(position);
		const outgoing = this.opponentPokemon.get(position);
		if (outgoing) {
			outgoing.active = false;
			outgoing.types = [...(this.formatId ? Dex.forFormat(this.formatId) : Dex).species.get(outgoing.species).types];
			delete outgoing.transformation;
			outgoing.ability = outgoing.baseAbility || '';
			outgoing.abilityChanged = false;
			outgoing.boosts = defaultBoosts();
			outgoing.lastMove = '';
			outgoing.volatiles = new Set();
			outgoing.recyclableItem = this.getRecyclableItem(outgoing.ident || '');
		}

		// Entry state is reset or inherited by the same rule for both controlled players in Multi.
		if (this.isOurTeamSide(side)) {
			const boostKey = `${side}${slot}`;
			this.ourActiveBoosts.set(boostKey, transfer.boosts);
			// Reset lastMove (CFRU: switching resets gDisableStructs)
			this.ourLastMove.set(boostKey, '');
			return; // Don't need to track our own Pokemon details
		}

		// Only track opponent details below (for multi: p1 AND p3)
		if (!this.isOpponentSide(side)) return;

		const detailPart = parts[2]; // "Species, L50, M"
		if (!detailPart) return;

		// Parse species and level from details
		// Format: "Species, L50, M" or "Species-Forme, L100, F" or "Species, L50" (no gender)
		const detailParts = detailPart.split(',').map(s => s.trim());
		const species = detailParts[0];

		// Parse level from "L50" or "L100" format, default to 100 (National Dex standard)
		let level = 100;
		for (const part of detailParts) {
			if (/^L\d+$/.test(part)) {
				const parsedLevel = parseInt(part.slice(1));
				if (!isNaN(parsedLevel)) {
					level = parsedLevel;
				}
				break;
			}
		}

		const hpPart = parts[3]; // "100/100" or "100/100 par"

		// Parse HP
		let hpPercent = 100;
		let status = '';
		if (hpPart) {
			const hpMatch = hpPart.match(/(\d+)\/(\d+)/);
			if (hpMatch) {
				hpPercent = (parseInt(hpMatch[1]) / parseInt(hpMatch[2])) * 100;
			}
			const statusMatch = hpPart.match(/\d+\/\d+\s+(\w+)/);
			if (statusMatch) {
				status = statusMatch[1];
			}
		}

		// Get species data
		const speciesData = (this.formatId ? Dex.forFormat(this.formatId) : Dex).species.get(species);
		const types = speciesData.types || [];

		// Check for known ability from species (if only one possible)
		let ability = '';
		const abilities = Object.values(speciesData.abilities || {});
		if (abilities.length === 1) {
			ability = abilities[0] as string;
		}

		// Create or update tracked Pokemon
		const ident = `${side}:${positionPart.split(':').slice(1).join(':').trim()}`;
		const tracked: TrackedPokemon = {
			ident,
			sleepSelfInflicted: status === 'slp' ? entry.memory.sleepSource : undefined,
			volatiles: this.activeVolatiles.get(position),
			species,
			types,
			level,
			ability,
			baseAbility: ability,
			abilityChanged: false,
			item: '',
			itemLost: false,  // Default: assume item exists but unknown
			recyclableItem: this.getRecyclableItem(positionPart),
			hpPercent,
			status,
			knownMoves: [],
			lastMove: '',
			active: true,
			position,
			boosts: transfer.boosts,
		};

		// Deactivate previous Pokemon in this exact position (not other positions on same side)
		const existingInPosition = this.opponentPokemon.get(position);
		if (existingInPosition && existingInPosition.ident !== ident) {
			existingInPosition.active = false;
		}

		// Update if we already know this Pokemon
		const existing = this.opponentTeam.get(ident);
		if (existing) {
			entry.previous = existing;
			tracked.ability = existing.baseAbility ?? existing.ability;
			tracked.baseAbility = tracked.ability;
			tracked.item = existing.item;
			tracked.itemLost = existing.itemLost;  // Preserve itemLost status
			tracked.originalItem = existing.originalItem;
			tracked.itemChanged = existing.itemChanged;
			tracked.itemKnockedOff = existing.itemKnockedOff;
			tracked.knownMoves = [...existing.knownMoves];
		}

		this.opponentPokemon.set(position, tracked);
		this.opponentTeam.set(ident, tracked);
		this.resolveCopiedEffects(position, tracked.ability);
	}

	/** Only a successful switch's public source can authorize carrying effects to another Pokemon. */
	private getSwitchTransfer(parts: string[], position: string) {
		const dex = this.formatId ? Dex.forFormat(this.formatId) : Dex;
		const source = parts.find(part => part.startsWith('[from] '))?.slice(7).replace(/^move: /, '');
		const kind = parts[0] === 'switch' && source ? dex.moves.get(source).selfSwitch : false;
		const volatiles = new Set<string>();
		const transient = new Map<string, 'turn' | 'move'>();
		const boosts = kind === 'copyvolatile' ? { ...(this.opponentPokemon.get(position)?.boosts ||
			this.ourActiveBoosts.get(position) || defaultBoosts()) } : defaultBoosts();
		if (kind === 'copyvolatile' || kind === 'shedtail') {
			for (const effect of this.activeVolatiles.get(position) || []) {
				if (kind === 'shedtail' && effect !== 'substitute') continue;
				// Perish Song exposes its countdown in the protocol instead of its condition ID.
				const condition = dex.conditions.get(/^perish[0-3]$/.test(effect) ? 'perishsong' : effect);
				if (!condition.exists || condition.noCopy) continue;
				volatiles.add(effect);
				const lifetime = this.transientEffects.get(position)?.get(effect);
				if (lifetime) transient.set(effect, lifetime);
			}
		}
		return { boosts, volatiles, transient, copyEffects: kind === 'copyvolatile' };
	}

	private resolveCopiedEffects(position: string, ability: string): void {
		const entry = this.entries.get(position);
		if (!entry?.copyEffectsPending || !ability) return;
		const dex = this.formatId ? Dex.forFormat(this.formatId) : Dex;
		// Gastro Acid's PS onCopy removes suppression when the recipient cannot be suppressed.
		if (dex.abilities.get(ability).flags.cantsuppress) this.activeVolatiles.get(position)?.delete('gastroacid');
		entry.copyEffectsPending = false;
	}

	/** Move the occupants' observations; Wish and future attacks stay on their field positions. */
	private handleSwap(parts: string[]): void {
		const from = parts[1]?.split(':')[0].trim();
		const index = Number(parts[2]);
		if (!from || !/^\d+$/.test(parts[2] || '') || index > 2) return;
		const to = `${from.slice(0, 2)}${String.fromCharCode(97 + index)}`;
		if (from === to) return;
		const swap = <T>(map: Map<string, T>) => {
			const a = map.get(from);
			const b = map.get(to);
			map.delete(from);
			map.delete(to);
			if (a !== undefined) map.set(to, a);
			if (b !== undefined) map.set(from, b);
		};
		swap(this.opponentPokemon);
		swap(this.activeVolatiles);
		swap(this.transientEffects);
		swap(this.activeTypes);
		swap(this.activeAbilities);
		swap(this.activeIdentities);
		swap(this.entries);
		swap(this.ourPokemon);
		swap(this.ourActiveBoosts);
		swap(this.ourLastMove);
		swap(this.transformations);
		swap(this.yawnSources);
		const fromActed = this.acted.delete(from);
		const toActed = this.acted.delete(to);
		if (fromActed) this.acted.add(to);
		if (toActed) this.acted.add(from);
		for (const position of [from, to]) {
			const pokemon = this.opponentPokemon.get(position);
			if (pokemon) pokemon.position = position;
		}
	}

	/** Illusion ends without leaving the field: all position-bound effects and action history survive. */
	private handleReplace(parts: string[]): void {
		const position = parts[1]?.split(':')[0].trim();
		if (!position || !parts[2]) return;
		const ident = this.publicIdentity(parts[1]);
		const entry = this.entries.get(position);
		const tracked = this.opponentPokemon.get(position);
		if (tracked && entry) {
			const formerIdent = tracked.ident || entry.ident;
			if (formerIdent !== ident) {
				const other = [...this.opponentPokemon.values()].find(p => p !== tracked && p.active && p.ident === formerIdent);
				if (other) {
					const otherEntry = this.entries.get(other.position);
					if (otherEntry?.previous === tracked) {
						this.applyEntryKnowledge(other, otherEntry, entry.previous);
						otherEntry.previous = entry.previous;
					}
					this.opponentTeam.set(formerIdent, other);
				} else if (entry.previous) {
					this.opponentTeam.set(formerIdent, entry.previous);
				} else {
					this.opponentTeam.delete(formerIdent);
				}
			}
			const history = formerIdent === ident ? entry.previous : this.opponentTeam.get(ident);
			const details = parts[2].split(',').map(part => part.trim());
			const species = (this.formatId ? Dex.forFormat(this.formatId) : Dex).species.get(details[0]);
			tracked.ident = ident;
			tracked.species = species.name;
			tracked.types = [...species.types];
			tracked.level = Number(details.find(part => /^L\d+$/.test(part))?.slice(1)) || 100;
			this.applyEntryKnowledge(tracked, entry, history);
			this.opponentTeam.set(ident, tracked);
			entry.previous = history;
		}
		this.rebindIdentity(position, ident);
		if (tracked) {
			tracked.recyclableItem = this.getRecyclableItem(parts[1]);
			tracked.itemKnockedOff = this.wasItemKnockedOff(parts[1]);
			tracked.sleepSelfInflicted = this.getIdentityMemory(position).sleepSource;
			// Some protocols provide condition on replace; PS can omit it entirely.
			if (parts[3]) this.handleHPChange(['-damage', parts[1], parts[3]]);
		}
	}

	private applyEntryKnowledge(tracked: TrackedPokemon, entry: EntryObservations, history?: TrackedPokemon): void {
		const dex = this.formatId ? Dex.forFormat(this.formatId) : Dex;
		const abilities = Object.values(dex.species.get(tracked.species).abilities);
		tracked.baseAbility = history?.baseAbility || (abilities.length === 1 ? abilities[0] : '');
		if (!tracked.abilityChanged) tracked.ability = tracked.baseAbility || '';
		this.activeAbilities.set(tracked.position, tracked.ability);
		tracked.knownMoves = [...new Set([...(history?.knownMoves || []), ...entry.moves])];
		tracked.item = entry.item?.item ?? history?.item ?? '';
		tracked.itemLost = entry.item?.itemLost ?? history?.itemLost ?? false;
		tracked.originalItem = entry.item?.originalItem || history?.originalItem;
		tracked.itemChanged = entry.item?.itemChanged || history?.itemChanged;
	}

	private handleTransform(parts: string[]): void {
		const position = parts[1]?.split(':')[0].trim();
		const targetPosition = parts[2]?.split(':')[0].trim();
		if (!position || !targetPosition) return;
		const target = this.opponentPokemon.get(targetPosition);
		const own = this.ourPokemon.get(targetPosition);
		const transformation: TrackedTransformation = {
			targetIdent: this.sleepIdentity(parts[2]),
			knownMoves: [],
		};
		if (target) {
			transformation.target = { ...target, types: this.getTypes(targetPosition, target.types),
				knownMoves: [...target.knownMoves],
				boosts: { ...target.boosts }, volatiles: new Set(target.volatiles) };
		} else if (own?.ident === transformation.targetIdent) {
			transformation.pokemon = { ...own.pokemon, types: this.getTypes(targetPosition, own.pokemon.types),
				baseStats: { ...own.pokemon.baseStats }, moves: [...own.pokemon.moves] };
		}
		this.transformations.set(position, transformation);
		if ((this.formatId ? Dex.forFormat(this.formatId) : Dex).gen > 2) {
			this.activeAbilities.set(position, target?.ability || own?.pokemon.ability || '');
		}
		this.activeTypes.delete(position);
		const boosts = target ? { ...target.boosts } : this.getOurActiveBoosts(targetPosition);
		if (this.isOurTeamSide(position.slice(0, 2))) {
			this.ourActiveBoosts.set(position, boosts);
		} else {
			const tracked = this.opponentPokemon.get(position);
			if (!tracked) return;
			if (parts.includes('[from] ability: Imposter')) this.recordAbility(parts[1], 'Imposter');
			tracked.transformation = transformation;
			tracked.boosts = boosts;
			if ((this.formatId ? Dex.forFormat(this.formatId) : Dex).gen > 2) {
				tracked.abilityChanged = true;
				tracked.ability = target?.ability || own?.pokemon.ability || '';
			}
		}
	}

	getTransformation(position: string): TrackedTransformation | undefined {
		return this.transformations.get(position.startsWith('p') ? position : `${this.ourSide}${position}`);
	}

	recordRequestItem(ident: string, item: string): void {
		const identity = this.sleepIdentity(ident);
		const pending = this.getIdentityMemory(identity).naturalGift;
		if (pending) {
			this.updateIdentityMemory(identity, { naturalGift: undefined,
				...(pending.item && !item ? { consumedItem: toID(pending.item) } : {}) });
		}
	}

	rememberOurPokemon(position: string, ident: string, pokemon: RequestPokemonFacts): void {
		const key = position.startsWith('p') ? position : `${this.ourSide}${position}`;
		this.rebindIdentity(key, this.publicIdentity(ident));
		const facts = { species: pokemon.species, types: [...pokemon.types], baseStats: { ...pokemon.baseStats },
			ability: pokemon.ability, moves: [...pokemon.moves], item: pokemon.item };
		this.ourPokemon.set(key, { ident: this.sleepIdentity(ident), pokemon: facts });
		this.activeAbilities.set(key, pokemon.ability);
		this.resolveCopiedEffects(key, pokemon.ability);
		// An opening Imposter can precede the first request containing our own stats.
		for (const transformation of this.transformations.values()) {
			if (!transformation.target && !transformation.pokemon &&
				transformation.targetIdent === this.sleepIdentity(ident)) {
				transformation.pokemon = { ...facts };
			}
		}
	}

	/**
	 * Handle faint
	 * Format: |faint|p1a: Nickname
	 */
	private handleFaint(parts: string[]): void {
		const positionPart = parts[1];
		if (!positionPart) return;

		const position = positionPart.split(':')[0].trim();
		const side = position.slice(0, 2);
		this.activeAbilities.delete(position);
		this.ourPokemon.delete(position);

		if (!this.isOpponentSide(side)) return;

		const tracked = this.opponentPokemon.get(position);
		if (tracked) {
			tracked.active = false;
			tracked.hpPercent = 0;
		}
	}

	/**
	 * Record a public reveal without persisting temporary ability changes across switches.
	 */
	private recordAbility(positionPart: string | undefined, ability: string, changed = false, previous = ''): void {
		if (!positionPart) return;

		const position = positionPart.split(':')[0].trim();
		const side = position.slice(0, 2);
		this.activeAbilities.set(position, ability);
		this.resolveCopiedEffects(position, changed ? previous : ability);

		if (this.isOurTeamSide(side)) {
			const own = this.ourPokemon.get(position);
			if (own) own.pokemon.ability = ability;
			return;
		}
		if (!this.isOpponentSide(side)) return;

		const tracked = this.opponentPokemon.get(position);
		if (tracked) {
			if (changed) {
				if (!tracked.abilityChanged && previous) tracked.baseAbility = previous;
				tracked.abilityChanged = true;
			} else if (!tracked.abilityChanged) {
				tracked.baseAbility = ability;
			}
			tracked.ability = ability;

		}
	}

	/**
	 * Ability names appear in several protocol events, with event-specific ownership.
	 * In particular, absorption's [of] is the attacker, while damage's [of] is the ability holder.
	 */
	private handleAbilityEvent(parts: string[]): void {
		const [command, pokemon, effect] = parts;
		const of = parts.find(part => part.startsWith('[of] '))?.slice('[of] '.length);
		const from = parts.find(part => part.startsWith('[from] ability: '))?.slice('[from] ability: '.length);

		if (command === '-ability') {
			if (!effect) return;
			// setAbility emits the old ability in the fourth field; ordinary reveals may put "boost" there.
			const previous = parts[3] && Dex.abilities.get(parts[3]).exists ? parts[3] : '';
			this.recordAbility(pokemon, effect, !!previous, previous);
			if (['trace', 'receiver', 'powerofalchemy'].includes(toID(from)) ||
				parts.includes('[from] move: Role Play')) {
				this.recordAbility(of, effect);
			} else if (from && of && of !== pokemon) {
				this.recordAbility(of, from);
			}
			return;
		}
		if (command === '-endability') {
			// Gastro Acid emits no -start event. It suppresses, rather than replaces, the ability.
			this.handleVolatileStatus(['-start', pokemon, 'gastroacid']);
			return;
		}
		if (command === '-activate' && (effect === 'move: Skill Swap' || effect === 'Skill Swap')) {
			// The public fields contain the new ability of each participant; allied swaps hide them.
			const oursPosition = pokemon?.split(':')[0].trim();
			const ours = this.activeAbilities.get(oursPosition) ?? this.opponentPokemon.get(oursPosition)?.ability ?? '';
			const theirsPosition = of?.split(':')[0].trim() || '';
			const theirs = this.activeAbilities.get(theirsPosition) ?? this.opponentPokemon.get(theirsPosition)?.ability ?? '';
			this.recordAbility(pokemon, parts[3] || theirs, true, parts[4] || ours);
			this.recordAbility(of, parts[4] || ours, true, parts[3] || theirs);
			return;
		}

		const direct = effect?.startsWith('ability: ') ? effect.slice('ability: '.length) : '';
		switch (command) {
		case '-immune':
		case '-fail':
			if (from) this.recordAbility(of || pokemon, from);
			break;
		case '-heal':
			// Hospitality heals another Pokemon; absorb abilities and residual recovery heal their holder.
			if (from) this.recordAbility(toID(from) === 'hospitality' ? of : pokemon, from);
			break;
		case '-damage':
			if (from) this.recordAbility(of || pokemon, from);
			break;
		case '-weather':
		case '-fieldstart':
			if (from) this.recordAbility(of, from);
			break;
		case '-start':
		case '-activate':
		case 'cant':
			if (direct) this.recordAbility(pokemon, direct);
			else if (from) this.recordAbility(of || pokemon, from);
			break;
		case '-status':
			if (from) this.recordAbility(of, from);
			break;
		case '-block':
			if (direct) this.recordAbility(of || pokemon, direct);
			break;
		}
	}

	/**
	 * Handle item reveal
	 * Format: |-item|p1a: Nickname|Air Balloon
	 *         |-enditem|p1a: Nickname|Air Balloon
	 */
	private handleItem(parts: string[], revealOnly = false): void {
		const command = parts[0];
		const positionPart = parts[1];
		if (!positionPart) return;

		const position = positionPart.split(':')[0].trim();
		const side = position.slice(0, 2);
		const item = parts[2];
		if (!item) return;
		const identity = this.sleepIdentity(positionPart);
		const from = parts.find(p => p.startsWith('[from]')) || '';
		const own = this.ourPokemon.get(position);
		// A consumed item's subsequent effect reveals its source, not a newly held item.
		if (revealOnly && (this.entries.get(position)?.item?.itemLost || (own && !own.pokemon.item))) return;
		if (own) own.pokemon.item = command === '-enditem' ? '' : item;
		// An explicit loss is not the silent consumption inferred from Natural Gift.
		this.updateIdentityMemory(identity, { naturalGift: undefined }, position);
		if (command === '-enditem' && from === '[from] move: Knock Off' && this.formatId &&
			Dex.forFormat(this.formatId).gen <= 4) this.updateIdentityMemory(identity, { knockedOff: true }, position);
		if (command === '-enditem' && (parts.includes('[eat]') || from === '[from] gem' ||
			from === '[from] move: Fling' || (!from && toID(item) !== 'airballoon'))) {
			this.updateIdentityMemory(identity, { consumedItem: toID(item) }, position);
		} else if (command === '-item' && ['[from] move: Recycle', '[from] move: G-Max Replenish'].includes(from)) {
			this.updateIdentityMemory(identity, { consumedItem: undefined }, position);
		}
		// Public loss during this entry can activate Unburden; being itemless on entry cannot.
		let effects = this.activeVolatiles.get(position);
		if (!effects) this.activeVolatiles.set(position, effects = new Set());
		if (command === '-enditem') effects.add('itemlost');
		else effects.delete('itemlost');

		const entry = this.entries.get(position);
		if (entry) {
			const acquired = command === '-item' && parts.some(p => p.startsWith('[from]'));
			const exchanged = command === '-enditem' && /move: (Trick|Switcheroo)|ability: (Pickpocket|Magician)/.test(from);
			const originalItem = entry.item?.originalItem || (!entry.item?.itemChanged && !acquired ? item : undefined);
			entry.item = { item: command === '-enditem' ? '' : item, itemLost: command === '-enditem',
				originalItem, itemChanged: entry.item?.itemChanged || acquired || exchanged };
		}

		if (!this.isOpponentSide(side)) return;

		const tracked = this.opponentPokemon.get(position);
		if (tracked) {
			tracked.volatiles = effects;
			const acquired = command === '-item' && parts.some(p => p.startsWith('[from]'));
			if (acquired) tracked.itemChanged = true;
			if (!tracked.originalItem && !tracked.itemChanged) tracked.originalItem = item;
			tracked.recyclableItem = this.getRecyclableItem(positionPart);
			tracked.itemKnockedOff = this.wasItemKnockedOff(positionPart);
			if (command === '-enditem' && /move: (Trick|Switcheroo)|ability: (Pickpocket|Magician)/.test(from)) {
				tracked.itemChanged = true;
			}
			if (command === '-enditem') {
				tracked.item = ''; // Item consumed/knocked off
				tracked.itemLost = true;  // Mark as confirmed lost
			} else {
				tracked.item = item;
				tracked.itemLost = false;  // Item revealed, not lost
			}

		}
	}

	/**
	 * Handle HP change
	 * Format: |-damage|p1a: Nickname|50/100
	 *         |-heal|p1a: Nickname|75/100
	 */
	private handleHPChange(parts: string[]): void {
		const positionPart = parts[1];
		if (!positionPart) return;

		const position = positionPart.split(':')[0].trim();
		const side = position.slice(0, 2);

		if (!this.isOpponentSide(side)) return;

		const hpPart = parts[2];
		if (!hpPart) return;

		const tracked = this.opponentPokemon.get(position);
		if (!tracked) return;

		const hpMatch = hpPart.match(/(\d+)\/(\d+)/);
		if (hpMatch) {
			tracked.hpPercent = (parseInt(hpMatch[1]) / parseInt(hpMatch[2])) * 100;
		} else if (hpPart === '0 fnt') {
			tracked.hpPercent = 0;
			tracked.active = false;
		}
	}

	/**
	 * Handle status
	 * Format: |-status|p1a: Nickname|par
	 */
	private handleStatus(parts: string[]): void {
		const positionPart = parts[1];
		if (!positionPart) return;

		const position = positionPart.split(':')[0].trim();
		const side = position.slice(0, 2);

		const ident = this.sleepIdentity(positionPart);
		let sleepSource: boolean | undefined;
		if (parts[2] === 'slp') {
			const explicit = parts.find(p => p.startsWith('[of] '))?.slice(5, 7);
			const source = parts.includes('[from] move: Rest') ? side :
				explicit || this.yawnSources.get(position) || this.lastMoveSource;
			if (source) sleepSource = this.isOurTeamSide(source) === this.isOurTeamSide(side);
			this.yawnSources.delete(position);
		}
		this.updateIdentityMemory(ident, { sleepSource,
			restSleep: parts[2] === 'slp' && parts.includes('[from] move: Rest') ? 0 : undefined }, position);

		if (!this.isOpponentSide(side)) return;

		const status = parts[2];
		if (!status) return;

		const tracked = this.opponentPokemon.get(position);
		if (tracked) {
			tracked.status = status;
			tracked.sleepSelfInflicted = this.getIdentityMemory(position).sleepSource;
		}
	}

	/**
	 * Handle cure status
	 * Format: |-curestatus|p1a: Nickname|par
	 */
	private handleCureStatus(parts: string[]): void {
		const positionPart = parts[1];
		if (!positionPart) return;

		const position = positionPart.split(':')[0].trim();
		const side = position.slice(0, 2);

		const cured = { restSleep: undefined, sleepSource: undefined };
		if (parts[0] === '-cureteam') {
			for (const ident of this.identityMemory.keys()) {
				if (ident.startsWith(`${side}:`)) Object.assign(this.identityMemory.get(ident)!, cured);
			}
			for (const [key, entry] of this.entries) {
				if (!key.startsWith(side)) continue;
				Object.assign(entry.memory, cured);
				Object.assign(entry.memoryUpdates, cured);
				if (entry.previous) entry.previous.status = '';
			}
			for (const pokemon of this.opponentTeam.values()) {
				if (pokemon.ident?.startsWith(`${side}:`)) pokemon.status = '';
			}
		} else {
			this.updateIdentityMemory(this.sleepIdentity(positionPart), cured, position);
		}

		if (!this.isOpponentSide(side)) return;

		const tracked = this.opponentPokemon.get(position);
		if (tracked) {
			tracked.status = '';
		}
	}

	/**
	 * Handle move usage (to track known moves and last move)
	 * Format: |move|p1a: Nickname|Earthquake|p2a: Target
	 *
	 * For opponent: tracks lastMove for Encore/Disable evaluation
	 * For our side: tracks lastMove for consecutive Protect penalty
	 *
	 * In CFRU:
	 * - gLastUsedMoves[bankDef] tracks opponent's last used move
	 * - gLastResultingMoves[bankAtk] tracks our last used move
	 */
	private handleMove(parts: string[]): void {
		const positionPart = parts[1];
		if (!positionPart) return;

		const position = positionPart.split(':')[0].trim();
		const side = position.slice(0, 2);
		this.lastMoveSource = side;
		const slot = position.slice(2); // 'a' or 'b'

		const move = parts[2];
		if (!move) return;

		const moveId = toID(move);
		if (moveId === 'naturalgift') {
			this.updateIdentityMemory(this.sleepIdentity(positionPart),
				{ naturalGift: { item: this.ourPokemon.get(position)?.pokemon.item } }, position);
			const tracked = this.opponentPokemon.get(position);
			if (tracked) tracked.recyclableItem = undefined;
		}

		// Track our team's lastMove (for AI decision making)
		// In multi battles, this handles both p2 and p4 moves
		if (this.isOurTeamSide(side)) {
			// Track lastMove (CFRU gLastResultingMoves[bankAtk])
			const boostKey = `${side}${slot}`;
			this.ourLastMove.set(boostKey, moveId);
		}

		// Track opponent's moves and lastMove (for Encore/Disable evaluation)
		if (this.isOpponentSide(side)) {
			const tracked = this.opponentPokemon.get(position);
			if (tracked) {
				// Record as last move used (for Encore/Disable evaluation)
				tracked.lastMove = move;
				if (tracked.transformation) {
					const moves = tracked.transformation.knownMoves;
					if (!Dex.moves.get(move).isZ && moveId !== 'struggle' &&
						!parts.some(p => p.startsWith('[from]')) && !moves.includes(moveId)) moves.push(moveId);
					return;
				}

				if (!Dex.moves.get(move).isZ && moveId !== 'struggle' && !parts.some(p => p.startsWith('[from]'))) {
					this.entries.get(position)?.moves.add(move);
					if (!tracked.knownMoves.includes(move)) tracked.knownMoves.push(move);
				}
			}
		}
	}

	/**
	 * Handle weather
	 * Format: |-weather|Sandstorm
	 */
	private handleWeather(parts: string[]): void {
		if (!parts[1]) return;
		this.fieldConditions.weather = normalizeWeather(parts[1]);
		this.fieldConditions.weatherId = parts[1] === 'none' ? '' : toID(parts[1]);
	}

	/**
	 * Handle field start/end
	 * Format: |-fieldstart|move: Trick Room
	 *         |-fieldend|move: Trick Room
	 */
	private handleField(parts: string[]): void {
		const command = parts[0];
		const field = parts[1];
		if (!field) return;

		const isStart = command === '-fieldstart';

		const id = toID(field.replace(/^move: /, ''));
		if (id === 'trickroom') {
			this.fieldConditions.trickRoom = isStart;
		} else if (id === 'gravity') {
			this.fieldConditions.gravity = isStart;
		} else if (id === 'magicroom') {
			this.fieldConditions.magicRoom = isStart;
		} else if (id === 'wonderroom') {
			this.fieldConditions.wonderRoom = isStart;
		} else if (id.endsWith('terrain')) {
			this.fieldConditions.terrain = isStart ? id.replace(/terrain$/, '') : '';
		}
	}

	/**
	 * Handle side condition start/end
	 * Format: |-sidestart|p1: PlayerName|move: Stealth Rock
	 *         |-sidestart|p1: PlayerName|Spikes
	 *         |-sideend|p1: PlayerName|Reflect
	 *
	 * IMPORTANT: PS protocol sometimes uses "move: Stealth Rock" format,
	 * so we need to strip the "move: " prefix before converting to ID.
	 */
	private handleSideCondition(parts: string[]): void {
		const command = parts[0];
		const sidePart = parts[1]; // "p1: PlayerName"
		if (!sidePart) return;

		const side = sidePart.split(':')[0].trim(); // "p1"
		let condition = parts[2];
		if (!condition) return;

		const isStart = command === '-sidestart';

		// Strip "move: " prefix if present (PS protocol quirk)
		// e.g., "move: Stealth Rock" -> "Stealth Rock"
		if (condition.startsWith('move: ')) {
			condition = condition.slice(6);
		}

		const conditionId = toID(condition);

		// Determine which side's conditions to update
		if (!this.isOpponentSide(side) && !this.isOurTeamSide(side)) return;
		const isOpponentSide = this.isOpponentSide(side);
		const conditions = isOpponentSide ? this.opponentSideConditions : this.ourSideConditions;

		// Entry hazards
		if (conditionId === 'stealthrock') {
			conditions.stealthrock = isStart;
		} else if (conditionId === 'spikes') {
			if (isStart) {
				conditions.spikes = Math.min(3, conditions.spikes + 1);
			} else {
				conditions.spikes = 0;
			}
		} else if (conditionId === 'toxicspikes') {
			if (isStart) {
				conditions.toxicspikes = Math.min(2, conditions.toxicspikes + 1);
			} else {
				conditions.toxicspikes = 0;
			}
		} else if (conditionId === 'stickyweb') {
			conditions.stickyweb = isStart;
		}
		// Screens
		else if (conditionId === 'reflect') {
			conditions.reflect = isStart ? 5 : 0; // Default 5 turns
		} else if (conditionId === 'lightscreen') {
			conditions.lightscreen = isStart ? 5 : 0;
		} else if (conditionId === 'auroraveil') {
			conditions.auroraveil = isStart ? 5 : 0;
		}
		// Tailwind
		else if (conditionId === 'mist') {
			conditions.mist = isStart ? 5 : 0;
		}
		else if (conditionId === 'safeguard') {
			conditions.safeguard = isStart ? 5 : 0;
		} else if (conditionId === 'tailwind') {
			conditions.tailwind = isStart ? 4 : 0; // Default 4 turns
		}
	}

	/**
	 * Handle volatile status start/end
	 * Format: |-start|p1a: Nickname|quarkdriveatk
	 *         |-start|p1a: Nickname|protosynthesisatk
	 *         |-end|p1a: Nickname|Quark Drive
	 *
	 * Tracks ability-based stat modifiers like Quark Drive and Protosynthesis.
	 * These provide 1.3x to non-speed stats, 1.5x to speed (5325/4096 ≈ 1.3).
	 */
	private handleVolatileStatus(parts: string[]): void {
		const command = parts[0];
		const positionPart = parts[1];
		if (!positionPart) return;

		const position = positionPart.split(':')[0].trim();
		// Record protocol facts for both teams, without adding any inferred effects.
		const effect = toID((parts[2] || '').replace(/^(?:move|ability): /, ''));
		if (command === '-end') this.transientEffects.get(position)?.delete(effect);
		if (effect === 'futuresight' || effect === 'doomdesire') {
			// Start names the user, while end names the occupant of the target position.
			if (command === '-end') this.setSlotEffect(position, 'futuremove', 0);
			else if (this.pendingFutureMove?.source === position && this.pendingFutureMove.target) {
				const dex = this.formatId ? Dex.forFormat(this.formatId) : Dex;
				const expiry = dex.gen >= 8 && this.turn >= 255 ? Infinity : this.turn + 3;
				this.setSlotEffect(this.pendingFutureMove.target, 'futuremove', expiry);
			}
			return;
		}
		if (effect === 'typechange' || effect === 'typeadd') {
			const current = this.activeTypes.get(position) || {};
			if (command === '-end') {
				if (effect === 'typechange') delete current.types;
				else delete current.added;
			} else if (effect === 'typeadd') {
				current.added = parts[3];
			} else {
				const copiedPosition = parts.find(p => p.startsWith('[of] '))?.slice(5).split(':')[0];
				const copied = copiedPosition &&
					(this.opponentPokemon.get(copiedPosition) || this.ourPokemon.get(copiedPosition)?.pokemon);
				const types = parts[3]?.startsWith('[') ?
					(copied ? this.getTypes(copiedPosition, copied.types) : undefined) : parts[3]?.split('/');
				if (types?.length) current.types = [...types];
				delete current.added;
			}
			this.activeTypes.set(position, current);
			return;
		}
		if (effect === 'yawn' && command === '-start') {
			const source = parts.find(p => p.startsWith('[of] '))?.slice(5, 7) || this.lastMoveSource;
			if (source) this.yawnSources.set(position, source);
		}
		let effects = this.activeVolatiles.get(position);
		if (!effects) this.activeVolatiles.set(position, effects = new Set());
		if (/^perish[0-3]$/.test(effect)) {
			for (const old of effects) if (/^perish[0-3]$/.test(old)) effects.delete(old);
		}
		if (command === '-end' && ['quarkdrive', 'protosynthesis'].includes(effect)) {
			for (const old of effects) if (old.startsWith(effect)) effects.delete(old);
		}
		if (effect) {
			if (command === '-start') effects.add(effect);
			else effects.delete(effect);
		}
		const tracked = this.opponentPokemon.get(position);
		if (tracked) tracked.volatiles = effects;

	}

	private clearTransientEffects(duration: 'turn' | 'move', position?: string): void {
		for (const [key, effects] of this.transientEffects) {
			if (position && position !== key) continue;
			for (const [effect, lifetime] of effects) {
				if (lifetime !== duration) continue;
				this.activeVolatiles.get(key)?.delete(effect);
				effects.delete(effect);
			}
			if (!effects.size) this.transientEffects.delete(key);
		}
	}

	/**
	 * Handle stat boost
	 * Format: |-boost|p1a: Nickname|atk|1
	 *         |-unboost|p1a: Nickname|def|2
	 *
	 * Tracks BOTH opponent and our side boosts for accurate AI decision making.
	 */
	private handleBoost(parts: string[]): void {
		const command = parts[0];
		const positionPart = parts[1];
		if (!positionPart) return;

		const position = positionPart.split(':')[0].trim();
		const side = position.slice(0, 2);
		const slot = position.slice(2); // 'a', 'b', etc.

		const stat = parts[2]?.toLowerCase() as keyof TrackedPokemon['boosts'];
		const amount = parseInt(parts[3]) || 1;
		if (!stat) return;

		// Valid stat names
		const validStats = ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'];
		if (!validStats.includes(stat)) return;

		// Track opponent boosts (original behavior)
		if (this.isOpponentSide(side)) {
			const tracked = this.opponentPokemon.get(position);
			if (tracked) {
				if (command === '-boost') {
					tracked.boosts[stat] = Math.min(6, tracked.boosts[stat] + amount);
				} else {
					// -unboost
					tracked.boosts[stat] = Math.max(-6, tracked.boosts[stat] - amount);
				}
			}
		}

		// CFRU AI Fix: Also track our team boosts for accurate setup move scoring
		// In multi battles, this tracks both p2 and p4 boosts
		if (this.isOurTeamSide(side)) {
			// Use side+slot as key to differentiate p2a from p4a
			const boostKey = `${side}${slot}`;
			console.log(`[DEBUG BattleTracker] handleBoost: ${command} for ${position}, side=${side}, boostKey=${boostKey}, stat=${stat}, amount=${amount}`);
			console.log(`[DEBUG BattleTracker] isOurTeamSide(${side})=true, ourTeamSides=${Array.from(this.ourTeamSides).join(',')}`);
			// Initialize boosts for this slot if not exists
			if (!this.ourActiveBoosts.has(boostKey)) {
				this.ourActiveBoosts.set(boostKey, defaultBoosts());
			}
			const boosts = this.ourActiveBoosts.get(boostKey)!;
			if (command === '-boost') {
				boosts[stat as keyof typeof boosts] = Math.min(6, boosts[stat as keyof typeof boosts] + amount);
			} else {
				// -unboost
				boosts[stat as keyof typeof boosts] = Math.max(-6, boosts[stat as keyof typeof boosts] - amount);
			}
			console.log(`[DEBUG BattleTracker] After update: ${boostKey} boosts.${stat}=${boosts[stat as keyof typeof boosts]}`);
		} else {
			console.log(`[DEBUG BattleTracker] handleBoost: ${command} for ${position}, side=${side} is NOT our team side`);
		}
	}

	/**
	 * Handle set boost (absolute value)
	 * Format: |-setboost|p1a: Nickname|atk|6
	 *
	 * Tracks BOTH opponent and our team boosts.
	 */
	private handleSetBoost(parts: string[]): void {
		const positionPart = parts[1];
		if (!positionPart) return;

		const position = positionPart.split(':')[0].trim();
		const side = position.slice(0, 2);
		const slot = position.slice(2);

		const stat = parts[2]?.toLowerCase() as keyof TrackedPokemon['boosts'];
		const amount = parseInt(parts[3]) || 0;
		if (!stat) return;

		const validStats = ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'];
		if (!validStats.includes(stat)) return;

		// Track opponent
		if (this.isOpponentSide(side)) {
			const tracked = this.opponentPokemon.get(position);
			if (tracked) {
				tracked.boosts[stat] = Math.max(-6, Math.min(6, amount));
			}
		}

		// Track our team (in multi battles: both p2 and p4)
		if (this.isOurTeamSide(side)) {
			const boostKey = `${side}${slot}`;
			if (!this.ourActiveBoosts.has(boostKey)) {
				this.ourActiveBoosts.set(boostKey, defaultBoosts());
			}
			const boosts = this.ourActiveBoosts.get(boostKey)!;
			boosts[stat as keyof typeof boosts] = Math.max(-6, Math.min(6, amount));
		}
	}

	/**
	 * Handle clear boost
	 * Format: |-clearboost|p1a: Nickname
	 *         |-clearallboost
	 *         |-clearpositiveboost|p1a: Nickname
	 *         |-clearnegativeboost|p1a: Nickname
	 *
	 * Tracks BOTH opponent and our team boosts.
	 */
	private handleClearBoost(parts: string[]): void {
		const command = parts[0];

		// -clearallboost clears all boosts for all Pokemon (both sides)
		if (command === '-clearallboost') {
			// Clear opponent boosts
			for (const [pos, mon] of this.opponentPokemon) {
				if (this.isOpponentSide(pos.slice(0, 2)) && mon.active) {
					mon.boosts = defaultBoosts();
				}
			}
			// Clear our team boosts
			for (const [, boosts] of this.ourActiveBoosts) {
				boosts.atk = 0;
				boosts.def = 0;
				boosts.spa = 0;
				boosts.spd = 0;
				boosts.spe = 0;
				boosts.accuracy = 0;
				boosts.evasion = 0;
			}
			return;
		}

		const positionPart = parts[1];
		if (!positionPart) return;

		const position = positionPart.split(':')[0].trim();
		const side = position.slice(0, 2);
		const slot = position.slice(2);

		// Helper to clear boosts based on command type
		const clearBoostsFor = (boostsObj: { atk: number, def: number, spa: number, spd: number, spe: number, accuracy: number, evasion: number }) => {
			if (command === '-clearboost') {
				boostsObj.atk = 0;
				boostsObj.def = 0;
				boostsObj.spa = 0;
				boostsObj.spd = 0;
				boostsObj.spe = 0;
				boostsObj.accuracy = 0;
				boostsObj.evasion = 0;
			} else if (command === '-clearpositiveboost') {
				for (const stat of ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'] as const) {
					if (boostsObj[stat] > 0) boostsObj[stat] = 0;
				}
			} else if (command === '-clearnegativeboost') {
				for (const stat of ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'] as const) {
					if (boostsObj[stat] < 0) boostsObj[stat] = 0;
				}
			}
		};

		// Handle opponent
		if (this.isOpponentSide(side)) {
			const tracked = this.opponentPokemon.get(position);
			if (tracked) {
				clearBoostsFor(tracked.boosts);
			}
		}

		// Handle our team (in multi battles: both p2 and p4)
		if (this.isOurTeamSide(side)) {
			const boostKey = `${side}${slot}`;
			const boosts = this.ourActiveBoosts.get(boostKey);
			if (boosts) {
				clearBoostsFor(boosts);
			}
		}
	}

	// ==========================================================================
	// Public API
	// ==========================================================================

	/**
	 * Get the currently active opponent Pokemon (for singles)
	 */
	getActiveOpponent(): TrackedPokemon | null {
		for (const [position, mon] of this.opponentPokemon) {
			if (mon.active && position.startsWith(this.opponentSide)) {
				return { ...mon, types: this.getTypes(position, mon.types) };
			}
		}
		return null;
	}

	/**
	 * Get all active opponent Pokemon (for doubles/multi)
	 * Returns array of [position, TrackedPokemon] sorted by position
	 */
	getActiveOpponents(): Array<{ position: string; pokemon: TrackedPokemon }> {
		const active: Array<{ position: string; pokemon: TrackedPokemon }> = [];
		for (const [position, mon] of this.opponentPokemon) {
			const side = position.slice(0, 2);
			if (mon.active && this.isOpponentSide(side)) {
				active.push({ position, pokemon: { ...mon, types: this.getTypes(position, mon.types) } });
			}
		}
		// Sort by position: p1a < p1b < p3a < p3b
		active.sort((a, b) => a.position.localeCompare(b.position));
		return active;
	}

	/**
	 * Get all known opponent team members
	 */
	getRemainingOpponents(): number | undefined {
		if ([...this.opponentSides].some(side => !this.teamSizes.has(side))) return undefined;
		const known = this.getOpponentTeam();
		const size = [...this.teamSizes].reduce((n, [side, count]) => n + (this.isOpponentSide(side) ? count : 0), 0);
		return size ? Math.max(0, size - known.filter(p => p.hpPercent <= 0).length) : undefined;
	}

	getOpponentTeam(): TrackedPokemon[] {
		return Array.from(this.opponentTeam.values());
	}

	/**
	 * Get opponent's last used move (for singles)
	 * Used by Encore/Disable evaluation in CFRU
	 *
	 * Returns empty string if no move has been used yet.
	 */
	getOpponentLastMove(): string {
		const opponent = this.getActiveOpponent();
		return opponent?.lastMove || '';
	}

	/**
	 * Get opponent's last used move info with details
	 * Returns move name and whether it's a status move
	 */
	getOpponentLastMoveInfo(): { move: string, isStatus: boolean } | null {
		const opponent = this.getActiveOpponent();
		if (!opponent || !opponent.lastMove) return null;

		const moveData = Dex.moves.get(opponent.lastMove);
		return {
			move: opponent.lastMove,
			isStatus: moveData.category === 'Status',
		};
	}

	/**
	 * Get field conditions
	 */
	getFieldConditions() {
		return { ...this.fieldConditions };
	}

	/**
	 * Get opponent side conditions (hazards, screens, etc.)
	 */
	getOpponentSideConditions() {
		return { ...this.opponentSideConditions };
	}

	/**
	 * Get our side conditions (hazards, screens, etc.)
	 */
	getOurSideConditions() {
		return { ...this.ourSideConditions };
	}

	/**
	 * Get our active Pokemon boosts (for singles, slot 'a')
	 * Returns boosts for the first active slot, or default zeros if not tracked yet.
	 *
	 * @param slot - Position slot ('a' for singles/doubles) or full position ('p2a' for multi)
	 *               In multi battles, use full position to distinguish p2a from p4a
	 */
	getOurActiveBoosts(slot: string = 'a'): {
		atk: number,
		def: number,
		spa: number,
		spd: number,
		spe: number,
		accuracy: number,
		evasion: number,
	} {
		// If slot is a full position (e.g., 'p2a', 'p4a'), use it directly
		// Otherwise, prepend ourSide for backward compatibility
		const boostKey = slot.length > 1 ? slot : `${this.ourSide}${slot}`;
		const boosts = this.ourActiveBoosts.get(boostKey);
		if (boosts) {
			return { ...boosts };
		}
		// Return default zeros if not tracked yet
		return defaultBoosts();
	}

	/**
	 * Get our active Pokemon ability stat modifier (Quark Drive, Protosynthesis)
	 * Returns the boosted stat and multiplier, or null if not active.
	 *
	 * These abilities provide:
	 * - 1.3x (~5325/4096) to the highest non-speed stat
	 * - 1.5x to speed if speed is highest
	 *
	 * @param slot - Position slot ('a' for singles/doubles) or full position ('p2a' for multi)
	 */
	getOurAbilityStatMod(slot = 'a'): AIPokemon['abilityStatMod'] {
		return abilityStatModifier(this.getVolatiles(slot));
	}

	getSelfInflictedSleep(ident: string): boolean | undefined {
		return this.getIdentityMemory(ident).sleepSource;
	}

	/**
	 * Get our Pokemon's last move used (CFRU gLastResultingMoves[bankAtk])
	 * Used for consecutive Protect detection
	 *
	 * @param slot - Position slot ('a' for singles/doubles) or full position ('p2a' for multi)
	 * @returns The move ID of last move used, or empty string if none
	 */
	getOurLastMove(slot: string = 'a'): string {
		// If slot is a full position (e.g., 'p2a', 'p4a'), use it directly
		// Otherwise, prepend ourSide for backward compatibility
		const moveKey = slot.length > 1 ? slot : `${this.ourSide}${slot}`;
		return this.ourLastMove.get(moveKey) || '';
	}

	/**
	 * Get which side we are ('p1' or 'p2')
	 */
	getOurSide(): 'p1' | 'p2' {
		return this.ourSide;
	}

	/** Protocol positions differ from party indices in Multi: p3b/p4b occupy field slot 2. */
	getPosition(side: string, activeIndex = 0): string {
		return `${side}${this.isMultiBattle ? (Number(side.slice(1)) > 2 ? 'b' : 'a') : String.fromCharCode(97 + activeIndex)}`;
	}

	getFieldSlot(position: string): number {
		return this.isMultiBattle ? (Number(position.slice(1, 2)) > 2 ? 2 : 1) : position.charCodeAt(2) - 96;
	}

	/**
	 * Get which side the opponent is ('p1' or 'p2')
	 */
	getOpponentSideId(): 'p1' | 'p2' {
		return this.opponentSide;
	}

	/**
	 * Check if our side has Tailwind active
	 */
	hasOurTailwind(): boolean {
		return this.ourSideConditions.tailwind > 0;
	}

	/**
	 * Check if opponent has Tailwind active
	 */
	hasOpponentTailwind(): boolean {
		return this.opponentSideConditions.tailwind > 0;
	}

	/**
	 * Check if a move type is immune due to opponent's ability
	 */
	isAbilityImmune(moveType: string): boolean {
		const opponent = this.getActiveOpponent();
		if (!opponent || !opponent.ability) return false;

		const abilityId = this.getEffectiveAbility(opponent.position);
		const typeId = toID(moveType);

		// Electric immunities
		if (typeId === 'electric') {
			if (['voltabsorb', 'lightningrod', 'motordrive'].includes(abilityId)) {
				return true;
			}
		}

		// Water immunities
		if (typeId === 'water') {
			if (['waterabsorb', 'stormdrain', 'dryskin'].includes(abilityId)) {
				return true;
			}
		}

		// Fire immunities
		if (typeId === 'fire') {
			if (['flashfire', 'wellbakedbody'].includes(abilityId)) {
				return true;
			}
		}

		// Grass immunity
		if (typeId === 'grass') {
			if (abilityId === 'sapsipper') {
				return true;
			}
		}

		// Ground immunities
		if (typeId === 'ground') {
			if (['levitate', 'eartheater'].includes(abilityId)) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Check if a move type is immune due to opponent's item
	 */
	isItemImmune(moveType: string): boolean {
		const opponent = this.getActiveOpponent();
		if (!opponent || !opponent.item) return false;

		const itemId = toID(opponent.item);
		const typeId = toID(moveType);

		// Air Balloon - Ground immunity
		if (typeId === 'ground' && itemId === 'airballoon') {
			return true;
		}

		return false;
	}

	/**
	 * Check if a move type is immune (type + ability + item)
	 */
	isImmune(moveType: string): boolean {
		const opponent = this.getActiveOpponent();
		if (!opponent) return false;

		// Check type immunity first
		const typeId = toID(moveType);

		// Ground type check - special handling for Flying type and Levitate
		if (typeId === 'ground') {
			// Flying type is immune
			if (opponent.types.includes('Flying')) {
				return true;
			}
			// Levitate ability
			if (this.isAbilityImmune(moveType)) {
				return true;
			}
			// Air Balloon
			if (this.isItemImmune(moveType)) {
				return true;
			}
		}

		// Normal type immunities
		if (typeId === 'normal' || typeId === 'fighting') {
			if (opponent.types.includes('Ghost')) {
				return true;
			}
		}

		if (typeId === 'ghost') {
			if (opponent.types.includes('Normal')) {
				return true;
			}
		}

		if (typeId === 'electric') {
			if (opponent.types.includes('Ground')) {
				return true;
			}
		}

		if (typeId === 'psychic') {
			if (opponent.types.includes('Dark')) {
				return true;
			}
		}

		if (typeId === 'dragon') {
			if (opponent.types.includes('Fairy')) {
				return true;
			}
		}

		if (typeId === 'poison') {
			if (opponent.types.includes('Steel')) {
				return true;
			}
		}

		// Check ability immunities
		if (this.isAbilityImmune(moveType)) {
			return true;
		}

		// Check item immunities
		if (this.isItemImmune(moveType)) {
			return true;
		}

		return false;
	}

	/**
	 * Get type effectiveness considering all immunities
	 */
	getEffectiveness(moveType: string): number {
		// Check full immunity first
		if (this.isImmune(moveType)) {
			return 0;
		}

		const opponent = this.getActiveOpponent();
		if (!opponent) return 1;

		// Calculate type effectiveness
		let multiplier = 1;
		for (const defType of opponent.types) {
			const effectiveness = Dex.getEffectiveness(moveType, defType);
			if (effectiveness === 1) {
				multiplier *= 2;
			} else if (effectiveness === -1) {
				multiplier *= 0.5;
			}
		}

		return multiplier;
	}

	hasActed(position: string): boolean {
		return this.acted.has(position.startsWith('p') ? position : `${this.ourSide}${position}`);
	}

	private setSlotEffect(position: string, effect: 'wish' | 'futuremove', expiry: number): void {
		const effects = this.slotEffects.get(position) || {};
		effects[effect] = expiry;
		this.slotEffects.set(position, effects);
	}

	private getSlotEffects(effect: 'wish' | 'futuremove', ours: boolean): Record<number, number> {
		const result: Record<number, number> = {};
		for (const [position, effects] of this.slotEffects) {
			if (effects[effect] === undefined) continue;
			const side = position.slice(0, 2);
			if (ours ? this.isOurTeamSide(side) : this.isOpponentSide(side)) {
				result[this.getFieldSlot(position)] = Math.max(0, (effects[effect] || 0) - this.turn);
			}
		}
		return result;
	}

	getWish(position = this.getPosition(this.ourSide)): number {
		return Math.max(0, (this.slotEffects.get(position)?.wish || 0) - this.turn);
	}

	getWishes(ours = true): Record<number, number> {
		return this.getSlotEffects('wish', ours);
	}

	getFutureMoves(ours = true): Record<number, number> {
		return this.getSlotEffects('futuremove', ours);
	}

	getTurn(): number {
		return this.turn;
	}

	setFormat(formatId: string): void {
		this.formatId = formatId;
	}

	private publicIdentity(pokemon: string): string {
		return `${pokemon.slice(0, 2)}:${pokemon.split(':').slice(1).join(':').trim()}`;
	}

	private sleepIdentity(pokemon: string): string {
		const position = pokemon.split(':')[0].trim();
		return this.ourPokemon.get(position)?.ident || this.publicIdentity(pokemon);
	}

	private getIdentityEntry(pokemon: string): EntryObservations | undefined {
		const position = pokemon.split(':')[0].trim();
		if (this.entries.has(position)) return this.entries.get(position);
		const ident = this.publicIdentity(pokemon);
		const entries = [...this.entries.values()].filter(entry => entry.ident === ident);
		// An active Illusion can share the nickname of its active teammate. Never mix their observations.
		return entries.length === 1 ? entries[0] : undefined;
	}

	/** Public attack damage counts hits; substitute-only hits, recoil and residuals do not. */
	private recordAttackHit(parts: string[]): void {
		const position = parts[1]?.split(':')[0].trim();
		const entry = this.entries.get(position);
		if (!entry) return;
		const future = parts.some(p => ['[from] move: Future Sight', '[from] move: Doom Desire'].includes(p));
		const direct = parts[0] === '-damage' && (future || !parts.some(p => p.startsWith('[from]')));
		let hits = 0;
		if (direct && (future || (this.currentAttack?.damaging && position !== this.currentAttack.source))) {
			hits = 1;
			if (!future && this.currentAttack) {
				this.currentAttack.hits.set(position, (this.currentAttack.hits.get(position) || 0) + 1);
			}
		} else if (parts[0] === '-hitcount') {
			// PS counts the full multihit sequence if it eventually damages the Pokemon behind a substitute.
			const directHits = this.currentAttack?.hits.get(position) || 0;
			if (directHits) hits = Math.max(0, Number(parts[2]) - directHits);
		}
		entry.receivedHits = (entry.receivedHits || 0) + hits;
		entry.memory.timesAttacked = (entry.memory.timesAttacked || 0) + hits;
	}

	getToxicCounter(pokemon: string): number {
		return this.getIdentityEntry(pokemon)?.toxicTicks || 0;
	}

	getTimesAttacked(pokemon: string): number {
		return this.getIdentityMemory(pokemon).timesAttacked || 0;
	}

	private getIdentityMemory(pokemon: string): IdentityMemory {
		return this.getIdentityEntry(pokemon)?.memory || this.identityMemory.get(this.publicIdentity(pokemon)) || {};
	}

	private updateIdentityMemory(ident: string, update: IdentityMemory, position?: string): void {
		const entry = this.getIdentityEntry(position || ident);
		if (entry) {
			Object.assign(entry.memory, update);
			Object.assign(entry.memoryUpdates, update);
		} else {
			this.identityMemory.set(ident, { ...this.identityMemory.get(ident), ...update });
		}
	}

	private memoryOnEntry(memory: IdentityMemory = {}, sleeping: boolean): IdentityMemory {
		const result = { ...memory };
		if (!sleeping) return { ...result, restSleep: undefined, sleepSource: undefined };
		const dex = this.formatId ? Dex.forFormat(this.formatId) : Dex;
		if (result.restSleep !== undefined && dex.gen === 5 && dex.currentMod !== 'mmo') result.restSleep = 0;
		if (dex.gen <= 3) result.restSleep = undefined;
		return result;
	}

	/** Rebase only this stay's evidence; history of the impersonated member stays with that member. */
	private rebindIdentity(position: string, ident: string): void {
		const entry = this.entries.get(position);
		if (!entry || entry.ident === ident) return;
		const memory = this.memoryOnEntry(this.identityMemory.get(ident), entry.sleeping);
		if (memory.restSleep !== undefined) memory.restSleep += entry.sleepChecks;
		entry.memory = { ...memory, ...entry.memoryUpdates,
			timesAttacked: (memory.timesAttacked || 0) + (entry.receivedHits || 0) };
		entry.ident = ident;
		this.activeIdentities.set(position, ident);
	}

	/** 1 means waking before the next move; 0 means no publicly known countdown. */
	getSleepTurns(position: string, ability = ''): number {
		const slept = this.getIdentityMemory(position.startsWith('p') ? position : `${this.ourSide}${position}`).restSleep;
		if (slept === undefined) return 0;
		const decrement = toID(ability) === 'earlybird' ? 2 : 1;
		const remaining = 3 - slept;
		return remaining <= decrement ? 1 : remaining;
	}

	getVolatiles(position: string): Set<string> {
		const key = position.startsWith('p') ? position : `${this.ourSide}${position}`;
		return new Set(this.activeVolatiles.get(key));
	}

	/** Effective public ability at an event's instant, before later requests or switches. */
	getEffectiveAbility(position: string): string {
		const facts = (key: string) => {
			const mon = this.opponentPokemon.get(key) || this.ourPokemon.get(key)?.pokemon;
			const volatiles = this.getVolatiles(key);
			if (this.transformations.has(key)) volatiles.add('transform');
			return { ability: this.activeAbilities.get(key) ?? mon?.ability ?? '',
				item: mon?.item || '', itemLost: false, volatiles };
		};
		const positions = [...this.activeIdentities.keys()].filter(key =>
			this.activeAbilities.has(key) || this.ourPokemon.has(key) || this.opponentPokemon.get(key)?.active);
		return effectiveAbility(facts(position), { formatId: this.formatId, magicroom: this.fieldConditions.magicRoom,
			neutralizingGas: hasNeutralizingGas(positions.map(facts)) });
	}

	/** Consumption is separate from removal and temporary effects; Gen 3–4 switches transfer it. */
	getRecyclableItem(ident: string): string | undefined {
		const memory = this.getIdentityMemory(ident);
		return memory?.naturalGift ? undefined : memory?.consumedItem || '';
	}

	wasItemKnockedOff(ident: string): boolean {
		return !!this.getIdentityMemory(ident).knockedOff;
	}

	/** Public type changes apply to either team and last until switching. */
	getTypes(position: string, fallback: readonly string[]): string[] {
		const current = this.activeTypes.get(position);
		const transformation = this.transformations.get(position);
		const copied = transformation?.target?.types || transformation?.pokemon?.types;
		return [...new Set([...(current?.types || copied || fallback), ...(current?.added ? [current.added] : [])])];
	}

	/** Reset tracker state for a new battle. */
	reset(): void {
		this.turn = 0;
		this.acted.clear();
		this.slotEffects.clear();
		this.pendingFutureMove = undefined;
		this.pendingWishPosition = '';
		this.teamSizes.clear();
		this.currentAttack = undefined;
		this.activeIdentities.clear();
		this.yawnSources.clear();
		this.identityMemory.clear();
		this.entries.clear();
		this.skipPrivateLine = false;
		this.lastMoveSource = '';
		this.transformations.clear();
		this.ourPokemon.clear();
		this.activeAbilities.clear();
		this.activeVolatiles.clear();
		this.transientEffects.clear();
		this.activeTypes.clear();
		this.opponentPokemon.clear();
		this.opponentTeam.clear();
		this.ourActiveBoosts.clear();
		this.ourLastMove.clear();
		this.fieldConditions = {
			weather: '', weatherId: '', terrain: '', trickRoom: false, gravity: false, magicRoom: false, wonderRoom: false,
		};
		this.opponentSideConditions = {
			stealthrock: false,
			spikes: 0,
			toxicspikes: 0,
			stickyweb: false,
			reflect: 0,
			lightscreen: 0,
			auroraveil: 0,
			tailwind: 0, safeguard: 0, mist: 0,
		};
		this.ourSideConditions = {
			stealthrock: false,
			spikes: 0,
			toxicspikes: 0,
			stickyweb: false,
			reflect: 0,
			lightscreen: 0,
			auroraveil: 0,
			tailwind: 0, safeguard: 0, mist: 0,
		};
	}
}

/**
 * Create a new BattleTracker instance
 * @param ourSide - Which side we are ('p1' or 'p2')
 * @param isMulti - Whether this is a multi battle (tracks p1 & p3 or p2 & p4 as opponents)
 */
export function createBattleTracker(ourSide: 'p1' | 'p2' = 'p2', isMulti = false): BattleTracker {
	return new BattleTracker(ourSide, isMulti);
}
