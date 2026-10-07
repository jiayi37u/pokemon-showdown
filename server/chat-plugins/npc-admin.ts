/**
 * NPC Admin —— 网页端管理 NPC 队伍。
 *
 * 页面：
 *   view-npcadmin                 —— 概览，列出所有 NPC + 其队伍
 *   view-npcadmin-edit-FILENAME   —— 编辑单个队伍
 *   view-npcadmin-new             —— 新建队伍
 *
 * 新 schema：一支队伍文件自己带 formats: string[]（可以同时属于多个分级）。
 *   - 保存（name + pokemon）走 /npcadmin team save
 *   - 验证某个分级是否兼容走 /npcadmin team validate
 *   - 把验证通过的分级挂到队伍走 /npcadmin team addformat
 *   - 从队伍摘掉某个分级走 /npcadmin team removeformat
 *
 * 新建队伍时需要指定一个"所属 NPC"；队伍绑定 NPC 后不可换。
 *
 * 密钥硬编码 `963741`，仅适合单机开发；生产部署前应改成 Config / 权限系统。
 */

import { Teams, type PokemonSet } from '../../sim/teams';
import { TeamValidator } from '../../sim/team-validator';
import { Utils } from '../../lib';
import { Dex } from '../../sim/dex';
import { NPC, type NPCTemplate, type NPCTeamFile } from '../npc/manager';

const ADMIN_KEY = '963741';
const UNLOCK_TTL = 30 * 60 * 1000;

// `/npcadmin team save` 的参数带整段 Teambuilder Export（多行）。PS 对多行命令默认当 spam，
// 必须显式注册到 multiLinePattern 白名单。见 server/chat-commands/core.ts:1822 的类似注册。
process.nextTick(() => {
	Chat.multiLinePattern.register('/npcadmin team save ');
});

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

// =============================================================================
// Pokemon set normalization / serialization —— 保持 git-diff 友好
// =============================================================================

/**
 * 把 Teams.import 的输出压回最紧凑形态，和手工文件一致。Teams.import 会填满默认字段，
 * 直接写盘会显得噪杂且让 git diff 爆炸。
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

	if (set.evs) {
		const trimmed: AnyObject = {};
		for (const k of ['hp', 'atk', 'def', 'spa', 'spd', 'spe']) {
			if (set.evs[k]) trimmed[k] = set.evs[k];
		}
		if (Object.keys(trimmed).length) out.evs = trimmed;
	}
	if (set.ivs) {
		const trimmed: AnyObject = {};
		for (const k of ['hp', 'atk', 'def', 'spa', 'spd', 'spe']) {
			if (set.ivs[k] !== undefined && set.ivs[k] !== 31) trimmed[k] = set.ivs[k];
		}
		if (Object.keys(trimmed).length) out.ivs = trimmed;
	}

	if (set.moves?.length) out.moves = set.moves.filter((m: string) => !!m);
	return out;
}

function normalizeTeam(pokemon: AnyObject[]): AnyObject[] {
	return pokemon.map(normalizeSet);
}

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

/**
 * 格式化 NPCTeamFile 为仓库里既有文件相同的 JSON：
 *   - 顶层 { name?, formats, pokemon }，缩进 2 空格
 *   - 每只精灵的 evs / ivs / moves 字段**单行内联**，和手工文件一致
 *   - formats 数组也单行内联
 *   - 文件以单个换行结尾
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
				fieldLines.push(`${indent6}${JSON.stringify(key)}: ${inlineStringify(val)}`);
			} else {
				fieldLines.push(`${indent6}${JSON.stringify(key)}: ${JSON.stringify(val)}`);
			}
		}
		monLines.push(`${indent4}{\n${fieldLines.join(',\n')}\n${indent4}}`);
	}

	let buf = `{\n`;
	if (team.name) {
		buf += `${indent2}${JSON.stringify('name')}: ${JSON.stringify(team.name)},\n`;
	}
	buf += `${indent2}${JSON.stringify('formats')}: ${inlineStringify(team.formats)},\n`;
	buf += `${indent2}${JSON.stringify('pokemon')}: [\n${monLines.join(',\n')}\n${indent2}]\n`;
	buf += `}\n`;
	return buf;
}

// =============================================================================
// 文件名生成 & templates 操作
// =============================================================================

function nextTeamFileName(npcId: string, baseHint: string, existing: Set<string>): string {
	const safe = (baseHint || 'team').replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'team';
	for (let i = 1; i < 1000; i++) {
		const name = `${npcId}-${safe}-${i}.json`;
		if (!existing.has(name)) return name;
	}
	throw new Error('team filename counter overflow');
}

function parseImportedTeam(text: string): PokemonSet[] {
	const sets = Teams.import(text.trim());
	if (!sets?.length) {
		throw new Chat.ErrorMessage(`无法解析队伍文本，请确认粘贴的是 PS Teambuilder 的 Export 格式。`);
	}
	return sets;
}

/** 用 '|' 拆分 team save 的参数：fileName|name|npcId|teamText(可能含 |) */
function parseSaveTarget(target: string): {
	fileName: string; name: string; npcId: string; teamText: string;
} {
	const parts: string[] = [];
	let rest = target;
	for (let i = 0; i < 3; i++) {
		const idx = rest.indexOf('|');
		if (idx < 0) throw new Chat.ErrorMessage(`参数格式错误：期望 4 段以 '|' 分隔`);
		parts.push(rest.slice(0, idx));
		rest = rest.slice(idx + 1);
	}
	parts.push(rest);
	const [fileName, name, npcId, teamText] = parts.map(s => s);
	return {
		fileName: fileName.trim(),
		name: name.trim(),
		npcId: toID(npcId.trim()),
		teamText,
	};
}

/** 把 fileName 从所有 template 的 teams 里清掉；返回受影响的 npc id 列表。 */
function unlinkFromAllTemplates(templates: { [id: string]: NPCTemplate }, fileName: string): string[] {
	const affected: string[] = [];
	for (const id of Object.keys(templates)) {
		const t = templates[id];
		const list = Array.isArray(t.teams) ? t.teams : [];
		const idx = list.indexOf(fileName);
		if (idx >= 0) {
			list.splice(idx, 1);
			affected.push(id);
		}
	}
	return affected;
}

function linkToTemplate(templates: { [id: string]: NPCTemplate }, fileName: string, npcId: string): void {
	const t = templates[npcId];
	if (!t) throw new Chat.ErrorMessage(`NPC 不存在：${npcId}`);
	if (!Array.isArray(t.teams)) (t as AnyObject).teams = [];
	if (!t.teams.includes(fileName)) t.teams.push(fileName);
}

/** 从磁盘上收集所有 team 文件名，用于生成唯一文件名 */
function collectAllTeamFileNames(templates: { [id: string]: NPCTemplate }): Set<string> {
	const seen = new Set<string>();
	for (const id of Object.keys(templates)) {
		const t = templates[id];
		for (const f of (t.teams || [])) seen.add(f);
	}
	return seen;
}

/** 校验 Multi 格式的硬性要求：整队必须正好 6 只。 */
function validateMultiTeamShape(pokemon: AnyObject[], format: string): void {
	const fmt = Dex.formats.get(format);
	if (fmt.gameType === 'multi' && pokemon.length !== 6) {
		throw new Chat.ErrorMessage(
			`Multi 格式 ${fmt.name} 要求整支队伍正好 6 只（前 3 → p2，后 3 → p4），现在是 ${pokemon.length} 只。`
		);
	}
}

/**
 * 验证一支队伍在给定格式下是否合法。
 * 返回 null 代表通过；返回字符串数组代表违规描述。
 *
 * Multi 特殊：PS 的 TeamValidator 对 multi 格式只接受 **3 只**（因为玩家视角一人只带 3）。
 * 我们的 NPC multi 队伍存 6 只（前 3 → p2，后 3 → p4），直接验证会报 "You may only bring
 * up to 3 Pokémon"。拆成两半分别校验。
 */
function validateTeamForFormat(pokemon: AnyObject[], format: string): string[] | null {
	try {
		const fmt = Dex.formats.get(format);
		if (fmt.gameType === 'multi' && pokemon.length === 6) {
			const validator = TeamValidator.get(format);
			const errA = validator.validateTeam(pokemon.slice(0, 3) as any);
			const errB = validator.validateTeam(pokemon.slice(3, 6) as any);
			const merged: string[] = [];
			if (errA?.length) merged.push(...errA.map(e => `[前 3 只] ${e}`));
			if (errB?.length) merged.push(...errB.map(e => `[后 3 只] ${e}`));
			return merged.length ? merged : null;
		}
		const validator = TeamValidator.get(format);
		const errors = validator.validateTeam(pokemon as any);
		return errors && errors.length ? errors : null;
	} catch (err: any) {
		return [`验证器出错：${err?.message || err}`];
	}
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
			/**
			 * 保存队伍（队名 + pokemon）。不涉及 formats；formats 通过 addformat 另加。
			 * target 格式: fileName|name|npcId|teamText
			 */
			save(target, room, user) {
				requireUnlock(user);
				const { fileName, name, npcId, teamText } = parseSaveTarget(target);
				if (!npcId) return this.errorReply(`请先选择 "所属 NPC"。`);

				const pokemon = parseImportedTeam(teamText);
				const normalized = normalizeTeam(pokemon);

				const templates = NPC.readTemplatesRaw();
				const template = templates[npcId];
				if (!template) return this.errorReply(`NPC 不存在：${npcId}`);

				// 保留原有 formats（如果是编辑）；新建的话从空列表开始
				const prevContent = fileName ? NPC.readTeamFile(fileName) : null;
				const existingFormats = prevContent?.formats || [];

				// 决定最终文件名
				let finalFileName = fileName;
				if (!finalFileName) {
					const allFiles = collectAllTeamFileNames(templates);
					finalFileName = nextTeamFileName(npcId, 'team', allFiles);
				}

				// 写盘
				const content: NPCTeamFile = { formats: existingFormats, pokemon: normalized as any };
				if (name) content.name = name;
				NPC.writeTeamFile(finalFileName, formatTeamJson(content));

				// 更新 templates：把文件挂到选定 NPC，摘掉原来可能挂着的其他 NPC
				unlinkFromAllTemplates(templates, finalFileName);
				linkToTemplate(templates, finalFileName, npcId);
				NPC.writeTemplates(templates);
				NPC.reload();

				this.sendReply(
					`✓ 已保存 ${finalFileName}（${template.name}${name ? ` · ${name}` : ''}，${pokemon.length} 只精灵` +
					`${existingFormats.length ? `，已挂 ${existingFormats.length} 个分级` : '；记得点"添加分级"'})`
				);
				// 新建的话跳回编辑页，方便接着加分级
				return this.parse(`/j view-npcadmin-edit-${finalFileName}`);
			},

			/**
			 * 验证一个分级对当前文件的队伍是否兼容。只验证，不改任何东西。
			 * target: fileName,format
			 */
			/**
			 * 验证一个分级对当前文件的队伍是否兼容。只验证，不改任何东西。
			 * 结果渲染到 /view-npcadmin-validate-FILE-FORMAT 页面，不写入聊天区。
			 * target: fileName,format
			 */
			validate(target, room, user) {
				requireUnlock(user);
				const [fileNameRaw, formatRaw] = target.split(',').map(s => s.trim());
				const fileName = fileNameRaw;
				const format = toID(formatRaw);
				if (!fileName) return this.errorReply(`用法：/npcadmin team validate fileName, format`);
				if (!format) return this.errorReply(`请先选择一个要验证的分级。`);
				const content = NPC.readTeamFile(fileName);
				if (!content) return this.errorReply(`文件不存在：${fileName}`);
				// 跳到验证结果页；页面渲染时自己再跑一次 validate 得到结果
				return this.parse(`/j view-npcadmin-validate-${fileName}-${format}`);
			},

			/**
			 * 把一个格式添加到队伍文件的 formats（添加前再验证一次）。
			 * target: fileName,format
			 */
			addformat(target, room, user) {
				requireUnlock(user);
				const [fileNameRaw, formatRaw] = target.split(',').map(s => s.trim());
				const fileName = fileNameRaw;
				const format = toID(formatRaw);
				if (!fileName) return this.errorReply(`用法：/npcadmin team addformat fileName, format`);
				if (!format) return this.errorReply(`请先选择一个要添加的分级。`);

				const content = NPC.readTeamFile(fileName);
				if (!content) return this.errorReply(`文件不存在：${fileName}`);
				if (content.formats.includes(format)) {
					return this.errorReply(`${format} 已经在该队伍的分级列表里了。`);
				}

				try {
					validateMultiTeamShape(content.pokemon as any, format);
				} catch (err: any) {
					return this.errorReply(err.message || String(err));
				}

				const errors = validateTeamForFormat(content.pokemon as any, format);
				if (errors) {
					return this.errorReply(`不兼容 ${format}：${errors.join('；')}`);
				}

				content.formats.push(format);
				NPC.writeTeamFile(fileName, formatTeamJson(content));
				NPC.reload();
				this.sendReply(`✓ 已把分级 ${format} 加到 ${fileName}。`);
				return this.parse(`/j view-npcadmin-edit-${fileName}`);
			},

			/**
			 * 从队伍文件的 formats 列表里移除一个分级。
			 * target: fileName,format
			 */
			removeformat(target, room, user) {
				requireUnlock(user);
				const [fileNameRaw, formatRaw] = target.split(',').map(s => s.trim());
				const fileName = fileNameRaw;
				const format = toID(formatRaw);
				if (!fileName || !format) return this.errorReply(`用法：/npcadmin team removeformat fileName, format`);

				const content = NPC.readTeamFile(fileName);
				if (!content) return this.errorReply(`文件不存在：${fileName}`);
				const idx = content.formats.indexOf(format);
				if (idx < 0) return this.errorReply(`${format} 不在该队伍的分级列表里。`);
				content.formats.splice(idx, 1);
				NPC.writeTeamFile(fileName, formatTeamJson(content));
				NPC.reload();
				this.sendReply(`✓ 已从 ${fileName} 移除分级 ${format}。`);
				return this.parse(`/j view-npcadmin-edit-${fileName}`);
			},

			/**
			 * 删除队伍文件 + 从 templates 摘掉。
			 * target: fileName
			 */
			delete(target, room, user) {
				requireUnlock(user);
				const fileName = target.trim();
				if (!fileName) return this.errorReply(`用法：/npcadmin team delete fileName`);

				const templates = NPC.readTemplatesRaw();
				const affected = unlinkFromAllTemplates(templates, fileName);
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

function renderFormatChip(format: string): string {
	const name = Dex.formats.get(format).name || format;
	return `<code>${Utils.escapeHTML(name)}</code>`;
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
		buf += `<details open><summary><strong>${Utils.escapeHTML(npc.name)}</strong> <small>(${npc.id})</small></summary>`;
		if (!npc.teams.length) {
			buf += `<div style="margin-left:16px;color:#888">还没有队伍</div>`;
		} else {
			buf += `<table style="margin:4px 0 4px 12px"><tbody>`;
			for (const file of npc.teams) {
				const content = NPC.readTeamFile(file);
				const name = content?.name || '(未命名)';
				const icons = content?.pokemon ? renderPsicons(content.pokemon) : '';
				buf += `<tr>`;
				buf += `<td style="min-width:160px;padding:2px 8px"><strong>${Utils.escapeHTML(name)}</strong></td>`;
				buf += `<td style="padding:2px 8px;white-space:nowrap">${icons}</td>`;
				buf += `<td style="padding:2px 8px;white-space:nowrap">`;
				if (unlocked) {
					buf += `<a class="button" target="replace" href="/view-npcadmin-edit-${file}">编辑</a> `;
					buf += `<button class="button" name="send" value="/npcadmin team delete ${file}">删除</button>`;
				} else {
					buf += `<a class="button" target="replace" href="/view-npcadmin-edit-${file}">查看</a>`;
				}
				buf += `</td></tr>`;
			}
			buf += `</tbody></table>`;
		}
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

	// 找出该文件当前挂在哪个 NPC（遍历所有 npc.teams）
	let currentNpcId = '';
	if (fileName) {
		for (const npc of npcs) {
			if (npc.teams.includes(fileName)) {
				currentNpcId = npc.id;
				break;
			}
		}
	}
	const currentName = content?.name || '';
	const currentFormats = content?.formats || [];
	const currentText = content?.pokemon ? Teams.export(content.pokemon) : '';
	const currentTextForTextarea = escapeForTextarea(currentText);

	let buf = `<div class="pad">`;
	buf += `<p><a class="button" target="replace" href="/view-npcadmin">← 返回列表</a></p>`;
	buf += `<h2>${fileName ? '编辑队伍' : '新建队伍'}</h2>`;
	if (fileName) buf += `<p><small>文件：<code>${Utils.escapeHTML(fileName)}</code></small></p>`;
	buf += renderUnlockBar(user);

	if (!unlocked) {
		// 只读显示
		buf += `<p><strong>队伍名称：</strong>${Utils.escapeHTML(currentName || '(未命名)')}</p>`;
		buf += `<p><strong>所属 NPC：</strong>${Utils.escapeHTML(currentNpcId || '(未关联)')}</p>`;
		buf += `<p><strong>支持的分级：</strong>${
			currentFormats.length ? currentFormats.map(f => renderFormatChip(f)).join(' ') : '(无)'
		}</p>`;
		buf += `<pre style="background:#f0f0f0;padding:8px;max-height:600px;overflow:auto">${
			Utils.escapeHTML(currentText) || '(无内容)'
		}</pre></div>`;
		return buf;
	}

	// ======== 已解锁：编辑表单 ========

	// 1. 保存"队名 + 阵容"的 form
	buf += `<h3>基础信息</h3>`;
	buf += `<form data-submitsend="/npcadmin team save ${fileName || ''}|{name}|{npcId}|{team}">`;
	buf += `<p><label>队伍名称：<input class="textbox" name="name" value="${Utils.escapeHTML(currentName)}" style="width:300px" placeholder="例：沙暴地龙队" /></label></p>`;

	if (!fileName) {
		// 新建：选 NPC（强制选）
		buf += `<p><label>所属 NPC：<select name="npcId" required>`;
		buf += `<option value="" selected disabled>-- 请选择 NPC --</option>`;
		for (const npc of npcs) {
			buf += `<option value="${npc.id}">${Utils.escapeHTML(npc.name)} (${npc.id})</option>`;
		}
		buf += `</select></label></p>`;
	} else {
		buf += `<input type="hidden" name="npcId" value="${Utils.escapeHTML(currentNpcId)}" />`;
		buf += `<p><strong>所属 NPC：</strong>${Utils.escapeHTML(currentNpcId)} <small>（创建后不可修改）</small></p>`;
	}

	buf += `<p><strong>队伍 (PS Teambuilder Export 文本):</strong> ` +
		`<small>Multi 分级下整队必须正好 6 只；前 3 分到 p2，后 3 分到 p4。</small></p>`;
	buf += `<textarea name="team" style="width:100%;min-height:400px;font-family:monospace;font-size:12px" ` +
		`placeholder="直接从 PS Teambuilder 的 Import/Export 复制过来">${currentTextForTextarea}</textarea>`;
	buf += `<p>`;
	buf += `<button class="button notifying" type="submit">保存基础信息</button>`;
	if (fileName) {
		buf += ` <button class="button" name="send" value="/npcadmin team delete ${fileName}" style="color:#c00">删除此队伍</button>`;
	}
	buf += `</p>`;
	buf += `</form>`;

	// 2. 已经挂了的分级列表 + 添加分级
	if (fileName) {
		buf += `<hr/>`;
		buf += `<h3>支持的分级</h3>`;
		if (currentFormats.length) {
			buf += `<ul>`;
			for (const f of currentFormats) {
				buf += `<li>${renderFormatChip(f)} ` +
					`<button class="button" style="margin-left:8px" name="send" ` +
					`value="/npcadmin team removeformat ${fileName}, ${f}">移除</button></li>`;
			}
			buf += `</ul>`;
		} else {
			buf += `<p><small>还没有挂任何分级。玩家无法在任何分级下用到这支队伍。</small></p>`;
		}

		// 添加新分级：只保留一个 form，验证通过后在聊天框里得到"添加该分级"按钮。
		buf += `<h4>添加新分级</h4>`;
		buf += `<p>选择一个分级点"验证"：通过后聊天区会出现"添加该分级"按钮；不通过会列出具体违规。</p>`;
		buf += `<form data-submitsend="/npcadmin team validate ${fileName}, {format}">`;
		buf += `<p><label>选择分级：<button type="button" name="format" value="" ` +
			`class="select formatselect" data-href="/formatdropdown" data-selecttype="teambuilder">` +
			`<i class="fa fa-folder-o"></i> (点击选择)</button></label> `;
		buf += `<button class="button notifying" type="submit">验证</button></p>`;
		buf += `</form>`;
	} else {
		buf += `<hr/><p><small>保存后在编辑页里添加分级。</small></p>`;
	}

	buf += `</div>`;
	return buf;
}

/** 验证结果页：显示某个 fileName 在某个 format 下的兼容情况，附带页面内"添加"按钮。 */
function renderValidate(user: User, fileName: string, format: string): string {
	const unlocked = isUnlocked(user);
	const content = NPC.readTeamFile(fileName);
	const fmt = Dex.formats.get(format);
	const formatName = fmt.name || format;

	let buf = `<div class="pad">`;
	buf += `<p><a class="button" target="replace" href="/view-npcadmin-edit-${fileName}">← 返回编辑</a></p>`;
	buf += `<h2>验证分级</h2>`;
	buf += `<p><small>文件：<code>${Utils.escapeHTML(fileName)}</code> · 分级：<code>${Utils.escapeHTML(formatName)}</code></small></p>`;

	if (!content) {
		buf += `<p style="color:#c00">文件不存在。</p></div>`;
		return buf;
	}
	if (!fmt.exists) {
		buf += `<p style="color:#c00">分级 id 无效：${Utils.escapeHTML(format)}</p></div>`;
		return buf;
	}

	// 先过 Multi 整队大小检查
	try {
		validateMultiTeamShape(content.pokemon as any, format);
	} catch (err: any) {
		buf += `<p style="color:#c00"><strong>❌ 不兼容</strong><br/>${Utils.escapeHTML(err.message || String(err))}</p>`;
		buf += `</div>`;
		return buf;
	}

	const errors = validateTeamForFormat(content.pokemon as any, format);
	if (errors) {
		buf += `<div style="padding:8px;background:#fee;border:1px solid #c66;border-radius:4px">`;
		buf += `<strong style="color:#c00">❌ 不兼容 ${Utils.escapeHTML(formatName)}</strong>`;
		buf += `<ul>`;
		for (const e of errors) buf += `<li>${Utils.escapeHTML(e)}</li>`;
		buf += `</ul>`;
		buf += `</div>`;
	} else {
		buf += `<div style="padding:8px;background:#efe;border:1px solid #6c6;border-radius:4px">`;
		buf += `<strong style="color:#060">✓ 兼容 ${Utils.escapeHTML(formatName)}</strong>`;
		buf += `</div>`;
		buf += `<p>`;
		const already = content.formats.includes(format);
		if (already) {
			buf += `<small>（已挂在该队伍上）</small>`;
		} else if (unlocked) {
			buf += `<button class="button notifying" name="send" ` +
				`value="/npcadmin team addformat ${fileName}, ${format}">添加该分级</button>`;
		} else {
			buf += `<small>（解锁后可添加）</small>`;
		}
		buf += `</p>`;
	}
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
			// 文件名可能含 '-'，整段 join 回来
			const fileName = rest.join('-');
			return renderEdit(user, fileName);
		}
		if (sub === 'validate') {
			// 格式 id 由 toID 产生，必为纯 alphanum，所以是最后一段；前面全是文件名
			if (rest.length < 2) return renderOverview(user);
			const format = rest[rest.length - 1];
			const fileName = rest.slice(0, -1).join('-');
			return renderValidate(user, fileName, format);
		}
		return renderOverview(user);
	},
};
