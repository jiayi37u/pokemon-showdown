/**
 * CFRU AI - Type Definitions
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Core type definitions for the CFRU AI system.
 * Based on Complete-Fire-Red-Upgrade AI architecture.
 *
 * @license MIT
 */

// =============================================================================
// AI Configuration
// =============================================================================

/** AI configuration options for CFRU-based AI */
export interface CFRUAIConfig {
	/** Whether to use full opponent info (default: false - only revealed info) */
	useFullInfo: boolean;

	/** Whether to use move prediction (default: true for Hard+) */
	usePrediction: boolean;

	/** Whether to use fighting style classification */
	useFightingStyle: boolean;

	/** Whether this is a doubles battle */
	isDoubles: boolean;

	/** Battle format ID for level calculation (e.g., 'gen9nationaldex') */
	formatId: string;
}

/** Default AI config */
export const DEFAULT_AI_CONFIG: CFRUAIConfig = {
	useFullInfo: false,
	usePrediction: false,
	useFightingStyle: false,
	isDoubles: false,
	formatId: '',
};

// =============================================================================
// Battle State
// =============================================================================

/** Simplified Pokemon data for AI evaluation */
export interface AIPokemon {
	/** Slot position (1-indexed) */
	slot: number;

	/** Species name */
	species: string;

	/** Current HP (0-100 for opponent, exact for self) */
	hp: number;

	/** Max HP (for self only, 0 if unknown) */
	maxHp: number;

	/** HP percentage (0-100) */
	hpPercent: number;

	/** Status condition: 'brn' | 'par' | 'slp' | 'frz' | 'psn' | 'tox' | '' */
	status: string;

	/** Remaining sleep turns (if applicable) */
	sleepTurns: number;

	/** Toxic counter (if applicable) */
	toxicCounter: number;

	/** Types */
	types: string[];

	/** Ability (empty string if unknown) */
	ability: string;

	/** Item (empty string if unknown) */
	item: string;

	/**
	 * Whether we know for sure the item was lost (consumed/knocked off)
	 * true = confirmed no item (saw -enditem message)
	 * false = item unknown or item is known to exist
	 */
	itemLost: boolean;

	/** Known moves (only revealed moves for opponent) */
	moves: string[];

	/**
	 * Last move used (for Encore/Disable evaluation)
	 * In CFRU, this is gLastUsedMoves[bank]
	 * Empty string if no move has been used yet
	 */
	lastMove: string;

	/** Base stats */
	baseStats: {
		hp: number;
		atk: number;
		def: number;
		spa: number;
		spd: number;
		spe: number;
	};

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

	/**
	 * Ability-based stat modifier (Quark Drive, Protosynthesis, etc.)
	 * These are multipliers that apply on top of boosts.
	 * - stat: the stat being boosted, or null if none
	 * - multiplier: the multiplier (1.3 for non-speed, 1.5 for speed)
	 */
	abilityStatMod: {
		stat: 'atk' | 'def' | 'spa' | 'spd' | 'spe' | null;
		multiplier: number;
	};

	/** Volatile status conditions */
	volatiles: Set<string>;

	/** Whether this Pokemon is fainted */
	fainted: boolean;

	/** Whether this Pokemon is active */
	active: boolean;

	/** Level */
	level: number;

	/** Gender: 'M' | 'F' | 'N' (none) */
	gender: string;
}

/** Side conditions (entry hazards, screens, etc.) */
export interface SideConditions {
	/** Stealth Rock */
	stealthrock: boolean;

	/** Spikes layers (0-3) */
	spikes: number;

	/** Toxic Spikes layers (0-2) */
	toxicspikes: number;

	/** Sticky Web */
	stickyweb: boolean;

	/** Light Screen (remaining turns) */
	lightscreen: number;

	/** Reflect (remaining turns) */
	reflect: number;

	/** Aurora Veil (remaining turns) */
	auroraveil: number;

	/** Tailwind (remaining turns) */
	tailwind: number;

	/** Wish (remaining turns, 0 = no wish) */
	wish: number;

	/** Future Sight / Doom Desire (remaining turns) */
	futuremove: number;
}

/** Field conditions */
export interface FieldConditions {
	/** Current weather: 'sun' | 'rain' | 'sand' | 'hail' | 'snow' | '' */
	weather: string;

	/** Weather remaining turns (0 = permanent, -1 = none) */
	weatherTurns: number;

	/** Current terrain: 'electric' | 'grassy' | 'misty' | 'psychic' | '' */
	terrain: string;

	/** Terrain remaining turns */
	terrainTurns: number;

	/** Trick Room active */
	trickroom: boolean;

	/** Trick Room remaining turns */
	trickroomTurns: number;

	/** Gravity active */
	gravity: boolean;

	/** Magic Room active */
	magicroom: boolean;

	/** Wonder Room active */
	wonderroom: boolean;
}

/** Complete battle state for AI evaluation */
export interface BattleState {
	/** Current turn number */
	turn: number;

	/** Whether this is a doubles battle */
	isDoubles: boolean;

	/** AI's side (self) */
	self: {
		/** Active Pokemon (1 for singles, 2 for doubles) */
		active: AIPokemon[];
		/** Reserve Pokemon */
		reserve: AIPokemon[];
		/** All Pokemon (active + reserve) */
		team: AIPokemon[];
		/** Side conditions */
		conditions: SideConditions;
	};

	/** Opponent's side */
	opponent: {
		/** Active Pokemon */
		active: AIPokemon[];
		/** Reserve Pokemon (only team preview info if not useFullInfo) */
		reserve: AIPokemon[];
		/** All Pokemon */
		team: AIPokemon[];
		/** Side conditions */
		conditions: SideConditions;
	};

	/** Field conditions */
	field: FieldConditions;
}

// =============================================================================
// Move Data
// =============================================================================

/** Move data for AI evaluation */
export interface AIMove {
	/** Move ID */
	id: string;

	/** Move name */
	name: string;

	/** Move slot (1-4) */
	slot: number;

	/** Move type */
	type: string;

	/** Move category: 'Physical' | 'Special' | 'Status' */
	category: 'Physical' | 'Special' | 'Status';

	/** Base power (0 for status moves) */
	basePower: number;

	/** Accuracy (0 = never misses) */
	accuracy: number | true;

	/** Current PP */
	pp: number;

	/** Max PP */
	maxPp: number;

	/** Priority */
	priority: number;

	/** Target type */
	target: string;

	/** Move flags from Dex */
	flags: { [k: string]: number };

	/** Secondary effect chance (0-100) */
	secondaryChance: number;

	/** Whether the move is disabled */
	disabled: boolean;

	/** Whether this is a Z-move */
	isZMove: boolean;

	/** Whether this is a Max move */
	isMaxMove: boolean;

	/** Multi-hit move info: number for fixed hits, [min, max] for range, null for single hit */
	multihit: number | [number, number] | null;
}

// =============================================================================
// Scoring System
// =============================================================================

/** Base score constant */
export const BASE_SCORE = 100;

/**
 * AIPokemon.boosts 的默认值（所有阶段为 0）。
 * 用于：Pokemon 构建、换人时清空 boosts、tracker 初始化。
 * 一律返回新对象，调用方可以放心 mutate。
 */
export function defaultBoosts(): AIPokemon['boosts'] {
	return { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
}

/** Score breakdown for debugging/logging */
export interface ScoreBreakdown {
	/** Initial score (always 100) */
	base: number;

	/** Total negative adjustments */
	negatives: number;

	/** Total positive adjustments */
	positives: number;

	/** Fighting style adjustments */
	styleAdjust: number;

	/** Final score */
	final: number;

	/** Detailed adjustments for debugging */
	details: ScoreAdjustment[];
}

/** Individual score adjustment */
export interface ScoreAdjustment {
	/** Reason for adjustment */
	reason: string;

	/** Amount adjusted */
	amount: number;

	/** Category: 'negative' | 'positive' | 'style' */
	category: 'negative' | 'positive' | 'style';
}

/** Move score result */
export interface MoveScore {
	/** Move being scored */
	move: AIMove;

	/** Final score */
	score: number;

	/** Score breakdown */
	breakdown: ScoreBreakdown;

	/** Quick flags for decision making */
	flags: MoveScoreFlags;

	/** Target for doubles (null for singles) */
	target: AIPokemon | null;
}

/** Flags computed during scoring */
export interface MoveScoreFlags {
	/** Can knock out the target */
	canKO: boolean;

	/** Can 2HKO the target */
	can2HKO: boolean;

	/** AI Pokemon outspeeds target */
	goesFirst: boolean;

	/** This is the strongest damage move */
	isStrongestMove: boolean;

	/** Move is immune (effectiveness = 0) */
	isImmune: boolean;

	/** Move is super effective */
	isSuperEffective: boolean;

	/** Move has no effect (other than immunity) */
	hasNoEffect: boolean;
}

// =============================================================================
// Switching System
// =============================================================================

/** Switch condition flags (from CFRU ai_switching.h) */
export const SwitchingFlag = {
	NONE: 0,
	PERISH_SONG: 1 << 0,
	WONDER_GUARD: 1 << 1,
	ONLY_BAD_MOVES: 1 << 2,
	ABSORB_ABILITY: 1 << 3,
	NATURAL_CURE: 1 << 4,
	REGENERATOR: 1 << 5,
	YAWNED: 1 << 6,
	AVOID_DEATH: 1 << 7,
	PURSUIT_SAFE: 1 << 8,
	FREE_SWITCH: 1 << 9,
	SLOW_PIVOT: 1 << 10,
} as const;

/** Switch evaluation result */
export interface SwitchScore {
	/** Pokemon slot to switch to (1-indexed) */
	slot: number;

	/** Pokemon being evaluated */
	pokemon: AIPokemon;

	/** Switch score */
	score: number;

	/** Flags indicating why this switch is good/bad */
	flags: number;

	/** Score breakdown */
	breakdown: {
		canKO: number;
		outspeeds: number;
		resistsAll: number;
		wallsFoe: number;
		faintsFromFoe: number;
		other: number;
	};
}

/** Switch decision result */
export interface SwitchDecision {
	/** Whether AI should switch */
	shouldSwitch: boolean;

	/** Reason for switching (or not) */
	reason: string;

	/** Flags that triggered the switch decision */
	flags: number;

	/** Best switch target (null if shouldn't switch) */
	bestSwitch: SwitchScore | null;
}

// =============================================================================
// Fighting Styles
// =============================================================================

/** Fighting style classifications (from CFRU ai_advanced.c) */
export enum FightingStyle {
	// Singles styles
	NONE = 0,
	SWEEPER_KILL = 1,        // Offensive sweeper - wants to KO
	SWEEPER_SETUP = 2,       // Setup sweeper - wants to boost first
	STALL = 3,               // Defensive stall
	TEAM_SUPPORT = 4,        // Support role (hazards, screens)
	PHAZING = 5,             // Shuffling / phazing
	REVENGE_KILLER = 6,      // Revenge killing
	PIVOT = 7,               // U-turn / Volt Switch user
	TRAPPER = 8,             // Trapping opponent
	WALL_BREAKER = 9,        // Breaking walls
	LEAD = 10,               // Lead / suicide lead

	// Doubles styles (start from 100)
	DOUBLES_SPREAD = 100,        // Spread damage
	DOUBLES_SUPPORT = 101,       // Doubles support (Helping Hand, etc.)
	DOUBLES_TRICK_ROOM = 102,    // Trick Room setter/abuser
	DOUBLES_TAILWIND = 103,      // Tailwind user
	DOUBLES_REDIRECTION = 104,   // Follow Me / Rage Powder
	DOUBLES_PROTECT = 105,       // Protect-heavy
	DOUBLES_WEATHER = 106,       // Weather setter
	DOUBLES_TERRAIN = 107,       // Terrain setter
}

/** Fighting style analysis result */
export interface FightingStyleResult {
	/** Primary fighting style */
	primary: FightingStyle;

	/** Secondary style (if applicable) */
	secondary: FightingStyle | null;

	/** Confidence score (0-100) */
	confidence: number;

	/** Style-specific modifiers */
	modifiers: {
		setupPriority: number;    // How much to prioritize setup
		stayInMultiplier: number; // Multiplier for staying in
		switchPriority: number;   // How much to prioritize switching
	};
}

// =============================================================================
// Damage Calculation
// =============================================================================

/** Damage calculation result */
export interface DamageResult {
	/** Minimum damage roll */
	min: number;

	/** Maximum damage roll */
	max: number;

	/** Average damage */
	average: number;

	/** Minimum damage as HP percentage */
	minPercent: number;

	/** Maximum damage as HP percentage */
	maxPercent: number;

	/** Average damage as HP percentage */
	averagePercent: number;

	/** Type effectiveness multiplier */
	effectiveness: number;

	/** Whether this KOs (max roll) */
	canKO: boolean;

	/** Whether this always KOs (min roll) */
	guaranteedKO: boolean;

	/** Number of hits to KO (using average) */
	hitsToKO: number;
}

/** Knockout analysis result */
export interface KnockoutResult {
	/** Can KO in 1 hit */
	canKO: boolean;

	/** Can 2HKO */
	can2HKO: boolean;

	/** Can 3HKO */
	can3HKO: boolean;

	/** Guaranteed KO (min roll) */
	guaranteedKO: boolean;

	/** Hits needed to KO */
	hitsToKO: number;

	/** Whether opponent outspeeds */
	opponentGoesFirst: boolean;

	/** Can be revenge killed */
	canBeRevenged: boolean;
}

// =============================================================================
// Prediction System
// =============================================================================

/** Predicted opponent action */
export interface PredictedAction {
	/** Predicted action type */
	type: 'move' | 'switch';

	/** Predicted move (if type is 'move') */
	move: string | null;

	/** Predicted switch target slot (if type is 'switch') */
	switchTo: number | null;

	/** Confidence (0-100) */
	confidence: number;

	/** Reasoning */
	reasons: string[];
}

// =============================================================================
// AI Decision
// =============================================================================

/** Final AI decision for a turn */
export interface AIDecision {
	/** Decision type */
	type: 'move' | 'switch';

	/** Move slot (1-4) if type is 'move' */
	moveSlot: number | null;

	/** Switch target slot if type is 'switch' */
	switchSlot: number | null;

	/** Target position for doubles */
	targetPos: string | null;

	/** Whether to use Z-move */
	zMove: boolean;

	/** Whether to Mega Evolve */
	mega: boolean;

	/** Whether to Dynamax */
	dynamax: boolean;

	/** Whether to Terastallize */
	terastallize: boolean;

	/** Score of the chosen action */
	score: number;

	/** Reasoning for the decision */
	reasoning: string[];
}

// =============================================================================
// Cache System
// =============================================================================

/** AI calculation cache (per battle) */
export interface AICache {
	/** Cached damage calculations: attacker-defender-move -> DamageResult */
	damageCalc: Map<string, DamageResult>;

	/** Cached type effectiveness: moveType-defenderTypes -> number */
	typeEffectiveness: Map<string, number>;

	/** Cached speed comparisons: mon1-mon2 -> boolean (mon1 is faster) */
	speedComparison: Map<string, boolean>;

	/** Cached knockout calculations */
	knockoutCalc: Map<string, KnockoutResult>;

	/** Turn this cache was created (invalidate on new turn) */
	turn: number;
}

/** Create a fresh AI cache */
export function createAICache(turn: number): AICache {
	return {
		damageCalc: new Map(),
		typeEffectiveness: new Map(),
		speedComparison: new Map(),
		knockoutCalc: new Map(),
		turn,
	};
}

// =============================================================================
// Format Level Utilities
// =============================================================================

/**
 * Get the default Pokemon level for a battle format.
 *
 * This function returns the standard level for each format type:
 * - Random Battles: 0 (use parsed/tracked level from protocol)
 * - National Dex / OU / UU / Uber / Monotype: 100
 * - VGC / BSS / Battle Stadium / Doubles: 50
 * - Little Cup: 5
 *
 * Using consistent levels for both attacker and defender ensures accurate
 * damage percentage calculations, even when the actual level differs.
 *
 * @param formatId - The format ID (e.g., 'gen9nationaldex', 'gen9vgc2024')
 * @returns The default level for that format (0 means use parsed level)
 */
export function getFormatLevel(formatId: string): number {
	if (!formatId) return 100; // Default to 100 if no format specified

	const id = formatId.toLowerCase();

	// Random Battles: use parsed/tracked level (return 0 as signal)
	if (id.includes('random')) {
		return 0;
	}

	// Level 5 formats
	if (id.includes('lc') || id.includes('littlecup')) {
		return 5;
	}

	// Level 50 formats (VGC, BSS, Battle Stadium)
	if (id.includes('vgc') ||
		id.includes('bss') ||
		id.includes('battlestadium') ||
		id.includes('battlespot')) {
		return 50;
	}

	// Level 100 formats (everything else: OU, UU, National Dex, etc.)
	return 100;
}

/**
 * Resolve the actual level to use for damage calculation.
 *
 * Strategy:
 * - Random battles: use parsed level (levels vary per Pokemon)
 * - Other formats: use format default level (consistent for both sides)
 *
 * Using format default ensures attacker and defender use the same level,
 * which gives accurate damage percentages even if the actual level differs.
 *
 * @param formatId - The format ID
 * @param parsedLevel - Level parsed from protocol (optional)
 * @returns The level to use for calculations
 */
export function resolveLevel(formatId: string, parsedLevel?: number): number {
	const formatLevel = getFormatLevel(formatId);

	// For random battles (formatLevel = 0), use parsed level
	if (formatLevel === 0) {
		return (parsedLevel && parsedLevel > 0) ? parsedLevel : 100;
	}

	// For all other formats, always use format default level
	// This ensures attacker and defender use the same level
	return formatLevel;
}
