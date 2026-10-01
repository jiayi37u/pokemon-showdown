/**
 * CFRU AI - Cache System
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Caching system for AI calculations to improve performance.
 *
 * @license MIT
 */

import type { AICache, DamageResult, KnockoutResult } from '../types';

/** Maximum cache size to prevent memory issues */
const MAX_CACHE_SIZE = 1000;

/**
 * Create a new AI cache for a battle turn
 */
export function createCache(turn: number): AICache {
	return {
		damageCalc: new Map(),
		typeEffectiveness: new Map(),
		speedComparison: new Map(),
		knockoutCalc: new Map(),
		turn,
	};
}

/**
 * Check if cache is stale (from a previous turn)
 */
export function isCacheStale(cache: AICache, currentTurn: number): boolean {
	return cache.turn !== currentTurn;
}

/**
 * Clear the cache
 */
export function clearCache(cache: AICache): void {
	cache.damageCalc.clear();
	cache.typeEffectiveness.clear();
	cache.speedComparison.clear();
	cache.knockoutCalc.clear();
}

/**
 * Update cache turn and optionally clear if stale
 */
export function updateCacheTurn(cache: AICache, newTurn: number): AICache {
	if (cache.turn !== newTurn) {
		// Clear cache for new turn
		clearCache(cache);
		cache.turn = newTurn;
	}
	return cache;
}

/**
 * Trim cache if it's too large
 */
export function trimCacheIfNeeded(cache: AICache): void {
	// Trim each map if over size
	if (cache.damageCalc.size > MAX_CACHE_SIZE) {
		const entries = Array.from(cache.damageCalc.entries());
		cache.damageCalc = new Map(entries.slice(-MAX_CACHE_SIZE / 2));
	}

	if (cache.typeEffectiveness.size > MAX_CACHE_SIZE) {
		const entries = Array.from(cache.typeEffectiveness.entries());
		cache.typeEffectiveness = new Map(entries.slice(-MAX_CACHE_SIZE / 2));
	}

	if (cache.speedComparison.size > MAX_CACHE_SIZE) {
		const entries = Array.from(cache.speedComparison.entries());
		cache.speedComparison = new Map(entries.slice(-MAX_CACHE_SIZE / 2));
	}

	if (cache.knockoutCalc.size > MAX_CACHE_SIZE) {
		const entries = Array.from(cache.knockoutCalc.entries());
		cache.knockoutCalc = new Map(entries.slice(-MAX_CACHE_SIZE / 2));
	}
}

/**
 * Get cache statistics for debugging
 */
export function getCacheStats(cache: AICache): {
	turn: number;
	damageCalcSize: number;
	typeEffectivenessSize: number;
	speedComparisonSize: number;
	knockoutCalcSize: number;
	totalSize: number;
} {
	const damageCalcSize = cache.damageCalc.size;
	const typeEffectivenessSize = cache.typeEffectiveness.size;
	const speedComparisonSize = cache.speedComparison.size;
	const knockoutCalcSize = cache.knockoutCalc.size;

	return {
		turn: cache.turn,
		damageCalcSize,
		typeEffectivenessSize,
		speedComparisonSize,
		knockoutCalcSize,
		totalSize: damageCalcSize + typeEffectivenessSize + speedComparisonSize + knockoutCalcSize,
	};
}
