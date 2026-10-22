/** Local observation files for discussing a live NPC battle; never an AI input. */
import * as fs from 'fs';
import * as path from 'path';
import { extractChannelMessages } from '../../sim/battle';
import { Teams } from '../../sim/teams';
import type { DecisionLogEntry } from './ai/cfru/logger';

export const NPC_LIVE_LOG_ROOT = '/tmp/pokemon-showdown-npc-live';

interface LiveBattleInfo {
	roomid: string;
	format: string;
	difficulty: string;
	players: { side: string, name: string, team: string }[];
}

export class NPCLiveLog {
	readonly directory: string;
	private enabled = true;
	private closed = false;

	constructor(stream: AnyObject, info: LiveBattleInfo, root = NPC_LIVE_LOG_ROOT) {
		if (!/^[a-z0-9-]+$/.test(info.roomid)) throw new Error('Invalid NPC battle room ID');
		this.directory = path.join(root, info.roomid);
		fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		fs.writeFileSync(path.join(this.directory, 'metadata.json'), JSON.stringify({
			...info, startedAt: new Date().toISOString(),
			players: info.players.map(p => ({ ...p, team: Teams.unpack(p.team) })),
		}, null, 2) + '\n', { mode: 0o600 });
		for (const file of ['battle.log', 'ai.jsonl']) {
			fs.writeFileSync(path.join(this.directory, file), '', { mode: 0o600 });
		}
		const push = stream.push.bind(stream);
		stream.push = (chunk: string | null) => {
			if (typeof chunk === 'string') this.observe(chunk);
			return push(chunk);
		};
		const destroy = stream.destroy.bind(stream);
		stream.destroy = (...args: unknown[]) => {
			this.close('closed');
			return destroy(...args);
		};
	}

	private append(file: string, text: string): void {
		if (!this.enabled || this.closed) return;
		try {
			// Small per-turn writes are immediately readable and hold no descriptors between turns.
			fs.appendFileSync(path.join(this.directory, file), text, { mode: 0o600 });
		} catch (error) {
			this.enabled = false;
			console.error(`[NPC live log] Recording disabled for ${this.directory}: ${error}`);
		}
	}

	private observe(chunk: string): void {
		const boundary = chunk.indexOf('\n');
		const type = boundary < 0 ? chunk : chunk.slice(0, boundary);
		if (type === 'update') {
			const lines = extractChannelMessages(chunk.slice(boundary + 1), [0])[0];
			if (lines.length) this.append('battle.log', lines.join('\n') + '\n');
		} else if (type === 'sideupdate') {
			const [side, ...lines] = chunk.slice(boundary + 1).split('\n');
			for (const line of lines.filter(l => l.startsWith('|error|'))) {
				this.append('ai.jsonl', JSON.stringify({ type: 'error', at: new Date().toISOString(), side, message: line }) + '\n');
			}
		} else if (type === 'end') {
			this.close('ended');
		}
	}

	decision(side: string, turn: number, choice: string, decision?: DecisionLogEntry): void {
		this.append('ai.jsonl', JSON.stringify({
			type: 'decision', at: new Date().toISOString(), side, turn, choice, decision,
		}, (_key, value) => value instanceof Map ? Object.fromEntries(value) : value) + '\n');
	}

	private close(type: 'ended' | 'closed'): void {
		if (this.closed) return;
		this.append('ai.jsonl', JSON.stringify({ type, at: new Date().toISOString() }) + '\n');
		this.closed = true;
	}
}

export function startNPCLiveLog(stream: AnyObject, info: LiveBattleInfo): NPCLiveLog | undefined {
	if (Config.nofswriting) return;
	try {
		const log = new NPCLiveLog(stream, info);
		console.log(`[NPC live log] ${log.directory}`);
		return log;
	} catch (error) {
		console.error(`[NPC live log] Could not start recording: ${error}`);
		return undefined;
	}
}
