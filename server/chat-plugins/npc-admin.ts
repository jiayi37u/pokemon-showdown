/**
 * NPC Admin —— 网页端管理 NPC 队伍。
 *
 * 入口：`/npcadmin` 页面；写操作要先用密钥解锁本 session。
 *
 * 页面结构：
 *   view-npcadmin                  —— 概览，列出所有 NPC + 队伍（队伍名+psicon）
 *   view-npcadmin-edit-FILENAME    —— 编辑单个队伍（队伍名、格式、所属 NPC + Teambuilder 文本）
 *   view-npcadmin-new              —— 新建队伍
 *
 * 命令（都要先 unlock）：
 *   /npcadmin unlock KEY           —— 解锁，30 分钟
 *   /npcadmin lock                 —— 立即锁回去
 *   /npcadmin reload               —— 重读 templates.json + teams/*.json
 *   /npcadmin team save fileName|name|format|gameType|npcId|teamText
 *                                   —— 保存（fileName 为空 → 新建；非空 → 编辑原文件）
 *   /npcadmin team delete fileName —— 从磁盘删掉 + 从 templates 摘掉
 *
 * 参数用 '|' 分隔是因为 team 文本里会有逗号；'|' 在 PS Export 里不出现。
 * 密钥硬编码 `963741`，仅适合单机开发；生产部署前应改成 Config / 权限系统。
 */

import { Teams, type PokemonSet } from '../../sim/teams';
import { Utils } from '../../lib';
import { Dex } from '../../sim/dex';
import { NPC, type NPCTemplate, type NPCTeamFile } from '../npc/manager';

const ADMIN_KEY = '963741';
const UNLOCK_TTL = 30 * 60 * 1000;

// `/npcadmin team save` 的参数会带整段 Teambuilder Export（多行）。PS 默认把多行消息判为 spam
// 并弹窗 "You're sending too many lines at once"，必须显式注册到 multiLinePattern 白名单。
// 见 server/chat-commands/core.ts:1822 的类似注册。
process.nextTick(() => {
	Chat.multiLinePattern.register('/npcadmin team save ');
});

/** userid → unlockTimestamp */
const unlockedUsers = new Map<string, number>();

function isUnlocked(user: User): boolean {
	const stamp = unlockedUsers.get(user.id);
	if (!stamp) return false;
	if (Date.now() - stamp > UNLOCK_TTL) {
		unlockedUsers.delete(user.id);
		return false;
	}
	return true;
}

function requireUnlock(user: User): void {
	if (!isUnlocked(user)) {
		throw new Chat.ErrorMessage(`管理功能已锁定，先用 \`/npcadmin unlock KEY\` 解锁（30 分钟有效）。`);
	}
}

/**
 * 转义 HTML 特殊字符用于 textarea 的 value，保留 \n 作为 &#13;（CR）而不是 Utils.escapeHTML
 * 默认把 \n 转成 <br/>（见 lib/utils.ts:55）。多行要维持原样显示。
 */
function escapeForTextarea(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;')
		.replace(/\n/g, '&#13;');
}

type GameType = 'singles' | 'doubles' | 'multi';
const GAME_TYPES: readonly GameType[] = ['singles', 'doubles', 'multi'];

/**
 * 把 Teams.import 的输出压回最紧凑形态，保持和 data/npc/teams/*.json 既有文件一致。
 * Teams.import 会填满默认字段（gender=''、ivs 全 31、level=100、evs 补 0），直接写盘会显得噪
 * 杂且让 git diff 爆炸，这里逐字段清理。
 *
 * 保留字段：species, ability, item, nature, teraType, happiness(非 255), moves, slot（Multi 用）
 *          evs（只留非 0）, ivs（只留非 31）, level（非 100）, gender（非空且非 N）, shiny（true）
 * 丢弃字段：name=='' 或等于 species；evs 全 0；ivs 全 31；happiness==255；
 */
function normalizeSet(set: AnyObject): AnyObject {
	const out: AnyObject = {};
	if (set.species) out.species = set.species;
	if (set.ability) out.ability = set.ability;
	if (set.item) out.item = set.item;
	if (set.nature) out.nature = set.nature;
	if (set.teraType) out.teraType = set.teraType;
	if (set.name && set.name !== set.species) out.name = set.name;
	if (set.gender && set.gender !== 'N') out.gender = set.gender;
	if (set.level && set.level !== 100) out.level = set.level;
	if (set.happiness !== undefined && set.happiness !== 255) out.happiness = set.happiness;
	if (set.shiny) out.shiny = set.shiny;
	if (set.hpType) out.hpType = set.hpType;
	if (set.dynamaxLevel !== undefined && set.dynamaxLevel !== 10) out.dynamaxLevel = set.dynamaxLevel;
	if (set.gigantamax) out.gigantamax = set.gigantamax;

	// EVs：只留非零
	if (set.evs) {
		const trimmed: AnyObject = {};
		for (const k of ['hp', 'atk', 'def', 'spa', 'spd', 'spe']) {
			if (set.evs[k]) trimmed[k] = set.evs[k];
		}
		if (Object.keys(trimmed).length) out.evs = trimmed;
	}
	// IVs：只留非 31
	if (set.ivs) {
		const trimmed: AnyObject = {};
		for (const k of ['hp', 'atk', 'def', 'spa', 'spd', 'spe']) {
			if (set.ivs[k] !== undefined && set.ivs[k] !== 31) trimmed[k] = set.ivs[k];
		}
		if (Object.keys(trimmed).length) out.ivs = trimmed;
	}

	if (set.moves?.length) out.moves = set.moves.filter((m: string) => !!m);
	if (set.slot) out.slot = set.slot; // multi battle 槽位

	return out;
}

function normalizeTeam(pokemon: AnyObject[]): AnyObject[] {
	return pokemon.map(normalizeSet);
}

/**
 * 格式化 NPCTeamFile 为仓库里既有文件相同的 JSON：
 *   - 顶层 { "format": "...", "pokemon": [ ... ] }，缩进 2 空格
 *   - 每只精灵的 evs / ivs / moves 字段**单行内联**，和手工文件一致
 *   - 其他字段按两空格缩进展开
 *   - 文件以单个换行结尾
 * 保留此函数的目的：让从管理面板保存的队伍 git-diff 友好、人眼可读
 */
function formatTeamJson(team: NPCTeamFile): string {
	const inlineKeys = new Set(['evs', 'ivs', 'moves']);
	const indent2 = '  ';
	const indent4 = '    ';
	const indent6 = '      ';

	const monLines: string[] = [];
	for (const mon of team.pokemon) {
		const fieldLines: string[] = [];
		for (const key of Object.keys(mon)) {
			const val = (mon as AnyObject)[key];
			if (inlineKeys.has(key)) {
				// 单行紧凑：{"hp":252,"atk":252} 风格会被 JSON.stringify 省掉空格；这里用 2 参数版本
				// 自己拼。保持 "{ "hp": 252, "atk": 252 }" 的风格。
				fieldLines.push(`${indent6}${JSON.stringify(key)}: ${inlineStringify(val)}`);
			} else {
				fieldLines.push(`${indent6}${JSON.stringify(key)}: ${JSON.stringify(val)}`);
			}
		}
		monLines.push(`${indent4}{\n${fieldLines.join(',\n')}\n${indent4}}`);
	}

	let buf = `{\n`;
	buf += `${indent2}${JSON.stringify('format')}: ${JSON.stringify(team.format)},\n`;
	if (team.name) {
		buf += `${indent2}${JSON.stringify('name')}: ${JSON.stringify(team.name)},\n`;
	}
	buf += `${indent2}${JSON.stringify('pokemon')}: [\n${monLines.join(',\n')}\n${indent2}]\n`;
	buf += `}\n`;
	return buf;
}

/** 行内 JSON：{"a":1,"b":2} → "{ \"a\": 1, \"b\": 2 }"；数组 ["x","y"] → "[\"x\", \"y\"]"。 */
function inlineStringify(val: AnyObject | AnyObject[]): string {
	if (Array.isArray(val)) {
		return `[${val.map(v => JSON.stringify(v)).join(', ')}]`;
	}
	if (val && typeof val === 'object') {
		const parts: string[] = [];
		for (const k of Object.keys(val)) {
			parts.push(`${JSON.stringify(k)}: ${JSON.stringify((val as AnyObject)[k])}`);
		}
		return `{ ${parts.join(', ')} }`;
	}
	return JSON.stringify(val);
}


function parseGameType(input: string): GameType {
	const g = input.trim().toLowerCase() as GameType;
	if (!GAME_TYPES.includes(g)) {
		throw new Chat.ErrorMessage(`游戏类型必须是 singles / doubles / multi，收到 "${input}"`);
	}
	return g;
}

function nextTeamFileName(npcId: string, format: string, existing: string[]): string {
	const base = `${npcId}-${format}`;
	const used = new Set(existing);
	for (let i = 1; i < 1000; i++) {
		const name = `${base}-${i}.json`;
		if (!used.has(name)) return name;
	}
	throw new Error('team filename counter overflow');
}

function getTeamSlot(template: NPCTemplate, gameType: GameType, format: string): string[] {
	if (!template.teams[gameType]) template.teams[gameType] = {};
	const bucket = template.teams[gameType]!;
	if (!bucket[format]) bucket[format] = [];
	return bucket[format];
}

function removeTeamFromAllTemplates(templates: { [id: string]: NPCTemplate }, teamFile: string): string[] {
	const affected: string[] = [];
	for (const id of Object.keys(templates)) {
		const t = templates[id];
		for (const gt of GAME_TYPES) {
			const bucket = t.teams[gt];
			if (!bucket) continue;
			for (const format of Object.keys(bucket)) {
				const idx = bucket[format].indexOf(teamFile);
				if (idx >= 0) {
					bucket[format].splice(idx, 1);
					affected.push(`${id}/${gt}/${format}`);
					if (bucket[format].length === 0) delete bucket[format];
				}
			}
		}
	}
	return affected;
}

function parseImportedTeam(text: string): PokemonSet[] {
	const sets = Teams.import(text.trim());
	if (!sets?.length) {
		throw new Chat.ErrorMessage(`无法解析队伍文本，请确认粘贴的是 PS Teambuilder 的 Export 格式。`);
	}
	return sets;
}

/** 在 templates 里挂上/移动 teamFile 到指定 NPC / gameType / format，顺手把其他地方的同名引用清掉 */
function reattachTeamFile(
	templates: { [id: string]: NPCTemplate },
	teamFile: string,
	npcId: string,
	gameType: GameType,
	format: string
): void {
	// 先清掉所有旧挂载
	removeTeamFromAllTemplates(templates, teamFile);
	const template = templates[npcId];
	if (!template) throw new Chat.ErrorMessage(`NPC 不存在：${npcId}`);
	const slot = getTeamSlot(template, gameType, format);
	slot.push(teamFile);
}

/** 用 '|' 拆分 team save 的参数。前 5 段 | 为元数据，之后全是 team body（body 自己可以含 |）。 */
function parseSaveTarget(target: string): {
	fileName: string; name: string; format: string; gameType: GameType; npcId: string; teamText: string;
} {
	// 用 '|' 分段：fileName|name|format|gameType|npcId|teamText...
	const parts: string[] = [];
	let rest = target;
	for (let i = 0; i < 5; i++) {
		const idx = rest.indexOf('|');
		if (idx < 0) throw new Chat.ErrorMessage(`参数格式错误：期望 6 段以 '|' 分隔`);
		parts.push(rest.slice(0, idx));
		rest = rest.slice(idx + 1);
	}
	parts.push(rest); // teamText 可能自身含 '|'，整段取
	const [fileName, name, format, gameTypeRaw, npcId, teamText] = parts.map(s => s.trim());
	return {
		fileName: fileName.trim(),
		name: name.trim(),
		format: toID(format),
		gameType: parseGameType(gameTypeRaw),
		npcId: toID(npcId),
		teamText,
	};
}

// =============================================================================
// Commands
// =============================================================================

export const commands: Chat.ChatCommands = {
	npcadmin: {
		''(target, room, user) {
			return this.parse(`/j view-npcadmin`);
		},

		unlock(target, room, user) {
			if (target.trim() !== ADMIN_KEY) {
				return this.errorReply(`密钥不正确。`);
			}
			unlockedUsers.set(user.id, Date.now());
			this.sendReply(`✓ NPC 管理已解锁（30 分钟）。`);
			return this.parse(`/j view-npcadmin`);
		},

		lock(target, room, user) {
			unlockedUsers.delete(user.id);
			this.sendReply(`✓ NPC 管理已锁定。`);
		},

		reload(target, room, user) {
			requireUnlock(user);
			NPC.reload();
			this.sendReply(`✓ NPC 配置已重载（共 ${NPC.count} 个 NPC）。`);
		},

		team: {
			save(target, room, user) {
				requireUnlock(user);
				const { fileName, name, format, gameType, npcId, teamText } = parseSaveTarget(target);
				if (!npcId) return this.errorReply(`请先选择 "所属 NPC"。`);
				if (!format) return this.errorReply(`请先选择 "格式"。`);
				const pokemon = parseImportedTeam(teamText);

				const templates = NPC.readTemplatesRaw();
				const template = templates[npcId];
				if (!template) return this.errorReply(`NPC 不存在：${npcId}`);

				// Multi 场景的 slot 字段是我们自定义的，不走 PS Teambuilder，所以 Teams.import
				// 后会丢失。编辑现有文件时按索引搬运旧 slot；新文件则没有 slot（Multi 新建需要
				// 后续另行处理）。
				const prevContent = fileName ? NPC.readTeamFile(fileName) : null;
				const prevSlots = (prevContent?.pokemon || []).map((p: AnyObject) => (p as AnyObject).slot);
				const normalized = normalizeTeam(pokemon);
				for (let i = 0; i < normalized.length; i++) {
					if (prevSlots[i]) normalized[i].slot = prevSlots[i];
				}

				// 决定文件名：空 → 新建；非空 → 覆盖已有
				let finalFileName = fileName;
				if (!finalFileName) {
					const slot = getTeamSlot(template, gameType, format);
					finalFileName = nextTeamFileName(npcId, format, slot);
				} else {
					// 既有文件：如果 npc/format/gameType 变了，要重新挂载
				}

				const content: NPCTeamFile = { format, pokemon: normalized as any };
				if (name) content.name = name;
				NPC.writeTeamFile(finalFileName, formatTeamJson(content));

				reattachTeamFile(templates, finalFileName, npcId, gameType, format);
				NPC.writeTemplates(templates);
				NPC.reload();

				this.sendReply(
					`✓ 已保存 ${finalFileName}（${template.name} · ${gameType}/${format}` +
					`${name ? ` · ${name}` : ''}，${pokemon.length} 只精灵）。`
				);
				return this.parse(`/j view-npcadmin`);
			},

			delete(target, room, user) {
				requireUnlock(user);
				const fileName = target.trim();
				if (!fileName) return this.errorReply(`用法：/npcadmin team delete fileName`);

				const templates = NPC.readTemplatesRaw();
				const affected = removeTeamFromAllTemplates(templates, fileName);
				NPC.writeTemplates(templates);
				const deleted = NPC.deleteTeamFile(fileName);
				NPC.reload();

				if (!deleted && !affected.length) {
					return this.errorReply(`${fileName} 不存在。`);
				}
				this.sendReply(
					`✓ 已删除 ${fileName}` +
					(affected.length ? `（从 ${affected.join(', ')} 摘掉）` : '')
				);
				return this.parse(`/j view-npcadmin`);
			},
		},
	},
};

// =============================================================================
// Pages
// =============================================================================

function renderPsicons(pokemon: PokemonSet[]): string {
	return pokemon.map(p => `<psicon pokemon="${Utils.escapeHTML(p.species)}" />`).join('');
}

function renderUnlockBar(user: User): string {
	const unlocked = isUnlocked(user);
	let buf = ``;
	if (!unlocked) {
		buf += `<p style="color:#c00"><strong>当前未解锁</strong>。写操作被禁用。</p>`;
		buf += `<p>在聊天框输入 <code>/npcadmin unlock 你的密钥</code> 解锁 30 分钟。</p>`;
	} else {
		const left = Math.floor((UNLOCK_TTL - (Date.now() - (unlockedUsers.get(user.id) || 0))) / 60000);
		buf += `<p style="color:#060"><strong>✓ 已解锁</strong>（剩 ${left} 分钟）。`;
		buf += ` <button class="button" name="send" value="/npcadmin lock">锁定</button>`;
		buf += ` <button class="button" name="send" value="/npcadmin reload">重载缓存</button></p>`;
	}
	return buf;
}

/** 概览页：所有 NPC + 其队伍 */
function renderOverview(user: User): string {
	const unlocked = isUnlocked(user);
	let buf = `<div class="pad">`;
	buf += `<h2>NPC 管理面板</h2>`;
	buf += renderUnlockBar(user);
	buf += `<p>`;
	buf += `<button class="button" name="send" value="/npcadmin"><i class="fa fa-refresh"></i> 刷新</button> `;
	if (unlocked) {
		buf += `<a class="button notifying" target="replace" href="/view-npcadmin-new"><i class="fa fa-plus"></i> 新建队伍</a>`;
	}
	buf += `</p><hr/>`;

	const npcs = NPC.getAll();
	if (!npcs.length) {
		buf += `<p>尚未定义任何 NPC。</p></div>`;
		return buf;
	}

	for (const npc of npcs) {
		buf += `<details open><summary><strong>${Utils.escapeHTML(npc.name)}</strong>`;
		buf += ` <small>(${npc.id})</small>`;
		if (npc.title) buf += ` <small>— ${Utils.escapeHTML(npc.title)}</small>`;
		buf += `</summary>`;

		for (const gt of GAME_TYPES) {
			const bucket = npc.teams[gt];
			if (!bucket) continue;
			for (const format of Object.keys(bucket)) {
				const files = bucket[format];
				if (!files?.length) continue;
				buf += `<div style="margin:4px 0 4px 12px"><em>${gt} / ${Utils.escapeHTML(format)}</em>`;
				buf += `<table style="margin-left:12px"><tbody>`;
				for (const file of files) {
					const content = NPC.readTeamFile(file);
					const name = content?.name || '(未命名)';
					const icons = content?.pokemon ? renderPsicons(content.pokemon) : '';
					buf += `<tr>`;
					buf += `<td style="min-width:160px"><strong>${Utils.escapeHTML(name)}</strong></td>`;
					buf += `<td style="padding:0 8px">${icons}</td>`;
					buf += `<td>`;
					if (unlocked) {
						buf += `<a class="button" target="replace" href="/view-npcadmin-edit-${file}">编辑</a> `;
						buf += `<button class="button" name="send" value="/npcadmin team delete ${file}">删除</button>`;
					} else {
						buf += `<a class="button" target="replace" href="/view-npcadmin-edit-${file}">查看</a>`;
					}
					buf += `</td></tr>`;
				}
				buf += `</tbody></table></div>`;
			}
		}

		// randombattle 没有对应的队伍文件（PS 自动生成），不在管理面板里展示
		buf += `</details>`;
	}

	buf += `</div>`;
	return buf;
}

/** 编辑/查看单个队伍文件；没有 fileName 时渲染新建 */
function renderEdit(user: User, fileName: string | null): string {
	const unlocked = isUnlocked(user);
	const npcs = NPC.getAll();
	const content = fileName ? NPC.readTeamFile(fileName) : null;

	// 找出该文件当前挂在哪里：决定 npcId / gameType
	let currentNpcId = '';
	let currentGameType: GameType = 'singles';
	if (fileName) {
		for (const npc of npcs) {
			for (const gt of GAME_TYPES) {
				const bucket = npc.teams[gt];
				if (!bucket) continue;
				for (const format of Object.keys(bucket)) {
					if (bucket[format].includes(fileName)) {
						currentNpcId = npc.id;
						currentGameType = gt;
						break;
					}
				}
			}
		}
	}
	const currentFormat = content?.format || '';
	const currentName = content?.name || '';
	// textarea 的多行文本：必须用 &#13;（CR）作换行；Utils.escapeHTML 默认把 \n 转成 <br/>（见
	// lib/utils.ts:55），不能用，自己写一个只转义 HTML 特殊字符的版本。
	const currentText = content?.pokemon ? Teams.export(content.pokemon) : '';
	const currentTextForTextarea = escapeForTextarea(currentText);

	let buf = `<div class="pad">`;
	// 返回列表：用 target="replace" 的 <a> 替换当前页面，比 /j 按钮更可靠
	buf += `<p><a class="button" target="replace" href="/view-npcadmin">← 返回列表</a></p>`;
	buf += `<h2>${fileName ? '编辑队伍' : '新建队伍'}</h2>`;
	if (fileName) buf += `<p><small>文件：<code>${Utils.escapeHTML(fileName)}</code></small></p>`;
	buf += renderUnlockBar(user);

	if (!unlocked) {
		// 只读显示
		buf += `<p><strong>队伍名称：</strong>${Utils.escapeHTML(currentName || '(未命名)')}</p>`;
		buf += `<p><strong>格式：</strong>${Utils.escapeHTML(currentFormat)}</p>`;
		buf += `<p><strong>game-type：</strong>${currentGameType}</p>`;
		buf += `<p><strong>所属 NPC：</strong>${Utils.escapeHTML(currentNpcId || '(未关联)')}</p>`;
		buf += `<pre style="background:#f0f0f0;padding:8px;max-height:600px;overflow:auto">${
			Utils.escapeHTML(currentText) || '(无内容)'
		}</pre>`;
		buf += `</div>`;
		return buf;
	}

	// 已解锁：表单。
	// 字段：name / format / gameType / team
	// NPC 归属：只在"新建"场景可以选；"编辑现有"直接沿用已挂载的 NPC（放 hidden）
	buf += `<form data-submitsend="/npcadmin team save ${fileName || ''}|{name}|{format}|{gameType}|{npcId}|{team}">`;
	buf += `<p><label>队伍名称：<input class="textbox" name="name" value="${Utils.escapeHTML(currentName)}" style="width:300px" placeholder="例：沙暴地龙队" /></label></p>`;

	if (!fileName) {
		// 新建：选 NPC。放一个占位 option 强制用户显式选择，避免误用默认（首个 NPC）保存。
		buf += `<p><label>所属 NPC：<select name="npcId" required>`;
		buf += `<option value="" selected disabled>-- 请选择 NPC --</option>`;
		for (const npc of npcs) {
			buf += `<option value="${npc.id}">${Utils.escapeHTML(npc.name)} (${npc.id})</option>`;
		}
		buf += `</select></label></p>`;
	} else {
		// 编辑：锁定 NPC
		buf += `<input type="hidden" name="npcId" value="${Utils.escapeHTML(currentNpcId)}" />`;
		buf += `<p><strong>所属 NPC：</strong>${Utils.escapeHTML(currentNpcId)} <small>（创建后不可修改，如需转移请新建一个队伍）</small></p>`;
	}

	// game-type：从当前已选 format 自动推断，不让用户单独选（降低误配概率）。
	// 保留 hidden input 以便 save 时后端拿到；渲染时根据 format 实时推断。
	// 实际上后端 save 处理里会再次校验 format 对应的 gameType，这里只是让 UI 保持简单。
	const inferredGameType = (() => {
		if (!currentFormat) return currentGameType;
		const f = Dex.formats.get(currentFormat);
		const gt = (f.gameType as GameType) || 'singles';
		return gt === 'multi' || gt === 'doubles' || gt === 'singles' ? gt : 'singles';
	})();
	buf += `<input type="hidden" name="gameType" value="${inferredGameType}" />`;

	// 格式：复用 PS 原生 Teambuilder 的 formatselect 按钮（panel-teambuilder-team.tsx:342）。
	// `class="select formatselect"` + `data-href="/formatdropdown"` 让 PS 客户端在点击时
	// 弹出官方格式选择面板。按钮本身 `name="format"` + `value=currentFormat`，form 提交时
	// 自动把 value 作为 format 字段发给我们。
	const currentFormatObj = currentFormat ? Dex.formats.get(currentFormat) : null;
	const currentFormatName = currentFormatObj?.name || currentFormat || '(未选)';
	buf += `<p><label>格式：<button type="button" name="format" value="${Utils.escapeHTML(currentFormat)}" ` +
		`class="select formatselect" data-href="/formatdropdown" data-selecttype="teambuilder">` +
		`<i class="fa fa-folder-o"></i> ${Utils.escapeHTML(currentFormatName)}</button>` +
		`</label></p>`;

	// 队伍文本框
	buf += `<p><strong>队伍 (PS Teambuilder Export 文本):</strong></p>`;
	buf += `<textarea name="team" style="width:100%;min-height:400px;font-family:monospace;font-size:12px" placeholder="直接从 PS Teambuilder 的 Import/Export 复制过来">${currentTextForTextarea}</textarea>`;

	buf += `<p>`;
	buf += `<button class="button notifying" type="submit">保存</button> `;
	if (fileName) {
		buf += ` <button class="button" name="send" value="/npcadmin team delete ${fileName}" style="color:#c00">删除此队伍</button>`;
	}
	buf += `</p>`;
	buf += `</form>`;
	buf += `</div>`;
	return buf;
}

export const pages: Chat.PageTable = {
	npcadmin(query, user) {
		this.title = '[NPC 管理]';
		const [sub, ...rest] = query;
		if (!sub) return renderOverview(user);
		if (sub === 'new') return renderEdit(user, null);
		if (sub === 'edit') {
			const fileName = rest.join('-');
			return renderEdit(user, fileName);
		}
		return renderOverview(user);
	},
};
