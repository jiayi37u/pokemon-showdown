/**
 * NPC Manager
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Manages NPC templates and teams for NPC battles.
 *
 * @license MIT
 */

import { FS } from '../../lib';
import type { PokemonSet } from '../../sim/teams';
import { Dex } from '../../sim/dex';

/**
 * NPC 的队伍配置。
 *
 * 新 schema（v1.2.26+）：
 *   - `teams`: 该 NPC 持有的所有自定义队伍文件名（相对 data/npc/teams/）
 *   - `randomFormats`: 支持的随机对战格式（PS 原生生成队伍，无文件）
 *
 * 每个队伍文件自己带 `formats: string[]`，运行时按 formatId 筛选出合适的队伍。
 *
 * 加载时 normalizeTeamConfig 会把旧 schema（嵌套 singles/doubles/multi 字典）转换过来。
 */
export interface NPCTemplate {
	id: string;
	name: string;
	avatar: string;
	title?: string;
	description?: string;
	difficulty: 'random' | 'basic' | 'smart' | 'expert';
	/** 该 NPC 持有的所有自定义队伍文件 */
	teams: string[];
	/** 支持的随机对战格式 */
	randomFormats: string[];
	customRules?: string[];
}

/** Multi battle team with slot assignments */
export interface MultiTeam {
	p2: PokemonSet[];
	p4: PokemonSet[];
}

/**
 * NPC 队伍文件格式（新 schema）。
 *
 * `formats` 是**该队伍能用的所有分级 ID**；添加分级前必须通过 TeamValidator 校验。
 * `name` 是中文显示名。
 *
 * 读文件时如果只找到旧的 `format: "x"` 字段，自动当作 `formats: ["x"]` 处理。
 */
export interface NPCTeamFile {
	formats: string[];
	pokemon: PokemonSet[];
	name?: string;
	// 旧字段，加载后 normalize 掉
	format?: string;
}

/**
 * Check if format is a random battle format
 */
function isRandomBattleFormat(format: string): boolean {
	return format.includes('randombattle') || format.includes('randomdoubles');
}

/** 从一个 Pokemon file 的 raw JSON 补齐到新 schema。空输入返回 null。 */
function normalizeTeamFile(raw: AnyObject | null): NPCTeamFile | null {
	if (!raw) return null;
	if (!raw.pokemon?.length) return null;
	if (Array.isArray(raw.formats) && raw.formats.length) {
		return { formats: raw.formats, pokemon: raw.pokemon, name: raw.name };
	}
	if (typeof raw.format === 'string' && raw.format) {
		return { formats: [raw.format], pokemon: raw.pokemon, name: raw.name };
	}
	return { formats: [], pokemon: raw.pokemon, name: raw.name };
}

/**
 * 把 template 的 teams/randomFormats 字段归一到新 schema。
 * 既接受新 schema 的字符串数组 + randomFormats 字段，也接受旧 schema 的嵌套字典。
 */
function normalizeTemplate(raw: AnyObject): { teams: string[]; randomFormats: string[] } {
	// 新 schema（flat）
	if (Array.isArray(raw.teams)) {
		return { teams: raw.teams, randomFormats: raw.randomFormats || [] };
	}
	// 过渡 schema：teams.teams + teams.randomFormats（这是 v1.2.25 的误实现，兼容一下）
	if (raw.teams && Array.isArray(raw.teams.teams)) {
		return {
			teams: raw.teams.teams,
			randomFormats: raw.teams.randomFormats || raw.teams.randombattle || [],
		};
	}
	// 旧 schema：嵌套字典
	const cfg = raw.teams || {};
	const seen = new Set<string>();
	const teams: string[] = [];
	for (const bucketKey of ['singles', 'doubles', 'multi'] as const) {
		const bucket = cfg[bucketKey];
		if (!bucket) continue;
		for (const format of Object.keys(bucket)) {
			const files = bucket[format];
			if (!Array.isArray(files)) continue;
			for (const f of files) {
				if (!seen.has(f)) {
					seen.add(f);
					teams.push(f);
				}
			}
		}
	}
	return { teams, randomFormats: cfg.randombattle || [] };
}

/**
 * NPCManager - Manages NPC templates and teams
 */
export class NPCManager {
	/** Loaded templates */
	private templates: Map<string, NPCTemplate> = new Map();

	/** Data directory path */
	private readonly dataPath = 'data/npc';

	/** Number of loaded templates */
	get count(): number {
		return this.templates.size;
	}

	/**
	 * Load all NPC templates from templates.json
	 *
	 * 读入时对每个 template 的 teams 字段做 normalizeTeamConfig —— 旧 schema（嵌套 singles/
	 * doubles/multi 字典）会被扁平成新 schema（flat teams: string[]）。磁盘上文件可以是任一
	 * 形态，内存里永远是新 schema。
	 */
	loadTemplates(): void {
		try {
			const templatesPath = `${this.dataPath}/templates.json`;
			const data = FS(templatesPath).readIfExistsSync();

			if (!data) {
				console.log('[NPC] No templates.json found, skipping NPC initialization');
				return;
			}

			const raw = JSON.parse(data) as { [id: string]: AnyObject };

			this.templates.clear();
			for (const id in raw) {
				const r = raw[id];
				const { teams, randomFormats } = normalizeTemplate(r);
				const template: NPCTemplate = {
					id,
					name: r.name,
					avatar: r.avatar,
					title: r.title,
					description: r.description,
					difficulty: r.difficulty,
					teams,
					randomFormats,
					customRules: r.customRules,
				};
				this.templates.set(id, template);
			}

			console.log(`[NPC] Loaded ${this.templates.size} NPC templates`);
		} catch (err) {
			console.error('[NPC] Failed to load templates:', err);
		}
	}

	/**
	 * Get a template by ID
	 */
	get(id: string): NPCTemplate | null {
		return this.templates.get(id) || null;
	}

	/**
	 * Get all templates
	 */
	getAll(): NPCTemplate[] {
		return Array.from(this.templates.values());
	}

	/**
	 * Get a random NPC template
	 */
	getRandom(): NPCTemplate | null {
		const templates = this.getAll();
		if (templates.length === 0) return null;
		return templates[Math.floor(Math.random() * templates.length)];
	}

	/**
	 * Check if NPC supports a format.
	 *
	 * 新实现：遍历 template.teams[] 读每个 team 文件的 formats；或 randomFormats 直接包含。
	 */
	supportsFormat(npcId: string, format: string): boolean {
		const template = this.get(npcId);
		if (!template) return false;

		if (isRandomBattleFormat(format)) {
			return template.randomFormats.includes(format);
		}
		return this.findTeamFilesForFormat(template, format).length > 0;
	}

	/**
	 * 列出该 NPC 下所有在给定 format 下有效的队伍文件名。
	 * 空列表 = 没有支持该格式的队伍。
	 */
	private findTeamFilesForFormat(template: NPCTemplate, format: string): string[] {
		const files: string[] = [];
		for (const file of template.teams) {
			const content = this.readTeamFile(file);
			if (!content) continue;
			if (content.formats.includes(format)) files.push(file);
		}
		return files;
	}

	/**
	 * Get NPC team for a format (randomly selects from available teams).
	 * 随机对战格式返回 null，调用方用系统生成。
	 */
	getTeam(npcId: string, format: string): PokemonSet[] | null {
		const template = this.get(npcId);
		if (!template) {
			console.error(`[NPC] getTeam: Template not found for npcId=${npcId}`);
			return null;
		}
		if (isRandomBattleFormat(format)) return null;

		const files = this.findTeamFilesForFormat(template, format);
		if (!files.length) {
			console.error(`[NPC] getTeam: no team supports format=${format} for npcId=${npcId}`);
			return null;
		}
		const file = files[Math.floor(Math.random() * files.length)];
		const content = this.readTeamFile(file);
		if (!content) return null;
		console.log(`[NPC] getTeam: selected ${file} (${content.pokemon.length} Pokemon) for ${format}`);
		return content.pokemon;
	}

	/**
	 * Get NPC multi-battle team for a format.
	 *
	 * Multi 规则：**不读 slot 字段**，直接按 `pokemon` 数组顺序前 3 只分 p2，后 3 只分 p4。
	 * 这和 npc-admin 保存时的规则对称，用户在 Teambuilder Export 文本里自己把握顺序。
	 */
	getMultiTeam(npcId: string, format: string): MultiTeam | null {
		const template = this.get(npcId);
		if (!template) return null;

		const files = this.findTeamFilesForFormat(template, format);
		if (!files.length) {
			console.error(`[NPC] getMultiTeam: no team supports format=${format} for npcId=${npcId}`);
			return null;
		}
		const file = files[Math.floor(Math.random() * files.length)];
		const content = this.readTeamFile(file);
		if (!content) return null;

		const pokemon = content.pokemon;
		// 兼容旧数据：如果精灵自带 slot 字段，优先按 slot 分组；否则按前 3 后 3 的规则。
		let p2Team: PokemonSet[] = [];
		let p4Team: PokemonSet[] = [];
		const hasSlots = pokemon.some(p => (p as AnyObject).slot);
		if (hasSlots) {
			for (const poke of pokemon) {
				const slot = (poke as AnyObject).slot;
				const clean = { ...poke };
				delete (clean as AnyObject).slot;
				if (slot === 'p2') p2Team.push(clean);
				else if (slot === 'p4') p4Team.push(clean);
			}
			if (p2Team.length !== 3 || p4Team.length !== 3) {
				// 落回按顺序切分，和新规则一致
				p2Team = pokemon.slice(0, 3).map(p => ({ ...p, slot: undefined } as AnyObject)) as PokemonSet[];
				p4Team = pokemon.slice(3, 6).map(p => ({ ...p, slot: undefined } as AnyObject)) as PokemonSet[];
			}
		} else {
			p2Team = pokemon.slice(0, 3);
			p4Team = pokemon.slice(3, 6);
		}

		if (p2Team.length !== 3 || p4Team.length !== 3) {
			console.warn(`[NPC] getMultiTeam: expected 6 pokemon in ${file}, got ${pokemon.length}`);
		}
		return { p2: p2Team, p4: p4Team };
	}

	/**
	 * Get supported formats for an NPC.
	 * 聚合所有 team 文件的 formats + randomFormats。
	 */
	getSupportedFormats(npcId: string): string[] {
		const template = this.get(npcId);
		if (!template) return [];
		const seen = new Set<string>();
		for (const file of template.teams) {
			const content = this.readTeamFile(file);
			if (!content) continue;
			for (const f of content.formats) seen.add(f);
		}
		for (const f of template.randomFormats) seen.add(f);
		return [...seen];
	}

	/**
	 * Admin：读单个队伍文件。
	 * 返回值已经被 normalizeTeamFile 处理：旧的 `format: "x"` 会被转成 `formats: ["x"]`。
	 */
	readTeamFile(teamFile: string): NPCTeamFile | null {
		try {
			const teamPath = `${this.dataPath}/teams/${teamFile}`;
			const data = FS(teamPath).readIfExistsSync();
			if (!data) return null;
			const raw = JSON.parse(data);
			return normalizeTeamFile(raw);
		} catch (err) {
			console.error(`[NPC] readTeamFile(${teamFile}) failed:`, err);
			return null;
		}
	}

	/**
	 * Admin：写一个队伍文件。只校验 teamFile 不含 "/" 等路径分隔符，避免逃逸。
	 * 第二参数支持两种形态：
	 *   - NPCTeamFile 对象：按 JSON.stringify(..., null, 2) 默认序列化
	 *   - 字符串：直接作为文件内容写入（调用方自定义格式；用于保持仓库里既有
	 *     文件的"evs/ivs/moves 单行内联"风格）
	 */
	writeTeamFile(teamFile: string, content: NPCTeamFile | string): void {
		if (!/^[a-zA-Z0-9._-]+\.json$/.test(teamFile)) {
			throw new Error(`invalid team filename: ${teamFile}`);
		}
		const teamPath = `${this.dataPath}/teams/${teamFile}`;
		const text = typeof content === 'string' ? content : (JSON.stringify(content, null, 2) + '\n');
		FS(teamPath).writeSync(text);
	}

	/**
	 * Admin：删除一个队伍文件。
	 */
	deleteTeamFile(teamFile: string): boolean {
		if (!/^[a-zA-Z0-9._-]+\.json$/.test(teamFile)) {
			throw new Error(`invalid team filename: ${teamFile}`);
		}
		const teamPath = `${this.dataPath}/teams/${teamFile}`;
		const fs = FS(teamPath);
		if (!fs.existsSync()) return false;
		fs.unlinkIfExistsSync();
		return true;
	}

	/**
	 * Admin：覆盖写 templates.json（整体保存）。
	 */
	writeTemplates(templates: { [id: string]: NPCTemplate }): void {
		const templatesPath = `${this.dataPath}/templates.json`;
		FS(templatesPath).writeSync(JSON.stringify(templates, null, 2) + '\n');
	}

	/**
	 * Admin：读 templates.json 的原始对象（含注释/完整结构）。
	 */
	readTemplatesRaw(): { [id: string]: NPCTemplate } {
		const templatesPath = `${this.dataPath}/templates.json`;
		const data = FS(templatesPath).readIfExistsSync();
		if (!data) return {};
		return JSON.parse(data) as { [id: string]: NPCTemplate };
	}

	/**
	 * Reload templates
	 */
	reload(): void {
		this.loadTemplates();
	}
}

/** Global NPC manager instance */
export const NPC = new NPCManager();
