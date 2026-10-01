/**
 * CFRU AI - Module Entry Point
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Main entry point for the CFRU AI system.
 * Exports all types, utilities, and engines.
 *
 * @license MIT
 */

// Export all types
export * from './types';

// Export utility functions
export * from './util';

// Export scoring engine
export { ScoringEngine, createScoringEngine, createBasicScoringEngine } from './scoring';
export type { ScoringContext, NegativeScoringFunction, PositiveScoringFunction } from './scoring';
export { allNegativeScorers, allPositiveScorers } from './scoring';

// Export state builder
export { buildBattleState, buildMovesFromRequest } from './state-builder';

// Note: The following modules will be added in later milestones:
// - Switching (M5): Switch decision system
// - Advanced (M6-M7): Fighting style, prediction
// - Doubles (M9): Partner AI
