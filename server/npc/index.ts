/**
 * NPC Module Entry Point
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Exports all NPC-related functionality.
 *
 * @license MIT
 */

export { NPC, NPCManager } from './manager';
export type { NPCTemplate, NPCTeamConfig, NPCTeamFile } from './manager';
export { NPCBattleAI } from './ai/index';
export type { AIConfig, MoveChoice, SwitchChoice } from './ai/index';
export { BasicAI } from './ai/basic';
export { createNPCBattle, getAvailableFormats, isFormatSupported } from './room';
export type { NPCBattleCreateOptions, NPCBattleResult } from './room';

/**
 * Initialize NPC module
 * Called during server startup
 */
export function initNPC(): void {
	const { NPC: NPCInstance } = require('./manager');
	NPCInstance.loadTemplates();
	console.log('[NPC] Module initialized');
}
