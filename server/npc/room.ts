/**
 * NPC Battle Room
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Handles NPC battle room creation and management.
 *
 * @license MIT
 */

import { NPC, NPCTemplate, MultiTeam } from './manager';
import { BasicAI } from './ai/basic';
import { NormalAI, NormalAIOptions } from './ai/normal';
import { NPCMultiManager, NPCMultiManagerOptions } from './ai/multi-manager';
import { LogLevel } from './ai/cfru/logger';
import { Teams } from '../../sim/teams';
import { TeamValidator } from '../../sim/team-validator';
import type { PokemonSet } from '../../sim/teams';

/** NPC Battle creation options */
export interface NPCBattleCreateOptions {
	/** User initiating the battle */
	user: User;

	/** NPC template ID */
	npcId: string;

	/** Battle format */
	format: string;

	/** User's team (packed string or PokemonSet[]) */
	team?: string | PokemonSet[];

	/** Override AI difficulty (optional, defaults to NPC's difficulty) */
	difficulty?: string;
}

/** NPC Battle result */
export interface NPCBattleResult {
	success: boolean;
	error?: string;
	room?: GameRoom;
}

/**
 * Create an NPC battle
 */
export async function createNPCBattle(options: NPCBattleCreateOptions): Promise<NPCBattleResult> {
	const { user, npcId, format, difficulty } = options;

	console.log(`[NPC] createNPCBattle: user=${user.id}, npcId=${npcId}, format=${format}, difficulty=${difficulty}`);

	// Get NPC template
	const npc = NPC.get(npcId);
	if (!npc) {
		console.error(`[NPC] createNPCBattle: NPC not found: ${npcId}`);
		return { success: false, error: `NPC not found: ${npcId}` };
	}

	console.log(`[NPC] createNPCBattle: Found NPC: ${npc.name}`);

	// Check format support
	if (!NPC.supportsFormat(npcId, format)) {
		console.error(`[NPC] createNPCBattle: Format not supported: ${format}`);
		const supportedFormats = NPC.getSupportedFormats(npcId);
		console.log(`[NPC] createNPCBattle: Supported formats for ${npc.name}: ${supportedFormats.join(', ')}`);
		return { success: false, error: `${npc.name} does not support format: ${format}` };
	}

	console.log(`[NPC] createNPCBattle: Format ${format} is supported`);

	// Get or generate NPC team
	let npcTeam: PokemonSet[] | null;

	if (format.includes('randombattle')) {
		// Random battle - generate team
		console.log(`[NPC] createNPCBattle: Generating random battle team`);
		npcTeam = Teams.generate(format);
	} else {
		// Fixed team
		console.log(`[NPC] createNPCBattle: Loading fixed team for format ${format}`);
		npcTeam = NPC.getTeam(npcId, format);
	}

	if (!npcTeam || npcTeam.length === 0) {
		console.error(`[NPC] createNPCBattle: Failed to load team, npcTeam=${npcTeam ? 'empty array' : 'null'}`);
		return { success: false, error: `Failed to load NPC team for ${npc.name}` };
	}

	console.log(`[NPC] createNPCBattle: Loaded team with ${npcTeam.length} Pokemon`);

	// Get user team
	let userTeam: string;

	if (options.team) {
		if (typeof options.team === 'string') {
			userTeam = options.team;
		} else {
			userTeam = Teams.pack(options.team);
		}
	} else if (format.includes('randombattle')) {
		// Random battle - generate team for user
		userTeam = Teams.pack(Teams.generate(format));
	} else {
		return { success: false, error: 'No team provided' };
	}

	// Validate user team (skip for random battles)
	if (!format.includes('randombattle')) {
		const validator = TeamValidator.get(format);
		const problems = validator.validateTeam(Teams.unpack(userTeam));
		if (problems) {
			return { success: false, error: `Team validation failed: ${problems.join(', ')}` };
		}
	}

	// Pack NPC team
	const npcTeamPacked = Teams.pack(npcTeam);

	// Create battle room
	try {
		const room = createBattleRoom(user, npc, format, userTeam, npcTeamPacked, difficulty);
		if (!room) {
			return { success: false, error: 'Failed to create battle room' };
		}

		return { success: true, room };
	} catch (err) {
		console.error('[NPC] Failed to create battle:', err);
		return { success: false, error: 'Internal error creating battle' };
	}
}

/**
 * Create the battle room
 */
function createBattleRoom(
	user: User,
	npc: NPCTemplate,
	format: string,
	userTeam: string,
	npcTeam: string,
	difficulty?: string
): GameRoom | null {
	// Generate room ID
	const roomid = `battle-npc-${format}-${Date.now()}` as RoomID;

	// Create a fake user object for NPC with all required properties
	const npcUserId = `npc-${npc.id}-${Date.now()}` as ID;
	const npcUser = {
		id: npcUserId,
		name: npc.name,
		avatar: npc.avatar || 'unknown',
		visibleGroup: ' ',
		// Required iterables
		games: new Set<RoomID>(),
		inRooms: new Set<RoomID>(),
		// Battle settings
		battleSettings: {
			visibleGroup: ' ',
			special: undefined,
			team: npcTeam,
		},
		// Connection info
		connected: true,
		connections: [],
		latestHost: '',
		ips: Object.create(null),
		latestIp: '127.0.0.1',
		locked: false,
		semilocked: false,
		namelocked: false,
		permalocked: false,
		autoconfirmed: '',
		trusted: '',
		registered: false,
		named: true,
		// Methods (no-ops for NPC)
		sendTo() {},
		send() {},
		popup() {},
		joinRoom() { return true; },
		leaveRoom() {},
		updateIdentity() {},
		updateSearch() {},
		can() { return false; },
		getMostRecentConnection() { return null; },
	} as unknown as User;

	// Create battle options
	const battleOptions = {
		format,
		players: [
			{
				user,
				team: userTeam,
			},
			{
				user: npcUser,
				team: npcTeam,
			},
		],
		rated: 0, // Not rated
		challengeType: 'unrated' as const,
		allowRenames: false,
		roomid,
		delayedStart: true, // Delay start to avoid user lookup issues
	};

	// Use Rooms.createBattle
	const room = Rooms.createBattle(battleOptions);

	if (room) {
		// Set room as private
		room.settings.isPrivate = 'hidden';

		// Set NPC info for display
		(room as any).npcBattle = {
			npcId: npc.id,
			npcName: npc.name,
			npcAvatar: npc.avatar,
			npcUserId: npcUserId,
			difficulty: difficulty || npc.difficulty || 'smart',
		};

		// Manually start the battle since we used delayedStart
		const battle = room.battle;
		if (battle) {
			// Mark battle as started
			battle.started = true;
			// Remove the "needs more players" message
			room.add(`|uhtmlchange|invites|`);
			// Update room state
			battle.checkActive();
			room.update();

			// Start AI for NPC (use custom difficulty if provided)
			startNPCAI(room, npc, difficulty);
		}
	}

	return room;
}

/**
 * Start AI controller for NPC
 * Creates the appropriate AI based on NPC difficulty and polls for battle requests
 * @param room - The battle room
 * @param npc - The NPC template
 * @param overrideDifficulty - Optional difficulty override (from user selection)
 */
function startNPCAI(room: GameRoom, npc: NPCTemplate, overrideDifficulty?: string): void {
	const battle = room.battle;
	if (!battle) return;

	// Get NPC player (p2)
	const npcPlayer = battle.p2;
	if (!npcPlayer) {
		console.error('[NPC] Could not find NPC player');
		return;
	}

	// Create AI instance based on difficulty (use override if provided)
	const difficulty = overrideDifficulty || npc.difficulty || 'basic';
	let ai: BasicAI | NormalAI;

	switch (difficulty) {
	case 'smart':
	case 'normal': {
		// Use NormalAI with CFRU scoring system
		const options: NormalAIOptions = {
			battleId: room.roomid,
			logging: {
				// === AI 日志开关 ===
				// LogLevel.NONE = 关闭, DECISION = 仅决策, SCORING = 含评分, VERBOSE = 全部
				console: LogLevel.VERBOSE,  // 控制台日志
				// file: LogLevel.VERBOSE,  // 取消注释启用文件日志
				// logDir: './logs/ai',
			},
		};
		ai = new NormalAI(battle.stream, options);
		// Set battle reference for full state access
		ai.setBattle(battle);
		console.log(`[NPC] Using NormalAI for ${npc.name} (difficulty: ${difficulty})`);
		break;
	}
	case 'expert':
		// ExpertAI not yet implemented, fall back to NormalAI
		console.log(`[NPC] ExpertAI not implemented, using NormalAI for ${npc.name}`);
		ai = new NormalAI(battle.stream, { battleId: room.roomid });
		(ai as NormalAI).setBattle(battle);
		break;
	case 'basic':
	case 'random':
	default:
		// Use BasicAI
		ai = new BasicAI(battle.stream);
		// Set battle reference for opponent info access
		ai.setBattle(battle);
		console.log(`[NPC] Using BasicAI for ${npc.name} (difficulty: ${difficulty})`);
		break;
	}

	// Override the choose method to add >p2 prefix for server environment
	// BattlePlayer.choose() writes directly to stream, but server needs ">p2 " prefix
	const originalChoose = ai.choose.bind(ai);
	ai.choose = (choice: string) => {
		console.log(`[NPC] AI choice: ${choice}`);
		void battle.stream.write(`>p2 ${choice}`);
	};

	// Track last processed request ID to detect retries
	let lastProcessedRqid = 0;
	let retryCount = 0;
	const MAX_RETRIES = 3;

	// Poll for requests and pass them to the AI
	// In server environment, we need to manually check for requests and call AI methods
	const checkRequest = () => {
		if (!room.battle || room.battle.ended) {
			console.log(`[NPC] Battle ended for ${npc.name}`);
			return;
		}

		const request = npcPlayer.request;
		if (request && request.request && !request.isWait) {
			try {
				const requestData = JSON.parse(request.request);

				// Check if this is a retry (same rqid or update flag)
				if (requestData.update || request.rqid === lastProcessedRqid) {
					retryCount++;
					console.log(`[NPC] Choice rejected, retry ${retryCount}/${MAX_RETRIES} for rqid ${request.rqid}`);

					if (retryCount >= MAX_RETRIES) {
						console.error(`[NPC] Max retries reached, giving up on request ${request.rqid}`);
						// Mark as wait to stop retrying
						request.isWait = true;
						retryCount = 0;
						setTimeout(checkRequest, 100);
						return;
					}
				} else {
					// New request, reset retry counter
					retryCount = 0;
				}

				lastProcessedRqid = request.rqid;

				// Mark as waiting to prevent double processing
				request.isWait = true;

				// Let the AI process the request
				// This calls receiveRequest which triggers makeDecision internally
				ai.receiveRequest(requestData);

			} catch (err) {
				console.error('[NPC] Error processing request:', err);
			}
		}

		// Continue polling
		setTimeout(checkRequest, 100);
	};

	// Start polling after a short delay to let the battle initialize
	setTimeout(checkRequest, 500);
}

/**
 * Get list of available formats for NPC battles
 * Dynamically collects all formats from all NPC templates
 */
export function getAvailableFormats(): string[] {
	const formats = new Set<string>();
	for (const npc of NPC.getAll()) {
		for (const format of NPC.getSupportedFormats(npc.id)) {
			formats.add(format);
		}
	}
	return Array.from(formats);
}

/**
 * Check if a format is supported for NPC battles
 * A format is supported if it's a valid Pokemon Showdown format
 */
export function isFormatSupported(format: string): boolean {
	// Check if this is a valid format in Pokemon Showdown
	const formatData = Dex.formats.get(format);
	return formatData.exists;
}

// ============================================================================
// Multi Battle Support
// ============================================================================

/** NPC Multi Battle creation options */
export interface NPCMultiBattleCreateOptions {
	/** User initiating the battle (p1) */
	user: User;

	/** NPC template ID */
	npcId: string;

	/** Battle format (must be a multi format) */
	format: string;

	/** User's team (packed string or PokemonSet[]) */
	team?: string | PokemonSet[];

	/** Override AI difficulty (optional, defaults to NPC's difficulty) */
	difficulty?: string;

	/** Teammate (p3) - required for creating the battle */
	teammate?: User;

	/** Teammate's team (packed string) */
	teammateTeam?: string;
}

/** NPC Multi Battle result */
export interface NPCMultiBattleResult {
	success: boolean;
	error?: string;
	room?: GameRoom;
}

/**
 * Create a fake user object for NPC
 */
function createNPCUser(npc: NPCTemplate, team: string, suffix?: string): User {
	const npcUserId = `npc-${npc.id}${suffix ? `-${suffix}` : ''}-${Date.now()}` as ID;
	return {
		id: npcUserId,
		name: npc.name + (suffix ? ` (${suffix})` : ''),
		avatar: npc.avatar || 'unknown',
		visibleGroup: ' ',
		// Required iterables
		games: new Set<RoomID>(),
		inRooms: new Set<RoomID>(),
		// Battle settings
		battleSettings: {
			visibleGroup: ' ',
			special: undefined,
			team: team,
		},
		// Connection info
		connected: true,
		connections: [],
		latestHost: '',
		ips: Object.create(null),
		latestIp: '127.0.0.1',
		locked: false,
		semilocked: false,
		namelocked: false,
		permalocked: false,
		autoconfirmed: '',
		trusted: '',
		registered: false,
		named: true,
		// Methods (no-ops for NPC)
		sendTo() {},
		send() {},
		popup() {},
		joinRoom() { return true; },
		leaveRoom() {},
		updateIdentity() {},
		updateSearch() {},
		can() { return false; },
		getMostRecentConnection() { return null; },
	} as unknown as User;
}

/**
 * Create an NPC Multi Battle
 * Creates a 4-player multi battle room:
 * - p1: User 1 (initiating player)
 * - p2: NPC (AI controlled)
 * - p3: User 2 (teammate)
 * - p4: NPC (AI controlled)
 *
 * Flow:
 * 1. User 1 invites User 2 via /npc multi [npcId], [teammate]
 * 2. User 2 accepts with /npc acceptmulti [user1]
 * 3. Both players have teams ready, room is created
 * 4. NPCMultiManager coordinates p2 and p4
 */
export async function createNPCMultiBattle(options: NPCMultiBattleCreateOptions): Promise<NPCMultiBattleResult> {
	const { user, npcId, format, difficulty, teammate, teammateTeam } = options;

	// Validate teammate is provided
	if (!teammate || !teammateTeam) {
		return { success: false, error: 'Teammate and teammate team are required' };
	}

	// Validate format is a multi format
	if (!format.includes('multi')) {
		return { success: false, error: `Format must be a multi battle format: ${format}` };
	}

	// Get NPC template
	const npc = NPC.get(npcId);
	if (!npc) {
		return { success: false, error: `NPC not found: ${npcId}` };
	}

	// Check format support
	if (!NPC.supportsFormat(npcId, format)) {
		return { success: false, error: `${npc.name} does not support format: ${format}` };
	}

	// Get NPC multi team
	const npcMultiTeam: MultiTeam | null = NPC.getMultiTeam(npcId, format);
	if (!npcMultiTeam) {
		return { success: false, error: `Failed to load NPC multi team for ${npc.name}` };
	}

	// Get user team (p1)
	let userTeam: string;

	if (options.team) {
		if (typeof options.team === 'string') {
			userTeam = options.team;
		} else {
			userTeam = Teams.pack(options.team);
		}
	} else {
		return { success: false, error: 'No team provided for p1' };
	}

	// Validate user team
	const validator = TeamValidator.get(format);
	const p1Problems = validator.validateTeam(Teams.unpack(userTeam));
	if (p1Problems) {
		return { success: false, error: `P1 team validation failed: ${p1Problems.join(', ')}` };
	}

	// Validate teammate team (p3)
	const p3Problems = validator.validateTeam(Teams.unpack(teammateTeam));
	if (p3Problems) {
		return { success: false, error: `P3 team validation failed: ${p3Problems.join(', ')}` };
	}

	// Pack NPC teams
	const npcP2TeamPacked = Teams.pack(npcMultiTeam.p2);
	const npcP4TeamPacked = Teams.pack(npcMultiTeam.p4);

	// Create battle room with all 4 players
	try {
		const room = createMultiBattleRoom(
			user,
			teammate,
			npc,
			format,
			userTeam,
			teammateTeam,
			npcP2TeamPacked,
			npcP4TeamPacked,
			difficulty
		);
		if (!room) {
			return { success: false, error: 'Failed to create multi battle room' };
		}

		return { success: true, room };
	} catch (err) {
		console.error('[NPC] Failed to create multi battle:', err);
		return { success: false, error: 'Internal error creating multi battle' };
	}
}

/**
 * Create the multi battle room with all 4 players
 * All players are ready, no delayed start needed
 */
function createMultiBattleRoom(
	p1User: User,
	p3User: User,
	npc: NPCTemplate,
	format: string,
	p1Team: string,
	p3Team: string,
	npcP2Team: string,
	npcP4Team: string,
	difficulty?: string
): GameRoom | null {
	// Generate room ID
	const roomid = `battle-npc-multi-${format}-${Date.now()}` as RoomID;

	// Create fake user objects for NPC p2 and p4
	const npcP2User = createNPCUser(npc, npcP2Team, 'p2');
	const npcP4User = createNPCUser(npc, npcP4Team, 'p4');

	// Create battle options for multi battle
	// All 4 players are ready, no need for delayedStart
	const battleOptions = {
		format,
		players: [
			{
				user: p1User,
				team: p1Team,
			},
			{
				user: npcP2User,
				team: npcP2Team,
			},
			{
				user: p3User,
				team: p3Team,
			},
			{
				user: npcP4User,
				team: npcP4Team,
			},
		],
		rated: 0,
		challengeType: 'unrated' as const,
		allowRenames: false,
		roomid,
		delayedStart: true, // Delay to set up AI before battle starts
	};

	// Use Rooms.createBattle
	const room = Rooms.createBattle(battleOptions);

	if (room) {
		// Set room as private
		room.settings.isPrivate = 'hidden';

		// Store NPC info for later AI initialization
		(room as any).npcMultiBattle = {
			npcId: npc.id,
			npcName: npc.name,
			npcAvatar: npc.avatar,
			npcP2UserId: npcP2User.id,
			npcP4UserId: npcP4User.id,
			difficulty: difficulty || npc.difficulty || 'smart',
			aiStarted: false,
		};

		// Start the battle and AI
		const battle = room.battle;
		if (battle) {
			battle.started = true;
			room.add(`|uhtmlchange|invites|`);
			battle.checkActive();
			room.update();

			// Start NPC AI
			startNPCMultiAI(room, npc, difficulty);
		}

		console.log(`[NPC] Created multi battle room ${roomid} for ${npc.name}`);
	}

	return room;
}

/**
 * Start NPCMultiManager for multi battle
 * Coordinates AI decisions for both p2 and p4
 */
function startNPCMultiAI(room: GameRoom, npc: NPCTemplate, overrideDifficulty?: string): void {
	const battle = room.battle;
	if (!battle) return;

	const npcInfo = (room as any).npcMultiBattle;
	if (!npcInfo) {
		console.error('[NPC] No npcMultiBattle info found');
		return;
	}

	// Get NPC players
	const npcP2Player = battle.p2;
	const npcP4Player = battle.p4;

	if (!npcP2Player || !npcP4Player) {
		console.error('[NPC] Could not find NPC players for multi battle');
		return;
	}

	// Create NPCMultiManager
	const difficulty = overrideDifficulty || npc.difficulty || 'smart';
	const options: NPCMultiManagerOptions = {
		battleId: room.roomid,
		difficulty,
		logging: {
			console: LogLevel.VERBOSE,
		},
	};

	const manager = new NPCMultiManager(battle, options);

	// Store manager reference for cleanup
	npcInfo.manager = manager;

	// Start the manager
	manager.start();

	console.log(`[NPC] Started NPCMultiManager for ${npc.name} (difficulty: ${difficulty})`);
}
