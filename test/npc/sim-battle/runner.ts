/**
 * NPC AI 实战模拟 Runner
 *
 * 启动一局 BattleStream，p1/p3 由策略玩家（max-damage / random / mirror-npc / scripted /
 * interactive）控制，p2/p4 由本仓库的 NPC AI 控制。
 *
 * - 单打: p1 vs p2
 * - 双打: p1 vs p2，各 2 只 active
 * - Multi: (p1 + p3) vs (p2 + p4)，每人一只 active
 *
 * 协议日志 → stdout，决策日志 → stderr。固定 seed 可复现一局。
 *
 * 用法示例：
 *   # 单打，max-damage p1 对 Normal NPC
 *   node dist/test/npc/sim-battle/runner.js \
 *     --format gen9nationaldex --player sample_team_1_gen7ou.txt \
 *     --npc    sample_team_2_gen7ou.txt \
 *     --p1-strategy max-damage --npc-difficulty normal --max-turns 30
 *
 *   # 双打，mirror-npc 对 Normal NPC
 *   node dist/test/npc/sim-battle/runner.js \
 *     --format gen9nationaldexdoublesou --game-type doubles \
 *     --player sample_team_1_gen7ou.txt --npc data/npc/teams/maxie-gen9nationaldexdoublesou.json \
 *     --p1-strategy mirror-npc
 *
 *   # Multi: p1 + p3 两位玩家策略对打 p2 + p4 两位 NPC
 *   node dist/test/npc/sim-battle/runner.js \
 *     --format gen9nationaldexmulti --game-type multi \
 *     --player sample_team_1_gen7ou.txt --player2 sample_team_2_gen7ou.txt \
 *     --npc    data/npc/teams/maxie-gen9nationaldexmulti.json \
 *     --npc2   data/npc/teams/gym-brock-gen9nationaldexmulti.json \
 *     --p1-strategy max-damage --p3-strategy random
 */

import * as fs from 'fs';
import * as path from 'path';

import { BattleStream, getPlayerStreams, Teams } from '../../../sim';
import type { PokemonSet } from '../../../sim/teams';

import { BasicAI } from '../../../server/npc/ai/basic';
import { NormalAI, NormalAIOptions } from '../../../server/npc/ai/normal';
import { LogLevel } from '../../../server/npc/ai/cfru/logger';
import { createBattleTracker } from '../../../server/npc/ai/cfru/util/battle-tracker';

import { makeStrategy, StrategyName, StrategyPlayer, ScriptEntry } from './strategies';

type GameType = 'singles' | 'doubles' | 'multi';

interface CliArgs {
	format: string;
	gameType: GameType;
	playerTeam: string;    // p1
	player2Team?: string;  // p3 (multi only)
	npcTeam: string;       // p2
	npc2Team?: string;     // p4 (multi only)

	p1Strategy: StrategyName;
	p3Strategy: StrategyName;
	scriptP1?: string;
	scriptP3?: string;

	npcDifficulty: 'basic' | 'normal';
	npc2Difficulty: 'basic' | 'normal';

	seed?: [number, number, number, number];
	logLevel: 'NONE' | 'DECISION' | 'SCORING' | 'VERBOSE';
	maxTurns: number;
	debugAI: boolean;
}

function parseArgs(argv: string[]): CliArgs {
	const args: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith('--')) continue;
		const key = a.slice(2);
		const next = argv[i + 1];
		if (next && !next.startsWith('--')) { args[key] = next; i++; } else { args[key] = 'true'; }
	}

	const gameType = (args['game-type'] || 'singles') as GameType;
	if (!['singles', 'doubles', 'multi'].includes(gameType)) {
		throw new Error(`--game-type must be singles | doubles | multi`);
	}
	const parseStrategy = (name: string, fallback: StrategyName): StrategyName => {
		const s = (name || fallback) as StrategyName;
		if (!['max-damage', 'random', 'mirror-npc', 'scripted', 'interactive'].includes(s)) {
			throw new Error(`Unknown strategy: ${s}`);
		}
		return s;
	};

	let seed: CliArgs['seed'];
	if (args.seed) {
		const parts = args.seed.split(',').map(s => Number(s.trim()));
		if (parts.length !== 4 || parts.some(n => Number.isNaN(n))) {
			throw new Error(`--seed expects "a,b,c,d"`);
		}
		seed = parts as [number, number, number, number];
	}

	return {
		format: args.format || 'gen9nationaldex',
		gameType,
		playerTeam: args.player || args['player-team'] || '',
		player2Team: args.player2 || args['player2-team'],
		npcTeam: args.npc || args['npc-team'] || '',
		npc2Team: args.npc2 || args['npc2-team'],

		p1Strategy: parseStrategy(args['p1-strategy'], 'max-damage'),
		p3Strategy: parseStrategy(args['p3-strategy'], 'max-damage'),
		scriptP1: args['script-p1'] || args.script,
		scriptP3: args['script-p3'],

		npcDifficulty: ((args['npc-difficulty'] || args.difficulty || 'normal')) as 'basic' | 'normal',
		npc2Difficulty: ((args['npc2-difficulty'] || args['npc-difficulty'] || 'normal')) as 'basic' | 'normal',

		seed,
		logLevel: ((args['log-level'] || 'DECISION')) as CliArgs['logLevel'],
		maxTurns: Number(args['max-turns']) || 200,
		debugAI: args['debug-ai'] === 'true',
	};
}

/**
 * 支持三种队伍文件来源：
 *   1. PS 导出格式 .txt
 *   2. { format?, pokemon: PokemonSet[] } 结构 JSON（data/npc/teams/*.json）
 *   3. 直接 PokemonSet[] JSON 数组
 *
 * Multi 场景下 data/npc/teams/*.json 的 pokemon 带 slot=p2/p4 字段，用于区分哪
 * 几只属于 p2、哪几只属于 p4；loadTeam 本身不感知 slot，取 slot 的工具是 pickSlot()。
 */
function loadTeam(filePath: string): PokemonSet[] {
	if (!filePath) throw new Error('team path required');
	const abs = path.resolve(filePath);
	if (!fs.existsSync(abs)) throw new Error(`team file not found: ${abs}`);
	const raw = fs.readFileSync(abs, 'utf8');
	const ext = path.extname(abs).toLowerCase();

	if (ext === '.txt') {
		const parsed = Teams.import(raw);
		if (!parsed?.length) throw new Error(`Teams.import failed for ${abs}`);
		return parsed;
	}
	let data: AnyObject;
	try { data = JSON.parse(raw); } catch (e) {
		const parsed = Teams.import(raw);
		if (parsed?.length) return parsed;
		throw e;
	}
	if (Array.isArray(data)) return data as PokemonSet[];
	if (data.pokemon?.length) return data.pokemon as PokemonSet[];
	throw new Error(`unrecognized team shape in ${abs}`);
}

/** Multi 场景：按 slot 字段过滤出属于 'p2' / 'p4' 的那部分。无 slot 字段则返回原数组。 */
function pickSlot(team: PokemonSet[], slot: 'p2' | 'p4'): PokemonSet[] {
	const withSlot = team.filter(m => (m as AnyObject).slot === slot);
	if (withSlot.length) return withSlot;
	// 没有 slot 字段 → 整个队伍视作该 side 的队伍（允许 npc 和 npc2 分开指定文件）
	return team;
}

/** 对于 Max Team Size=3 的 multi 格式，队伍过长会被 team-validator 拒掉。
 *  如果用户给了一个 6 人阵容，截断前 3。 */
function limitTeamSize(team: PokemonSet[], max: number): PokemonSet[] {
	if (team.length <= max) return team;
	return team.slice(0, max);
}

function loadScript(filePath?: string): ScriptEntry[] {
	if (!filePath) return [];
	return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8')) as ScriptEntry[];
}

/**
 * 构造 NPC AI（p2 / p4）。对 Multi 来说 p2+p4 同队，共享 tracker（isMulti=true 使 tracker 把两边都视作自家）。
 * 为了避免双 AI 共享 tracker 导致 attach-once 冲突，每个 side 用自己的 tracker。
 */
function createNPC(
	side: 'p2' | 'p4',
	stream: AnyObject,
	difficulty: 'basic' | 'normal',
	options: { formatId: string; logLevel: LogLevel; battleIdPrefix: string; isMulti: boolean }
): BasicAI | NormalAI {
	let ai: BasicAI | NormalAI;
	if (difficulty === 'basic') {
		ai = new BasicAI(stream);
	} else {
		const opts: NormalAIOptions = {
			battleId: `${options.battleIdPrefix}-${side}`,
			logging: { console: options.logLevel },
		};
		ai = new NormalAI(stream, opts);
	}
	// NPC 自己的 side 是 side 本身；multi 下 tracker 把 'p2'+'p4' / 'p1'+'p3' 视作同队
	// 这里 side 可能是 p2 或 p4：ourSide 应是 p2（team2 的根）
	// 替换 tracker：使之认识 multi 两边
	(ai as AnyObject).tracker = createBattleTracker('p2', options.isMulti);
	ai.getTracker().attachToStream(stream);
	if (ai instanceof NormalAI) {
		ai.setBattle({ stream, format: options.formatId } as AnyObject);
	}
	return ai;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const isMulti = args.gameType === 'multi';
	const maxTeamSize = isMulti ? 3 : 6;

	const rawPlayerTeam = loadTeam(args.playerTeam);
	const rawNpcTeam = loadTeam(args.npcTeam);
	const rawPlayer2Team = args.player2Team ? loadTeam(args.player2Team) : null;
	const rawNpc2Team = args.npc2Team ? loadTeam(args.npc2Team) : null;

	// Multi：如果 npc 文件带 slot，自动拆成 p2/p4；如果不带且只有一个文件，复用整个 team
	let p2Team = rawNpcTeam;
	let p4Team = rawNpc2Team;
	if (isMulti) {
		p2Team = pickSlot(rawNpcTeam, 'p2');
		if (!rawNpc2Team) {
			p4Team = pickSlot(rawNpcTeam, 'p4');
			if (!p4Team.length || p4Team === p2Team) {
				throw new Error('--game-type multi 需要 --npc2，或 npc 文件内带 slot=p2/p4 字段');
			}
		} else {
			p4Team = pickSlot(rawNpc2Team, 'p4');
			if (!p4Team.length) p4Team = rawNpc2Team;
		}
	}

	const playerTeam = Teams.pack(limitTeamSize(rawPlayerTeam, maxTeamSize));
	const npcTeam = Teams.pack(limitTeamSize(p2Team, maxTeamSize));
	const player2Team = rawPlayer2Team ? Teams.pack(limitTeamSize(rawPlayer2Team, maxTeamSize)) : null;
	const npc2Team = p4Team ? Teams.pack(limitTeamSize(p4Team, maxTeamSize)) : null;

	if (isMulti && (!player2Team || !npc2Team)) {
		throw new Error('--game-type multi 需要 --player2 (p3 的队伍)');
	}

	const logLevel = LogLevel[args.logLevel];
	const battleIdPrefix = `sim-${Date.now()}`;

	const stream = new BattleStream({ debug: false });
	const streams = getPlayerStreams(stream);

	// ---------- 玩家策略 ----------
	const commonCtx = { seed: args.seed || null, trace: true };
	const p1 = makeStrategy(args.p1Strategy, {
		...commonCtx,
		stream: streams.p1,
		label: 'p1',
		script: args.p1Strategy === 'scripted' ? loadScript(args.scriptP1) : undefined,
		isMulti,
		formatId: args.format,
		mirrorDifficulty: args.npcDifficulty, // mirror 的 AI 等级跟随 npc 的难度
		mirrorOptions: args.p1Strategy === 'mirror-npc' ? {
			battleId: `${battleIdPrefix}-p1`,
			logging: { console: logLevel },
		} : undefined,
	});

	let p3: StrategyPlayer | null = null;
	if (isMulti) {
		p3 = makeStrategy(args.p3Strategy, {
			...commonCtx,
			stream: streams.p3,
			label: 'p3',
			script: args.p3Strategy === 'scripted' ? loadScript(args.scriptP3) : undefined,
			isMulti: true,
			formatId: args.format,
			mirrorDifficulty: args.npc2Difficulty,
			mirrorOptions: args.p3Strategy === 'mirror-npc' ? {
				battleId: `${battleIdPrefix}-p3`,
				logging: { console: logLevel },
			} : undefined,
		});
	}

	// ---------- NPC AI ----------
	const p2 = createNPC('p2', streams.p2, args.npcDifficulty, {
		formatId: args.format, logLevel, battleIdPrefix, isMulti,
	});
	if (args.debugAI) {
		const orig = (p2 as AnyObject).choose.bind(p2);
		(p2 as AnyObject).choose = (c: string) => { console.error(`[p2 npc] → ${c}`); return orig(c); };
	}

	let p4: BasicAI | NormalAI | null = null;
	if (isMulti) {
		p4 = createNPC('p4', streams.p4, args.npc2Difficulty, {
			formatId: args.format, logLevel, battleIdPrefix, isMulti,
		});
		if (args.debugAI) {
			const orig = (p4 as AnyObject).choose.bind(p4);
			(p4 as AnyObject).choose = (c: string) => { console.error(`[p4 npc] → ${c}`); return orig(c); };
		}
	}

	// 启动所有玩家
	void p1.start().catch(e => console.error('[p1 crashed]', e));
	void p2.start().catch(e => console.error('[p2 crashed]', e));
	if (p3) void p3.start().catch(e => console.error('[p3 crashed]', e));
	if (p4) void p4.start().catch(e => console.error('[p4 crashed]', e));

	// ---------- 协议日志 ----------
	let turn = 0;
	let ended = false;
	const dumpProtocol = async (): Promise<void> => {
		for await (const chunk of streams.omniscient) {
			process.stdout.write(chunk);
			process.stdout.write('\n\n');
			const m = chunk.match(/\|turn\|(\d+)/);
			if (m) turn = parseInt(m[1], 10);
			if (/\|win\|/.test(chunk) || /\|tie(\||$)/m.test(chunk)) ended = true;
			if (turn >= args.maxTurns) {
				console.error(`[runner] 达到 maxTurns=${args.maxTurns}，强制结束`);
				void streams.omniscient.write(`>forcetie`);
				ended = true;
			}
			if (ended) break;
		}
		if (args.debugAI) console.error(`[runner] omniscient loop exited (turn=${turn}, ended=${ended})`);
	};

	void dumpProtocol().then(() => {
		if ((p1 as AnyObject).close) (p1 as AnyObject).close();
		if (p3 && (p3 as AnyObject).close) (p3 as AnyObject).close();
		process.exit(0);
	}).catch(err => { console.error(err); process.exit(1); });

	// ---------- 启动战斗 ----------
	const spec: AnyObject = { formatid: args.format };
	if (args.seed) spec.seed = args.seed;

	const lines = [`>start ${JSON.stringify(spec)}`];
	lines.push(`>player p1 ${JSON.stringify({ name: 'Player', team: playerTeam })}`);
	lines.push(`>player p2 ${JSON.stringify({ name: 'NPC', team: npcTeam })}`);
	if (isMulti) {
		lines.push(`>player p3 ${JSON.stringify({ name: 'Player2', team: player2Team })}`);
		lines.push(`>player p4 ${JSON.stringify({ name: 'NPC2', team: npc2Team })}`);
	}
	void streams.omniscient.write(lines.join('\n'));
}

void main().catch(err => { console.error(err); process.exit(1); });
