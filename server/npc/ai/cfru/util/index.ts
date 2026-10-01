/**
 * CFRU AI - Utility Functions Index
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Exports all utility functions for the CFRU AI system.
 *
 * @license MIT
 */

// Type calculation utilities
export {
	TYPE_EFFECTIVENESS,
	getTypeEffectiveness,
	hasSTAB,
	getSTABMultiplier,
	getAbilityTypeImmunity,
	wonderGuardBlocks,
	getResistances,
	getWeaknesses,
	getImmunities,
	resistsAllMoves,
	hasSuperEffectiveMove,
} from './type-calc';

// Damage calculation utilities
export {
	getEffectiveStat,
	getAttackStat,
	getDefenseStat,
	getModifiedBasePower,
	getExpectedHitCount,
	calculateDamage,
	canKnockOut,
	can2HKO,
	hitsToKnockOut,
	findStrongestMove,
} from './damage-calc';

// Speed calculation utilities
export {
	getEffectiveSpeed,
	isFaster,
	goesFirst,
	canPriorityKO,
	getPriorityMoves,
	isSlow,
	getSpeedTier,
} from './speed';

// Knockout calculation utilities
export {
	analyzeKnockout,
	willFaintFromAttack,
	canKOBeforeBeingKOd,
	calculateSurvivalTurns,
	canRevengeKill,
	isInKORange,
	getBestKOMove,
	shouldSwitchToAvoidDeath,
} from './knockout';

// Cache utilities
export {
	createCache,
	isCacheStale,
	clearCache,
	updateCacheTurn,
	trimCacheIfNeeded,
	getCacheStats,
} from './cache';

// Battle state tracker
export {
	BattleTracker,
	createBattleTracker,
	type TrackedPokemon,
} from './battle-tracker';
