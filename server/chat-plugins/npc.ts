/**
 * NPC Battle Commands
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Chat commands for NPC battles.
 *
 * @license MIT
 */

import { NPC } from '../npc/manager';
import { createNPCBattle, createNPCMultiBattle, getAvailableFormats, isFormatSupported } from '../npc/room';
import { Teams } from '../../sim/teams';
import { challenges, GameChallenge } from '../ladders-challenges';

/**
 * Get display name for a format
 * Dynamically generates names for any gen/tier combination
 */
function getFormatDisplayName(format: string): string {
	// Extract generation and tier from format like "gen9ou", "gen8doublesou"
	const match = format.match(/^gen(\d+)(.+)$/);
	if (!match) return format;

	const gen = match[1];
	const tier = match[2];

	// Map tier codes to display names
	const tierNames: { [key: string]: string } = {
		'ou': 'OU',
		'uu': 'UU',
		'ru': 'RU',
		'nu': 'NU',
		'pu': 'PU',
		'ubers': 'Ubers',
		'lc': 'LC',
		'doublesou': 'Doubles OU',
		'doublesuu': 'Doubles UU',
		'vgc2024': 'VGC 2024',
		'vgc2023': 'VGC 2023',
		'randombattle': 'Random Battle',
		'randomdoublesbattle': 'Random Doubles',
		'nationaldexmulti': 'National Dex Multi',
	};

	const tierName = tierNames[tier] || tier.toUpperCase();
	return `[Gen ${gen}] ${tierName}`;
}

/** Difficulty display names and descriptions */
const DIFFICULTY_INFO: { [key: string]: { name: string; description: string } } = {
	'basic': { name: 'Basic', description: 'Simple AI - picks highest damage move' },
	'smart': { name: 'Smart', description: 'Advanced AI - uses strategic scoring system' },
};

/** Available difficulties for user selection */
const AVAILABLE_DIFFICULTIES = ['basic', 'smart'] as const;
type Difficulty = typeof AVAILABLE_DIFFICULTIES[number];

/**
 * Generate NPC list HTML
 */
function getNPCListHTML(user: User): string {
	const npcs = NPC.getAll();

	if (npcs.length === 0) {
		return `<div class="pad"><h2>NPC Battle</h2><p>No NPCs available.</p></div>`;
	}

	let html = `<div class="pad">`;
	html += `<h2>NPC Battle</h2>`;
	html += `<p>Challenge an NPC trainer to battle!</p>`;

	html += `<div class="ladder">`;
	html += `<table><tr><th>NPC</th><th>Difficulty</th><th>Formats</th><th>Action</th></tr>`;

	for (const npc of npcs) {
		const formats = NPC.getSupportedFormats(npc.id);
		const formatNames = formats.map(f => getFormatDisplayName(f)).join(', ');

		html += `<tr>`;
		html += `<td><strong>${npc.name}</strong>${npc.title ? `<br/><small>${npc.title}</small>` : ''}</td>`;
		html += `<td>${npc.difficulty}</td>`;
		html += `<td>${formatNames || 'None'}</td>`;
		html += `<td><button class="button" name="send" value="/npc challenge ${npc.id}">Challenge</button></td>`;
		html += `</tr>`;
	}

	html += `</table></div>`;

	// Random battle button
	html += `<hr/><p><button class="button" name="send" value="/npc random">Random NPC Battle</button></p>`;

	html += `</div>`;
	return html;
}

/**
 * Generate format selection HTML for a specific NPC
 */
function getFormatSelectionHTML(npcId: string, user: User, selectedDifficulty?: string): string {
	const npc = NPC.get(npcId);

	if (!npc) {
		return `<div class="pad"><h2>Error</h2><p>NPC not found: ${npcId}</p></div>`;
	}

	const allFormats = NPC.getSupportedFormats(npcId);
	// Filter out multi formats - they need special /npc multi command
	const formats = allFormats.filter(f => !f.includes('multi'));
	// Check if NPC has multi formats available
	const multiFormats = allFormats.filter(f => f.includes('multi'));
	const difficulty = selectedDifficulty || npc.difficulty || 'smart';

	let html = `<div class="pad">`;
	html += `<h2>Challenge ${npc.name}</h2>`;
	if (npc.title) html += `<p><em>${npc.title}</em></p>`;
	if (npc.description) html += `<p>${npc.description}</p>`;

	// Difficulty selection
	html += `<h3>Select Difficulty</h3>`;
	html += `<div class="ladder"><table>`;
	html += `<tr><th>Difficulty</th><th>Description</th><th>Select</th></tr>`;

	for (const diff of AVAILABLE_DIFFICULTIES) {
		const info = DIFFICULTY_INFO[diff];
		const isSelected = diff === difficulty;
		const selectedMark = isSelected ? ' ✓' : '';
		const buttonStyle = isSelected ? 'background:#5a5;color:white;' : '';

		html += `<tr>`;
		html += `<td><strong>${info.name}${selectedMark}</strong></td>`;
		html += `<td>${info.description}</td>`;
		html += `<td><button class="button" style="${buttonStyle}" name="send" value="/npc challenge ${npcId}, ${diff}">${isSelected ? 'Selected' : 'Select'}</button></td>`;
		html += `</tr>`;
	}
	html += `</table></div>`;

	// Format selection
	html += `<h3>Select Format</h3>`;

	if (formats.length === 0) {
		html += `<p>No formats available for this NPC.</p>`;
	} else {
		html += `<div class="ladder"><table>`;
		html += `<tr><th>Format</th><th>Action</th></tr>`;

		for (const format of formats) {
			const formatName = getFormatDisplayName(format);
			const needsTeam = !format.includes('randombattle');

			html += `<tr>`;
			html += `<td><strong>${formatName}</strong>`;
			if (needsTeam) {
				html += ` <small>(requires team)</small>`;
			}
			html += `</td>`;
			html += `<td><button class="button" name="send" value="/npc start ${npcId}, ${format}, ${difficulty}">Battle</button></td>`;
			html += `</tr>`;
		}

		html += `</table></div>`;
	}

	// Add Multi Battle section if NPC supports it
	if (multiFormats.length > 0) {
		html += `<h3>Multi Battle (2v2 Team)</h3>`;
		html += `<p>Team up with a friend against ${npc.name}!</p>`;
		html += `<div class="ladder"><table>`;
		html += `<tr><th>Format</th><th>Action</th></tr>`;

		for (const format of multiFormats) {
			const formatName = getFormatDisplayName(format);
			html += `<tr>`;
			html += `<td><strong>${formatName}</strong> <small>(requires 3 Pokemon team)</small></td>`;
			html += `<td><button class="button" name="send" value="/npc multisetup ${npcId}, ${difficulty}">Start Multi Battle</button></td>`;
			html += `</tr>`;
		}

		html += `</table></div>`;
	}

	html += `<hr/><p><button class="button" name="send" value="/npc list">Back to NPC List</button></p>`;
	html += `</div>`;

	return html;
}

export const commands: Chat.ChatCommands = {
	npc: {
		''(target, room, user) {
			return this.parse('/npc list');
		},

		list(target, room, user) {
			if (!this.runBroadcast()) return;

			if (this.broadcasting) {
				// Broadcast a simple message
				return this.sendReplyBox(
					`<strong>NPC Battle</strong> - Use <code>/npc</code> to view available NPCs and start a battle.`
				);
			}

			// Send HTML to user
			this.sendReplyBox(getNPCListHTML(user));
		},

		challenge(target, room, user) {
			const parts = target.split(',').map(s => s.trim());
			const npcId = toID(parts[0]);
			const difficulty = parts[1] ? toID(parts[1]) : undefined;

			if (!npcId) {
				return this.errorReply(`Usage: /npc challenge [npc id]`);
			}

			const npc = NPC.get(npcId);
			if (!npc) {
				return this.errorReply(`NPC not found: ${npcId}`);
			}

			// Validate difficulty if provided
			if (difficulty && !AVAILABLE_DIFFICULTIES.includes(difficulty as any)) {
				return this.errorReply(`Invalid difficulty: ${difficulty}. Available: ${AVAILABLE_DIFFICULTIES.join(', ')}`);
			}

			// Show format selection with difficulty
			this.sendReplyBox(getFormatSelectionHTML(npcId, user, difficulty));
		},

		async start(target, room, user, connection) {
			const parts = target.split(',').map(s => s.trim());
			const npcId = parts[0];
			const format = parts[1];
			// Third param can be difficulty or team
			// If it's a known difficulty, use it; otherwise treat as team
			let difficulty: string | undefined;
			let teamStr: string | undefined;

			if (parts[2]) {
				const possibleDiff = toID(parts[2]);
				if (AVAILABLE_DIFFICULTIES.includes(possibleDiff as any)) {
					difficulty = possibleDiff;
					teamStr = parts[3]; // Team is 4th param if difficulty is specified
				} else {
					teamStr = parts[2]; // No difficulty, this is the team
				}
			}

			if (!npcId || !format) {
				return this.errorReply(`Usage: /npc start [npc id], [format], [difficulty (optional)], [team (optional)]`);
			}

			const npc = NPC.get(toID(npcId));
			if (!npc) {
				return this.errorReply(`NPC not found: ${npcId}`);
			}

			// Validate format
			if (!isFormatSupported(format)) {
				return this.errorReply(`Format not supported for NPC battles: ${format}`);
			}

			// Multi formats require /npc multi command
			if (format.includes('multi')) {
				return this.errorReply(
					`Multi battle format requires the /npc multi command. ` +
					`Use: /npc multi ${npc.id}`
				);
			}

			if (!NPC.supportsFormat(npc.id, format)) {
				return this.errorReply(`${npc.name} does not support format: ${format}`);
			}

			// Use provided difficulty or fall back to NPC's default
			const finalDifficulty = difficulty || npc.difficulty || 'smart';

			// Get user's team
			let team: string | undefined;

			if (format.includes('randombattle')) {
				// Random battle - no team needed
				team = undefined;
			} else if (teamStr) {
				// Team provided in command
				team = teamStr;
			} else {
				// Try to get user's saved team
				const userTeams = user.battleSettings?.team;
				if (userTeams) {
					team = userTeams;
				}

				if (!team) {
					return this.errorReply(
						`You need to select a team first. Use the Teambuilder to create and select a team, ` +
						`or use Random Battle format.`
					);
				}
			}

			// Create battle with custom difficulty
			const result = await createNPCBattle({
				user,
				npcId: npc.id,
				format,
				team,
				difficulty: finalDifficulty,
			});

			if (!result.success) {
				return this.errorReply(result.error || 'Failed to create NPC battle');
			}

			// Join the battle room
			if (result.room) {
				user.joinRoom(result.room);
				this.sendReply(`|redirect|/${result.room.roomid}`);
			}
		},

		async random(target, room, user, connection) {
			// Get random NPC
			const npc = NPC.getRandom();
			if (!npc) {
				return this.errorReply(`No NPCs available.`);
			}

			// Default to random battle format
			const format = 'gen9randombattle';

			if (!NPC.supportsFormat(npc.id, format)) {
				// Try to find a supported format
				const formats = NPC.getSupportedFormats(npc.id);
				if (formats.length === 0) {
					return this.errorReply(`${npc.name} has no supported formats.`);
				}
				// Show format selection instead
				return this.sendReplyBox(getFormatSelectionHTML(npc.id, user));
			}

			// Create battle
			const result = await createNPCBattle({
				user,
				npcId: npc.id,
				format,
			});

			if (!result.success) {
				return this.errorReply(result.error || 'Failed to create NPC battle');
			}

			// Join the battle room
			if (result.room) {
				user.joinRoom(result.room);
				this.sendReply(`|redirect|/${result.room.roomid}`);
			}
		},

		reload(target, room, user) {
			this.checkCan('rangeban');

			NPC.reload();
			this.sendReply(`NPC templates reloaded. ${NPC.count} templates loaded.`);
		},

		/**
		 * Show multi battle setup interface
		 * Usage: /npc multisetup [npcId], [difficulty]
		 * Shows an input form for teammate username
		 */
		multisetup(target, room, user) {
			const parts = target.split(',').map(s => s.trim());
			const npcId = toID(parts[0]);
			const difficulty = parts[1] ? toID(parts[1]) : undefined;

			if (!npcId) {
				return this.errorReply(`Usage: /npc multisetup [npc id], [difficulty (optional)]`);
			}

			const npc = NPC.get(npcId);
			if (!npc) {
				return this.errorReply(`NPC not found: ${npcId}`);
			}

			// Check if NPC supports multi format
			const multiFormat = 'gen9nationaldexmulti';
			if (!NPC.supportsFormat(npc.id, multiFormat)) {
				return this.errorReply(`${npc.name} does not support multi battles.`);
			}

			const finalDifficulty = difficulty || npc.difficulty || 'smart';
			const diffInfo = DIFFICULTY_INFO[finalDifficulty] || { name: finalDifficulty, description: '' };

			// Show teammate input form
			let html = `<div class="pad">`;
			html += `<h2>Multi Battle Setup</h2>`;
			html += `<p>Challenge <strong>${npc.name}</strong> with a teammate!</p>`;
			html += `<p>Difficulty: <strong>${diffInfo.name}</strong></p>`;
			html += `<hr/>`;
			html += `<p>Enter your teammate's username:</p>`;
			html += `<form data-submitsend="/npc multi ${npc.id}, {teammate}, ${finalDifficulty}">`;
			html += `<input type="text" name="teammate" placeholder="Teammate username" autofocus />`;
			html += ` <button class="button" type="submit">Send Invitation</button>`;
			html += `</form>`;
			html += `<hr/>`;
			html += `<p><button class="button" name="send" value="/npc challenge ${npc.id}, ${finalDifficulty}">Back</button></p>`;
			html += `</div>`;

			this.sendReplyBox(html);
		},

		/**
		 * Start a multi battle against NPC
		 * Usage: /npc multi [npcId], [teammate], [difficulty]
		 * Sends an invitation to teammate, creates battle when they accept
		 */
		async multi(target, room, user, connection) {
			const parts = target.split(',').map(s => s.trim());
			const npcId = toID(parts[0]);
			const teammateStr = parts[1];
			const difficulty = parts[2] ? toID(parts[2]) : undefined;

			if (!npcId) {
				return this.errorReply(`Usage: /npc multi [npc id], [teammate username], [difficulty (optional)]`);
			}

			if (!teammateStr) {
				return this.errorReply(`You must specify a teammate to invite. Usage: /npc multi ${npcId}, [teammate username]`);
			}

			const npc = NPC.get(npcId);
			if (!npc) {
				return this.errorReply(`NPC not found: ${npcId}`);
			}

			// Check if NPC supports multi format
			const multiFormat = 'gen9nationaldexmulti';
			if (!NPC.supportsFormat(npc.id, multiFormat)) {
				return this.errorReply(`${npc.name} does not support multi battles. NPC needs a multi team configured.`);
			}

			// Find teammate
			const teammate = Users.get(teammateStr);
			if (!teammate) {
				return this.errorReply(`User "${teammateStr}" not found or not online.`);
			}
			if (teammate.id === user.id) {
				return this.errorReply(`You cannot invite yourself.`);
			}

			// Get user's team
			const team = user.battleSettings?.team;
			if (!team) {
				return this.errorReply(
					`You need to select a team first. Use the Teambuilder to create and select a team for multi battles.`
				);
			}

			// Validate team size (max 3 for multi)
			const unpackedTeam = Teams.unpack(team);
			if (unpackedTeam && unpackedTeam.length > 3) {
				return this.errorReply(`Multi battle teams can have at most 3 Pokemon. Your team has ${unpackedTeam.length}.`);
			}

			// Check for existing challenge between these users
			const existingChallenge = challenges.search(user.id, teammate.id);
			if (existingChallenge) {
				return this.errorReply(`There is already a pending challenge between you and ${teammate.name}.`);
			}

			// Store challenge data for later use
			const challengeData = {
				npcId: npc.id,
				format: multiFormat,
				difficulty: difficulty || npc.difficulty || 'smart',
				p1Team: team,
			};

			// Create a GameChallenge to send invitation
			const challenge = new GameChallenge(
				user.id,
				teammate.id,
				multiFormat,
				{
					acceptCommand: `/npc acceptmulti ${user.id}`,
					message: `${user.name} wants to team up with you to battle ${npc.name} in a Multi Battle!`,
					acceptButton: 'Accept & Select Team',
					rejectButton: 'Decline',
				}
			);

			// Store additional data on the challenge object
			(challenge as any).npcMultiData = challengeData;

			// Add challenge
			challenges.add(challenge);

			this.sendReply(`Invitation sent to ${teammate.name}. Waiting for them to accept...`);
		},

		/**
		 * Accept a multi battle invitation
		 * Usage: /npc acceptmulti [challenger]
		 */
		async acceptmulti(target, room, user, connection) {
			const challengerId = toID(target);
			if (!challengerId) {
				return this.errorReply(`Usage: /npc acceptmulti [challenger username]`);
			}

			// Find the challenge
			const challenge = challenges.search(user.id, challengerId);
			if (!challenge || challenge.to !== user.id) {
				return this.errorReply(`No pending multi battle invitation from ${challengerId}.`);
			}

			// Get challenge data
			const challengeData = (challenge as any).npcMultiData;
			if (!challengeData) {
				return this.errorReply(`Invalid challenge data. Please ask the challenger to send a new invitation.`);
			}

			// Get challenger user
			const challenger = Users.get(challengerId);
			if (!challenger) {
				challenges.remove(challenge);
				return this.errorReply(`User ${challengerId} is no longer online.`);
			}

			// Get teammate's (acceptor's) team
			const teammateTeam = user.battleSettings?.team;
			if (!teammateTeam) {
				return this.errorReply(
					`You need to select a team first. Use the Teambuilder to create and select a team (max 3 Pokemon).`
				);
			}

			// Validate teammate's team size
			const unpackedTeam = Teams.unpack(teammateTeam);
			if (unpackedTeam && unpackedTeam.length > 3) {
				return this.errorReply(`Multi battle teams can have at most 3 Pokemon. Your team has ${unpackedTeam.length}.`);
			}

			// Remove the challenge
			challenges.remove(challenge, true);

			// Create the multi battle with both players
			const result = await createNPCMultiBattle({
				user: challenger, // p1
				npcId: challengeData.npcId,
				format: challengeData.format,
				team: challengeData.p1Team,
				difficulty: challengeData.difficulty,
				teammate: user, // p3
				teammateTeam: teammateTeam,
			});

			if (!result.success) {
				challenger.popup(`Failed to create multi battle: ${result.error}`);
				return this.errorReply(result.error || 'Failed to create multi battle');
			}

			// Both players join the battle room
			if (result.room) {
				challenger.joinRoom(result.room);
				user.joinRoom(result.room);
				challenger.send(`|redirect|/${result.room.roomid}`);
				this.sendReply(`|redirect|/${result.room.roomid}`);
			}
		},
	},

	npchelp: [
		`/npc - Show the NPC battle menu`,
		`/npc list - Show available NPCs`,
		`/npc challenge [npc], [difficulty] - Select a format and difficulty to battle an NPC`,
		`/npc start [npc], [format], [difficulty] - Start a battle with the specified NPC, format, and difficulty`,
		`/npc random - Start a random battle with a random NPC`,
		`/npc multisetup [npc], [difficulty] - Show multi battle setup form to enter teammate`,
		`/npc multi [npc], [teammate], [difficulty] - Invite teammate for multi battle (2v2) against NPC`,
		`/npc acceptmulti [challenger] - Accept a multi battle invitation`,
		`/npc reload - Reload NPC templates (requires hotpatch permission)`,
		`Available difficulties: basic (simple AI), smart (advanced AI)`,
	],
};

export const pages: Chat.PageTable = {
	npc(query, user, connection) {
		this.title = '[NPC Battle]';
		const [cmd, ...args] = query;

		let html = `<div class="pad">`;
		html += `<button class="button" name="send" value="/join view-npc" style="float:right"><i class="fa fa-refresh"></i> Refresh</button>`;

		if (!cmd || cmd === 'list') {
			// Show NPC list
			return getNPCListHTML(user);
		}

		if (cmd === 'challenge' && args[0]) {
			// Show format selection for specific NPC (with optional difficulty)
			return getFormatSelectionHTML(args[0], user, args[1]);
		}

		// Default to list
		return getNPCListHTML(user);
	},
};
