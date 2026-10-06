/**
 * NPC Admin —— 管理 NPC 和它们的队伍，不走命令行改源文件。
 *
 * 入口：`/npcadmin` 页面；所有改写操作都需要先用密钥解锁本 session。
 *
 * 核心命令（全部要先 unlock）：
 *   /npcadmin unlock KEY           - 解锁，30 分钟内有效
 *   /npcadmin lock                 - 立即锁回去
 *   /npcadmin reload               - 重新读取 templates.json 和所有 teams/*.json
 *   /npcadmin team import NPC,格式,游戏类型,[队伍名称]
 *                                     [换行]
 *                                     PS 导出的 team 文本...
 *                                 - 把粘贴的 Teambuilder 文本保存成 teams/*.json
 *                                   并把文件名挂到 templates.json 对应槽位里
 *   /npcadmin team delete NPC,格式,游戏类型,文件名
 *                                 - 从磁盘删掉 team.json 并从 templates 里摘掉
 *   /npcadmin team rename NPC,格式,游戏类型,文件名,新名称
 *                                 - 只改 team.json 内的 name 字段
 *
 * 对所有玩家开放，但解锁密钥硬编码。生产部署前应改成 Config 读取或者走管理员权限。
 */

import { Teams, type PokemonSet } from '../../sim/teams';
import { Utils } from '../../lib';
import { NPC, type NPCTemplate, type NPCTeamFile } from '../npc/manager';

// 硬编码的 session 密钥
const ADMIN_KEY = '963741';
// 解锁有效时间（毫秒）
const UNLOCK_TTL = 30 * 60 * 1000;

/** 已解锁的用户 → 解锁时间戳 */
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

function requireUnlock(this: Chat.CommandContext, user: User): void {
	if (!isUnlocked(user)) {
		throw new Chat.ErrorMessage(`管理功能已锁定，先用 \`/npcadmin unlock KEY\` 解锁（30 分钟有效）。`);
	}
}

type GameType = 'singles' | 'doubles' | 'multi' | 'randombattle';
const GAME_TYPES: readonly GameType[] = ['singles', 'doubles', 'multi', 'randombattle'];

function parseGameType(input: string): GameType {
	const g = input.trim().toLowerCase();
	if (!GAME_TYPES.includes(g as GameType)) {
		throw new Chat.ErrorMessage(`游戏类型必须是 singles | doubles | multi | randombattle，收到 "${input}"`);
	}
	return g as GameType;
}

/** 生成一个新的 team 文件名，形如 "npcId-format-N.json"，N 自动递增避免覆盖。 */
function nextTeamFileName(npcId: string, format: string, existing: string[]): string {
	const base = `${npcId}-${format}`;
	const used = new Set(existing);
	for (let i = 1; i < 1000; i++) {
		const name = `${base}-${i}.json`;
		if (!used.has(name)) return name;
	}
	throw new Error('team filename counter overflow');
}

/**
 * 把 templates 对应 slot 的队伍文件列表拿出来；如果层级不存在就一路创建。
 * randombattle 槽位结构不同（string[]），用别的函数处理。
 */
function getTeamSlot(
	template: NPCTemplate,
	gameType: 'singles' | 'doubles' | 'multi',
	format: string
): string[] {
	if (!template.teams[gameType]) template.teams[gameType] = {};
	const bucket = template.teams[gameType]!;
	if (!bucket[format]) bucket[format] = [];
	return bucket[format];
}

function removeTeamFromTemplate(
	template: NPCTemplate,
	gameType: 'singles' | 'doubles' | 'multi',
	format: string,
	teamFile: string
): boolean {
	const slot = template.teams[gameType]?.[format];
	if (!slot) return false;
	const idx = slot.indexOf(teamFile);
	if (idx < 0) return false;
	slot.splice(idx, 1);
	if (slot.length === 0) {
		delete template.teams[gameType]![format];
	}
	return true;
}

/** 把 PS 导出文本转成 PokemonSet[]。失败抛错。 */
function parseImportedTeam(text: string): PokemonSet[] {
	const sets = Teams.import(text.trim());
	if (!sets?.length) {
		throw new Chat.ErrorMessage(`无法解析队伍文本，请确认粘贴的是 PS Teambuilder 的 Export 格式。`);
	}
	return sets;
}

export const commands: Chat.ChatCommands = {
	npcadmin: {
		''(target, room, user) {
			return this.parse(`/j view-npcadmin`);
		},

		unlock(target, room, user) {
			const key = target.trim();
			if (key !== ADMIN_KEY) {
				return this.errorReply(`密钥不正确。`);
			}
			unlockedUsers.set(user.id, Date.now());
			this.sendReply(`✓ NPC 管理已解锁，30 分钟内可执行管理命令。打开 /npcadmin 面板。`);
			return this.parse(`/j view-npcadmin`);
		},

		lock(target, room, user) {
			unlockedUsers.delete(user.id);
			this.sendReply(`✓ NPC 管理已锁定。`);
		},

		reload(target, room, user) {
			requireUnlock.call(this, user);
			NPC.reload();
			this.sendReply(`✓ NPC 配置已重载（共 ${NPC.count} 个 NPC）。`);
		},

		team: {
			import(target, room, user) {
				requireUnlock.call(this, user);
				// 用户输入格式：npcId, format, gameType, teamName \n Teambuilder export text
				// chat 层的 target 已经把参数行传过来。为了允许多行队伍文本，我们按首行作参数，
				// 剩下的做队伍 body。
				const [paramLine, ...bodyLines] = target.split('\n');
				const params = paramLine.split(',').map(s => s.trim());
				const npcId = toID(params[0]);
				const format = toID(params[1]);
				const gameTypeRaw = params[2];
				const teamName = (params[3] || '').trim();
				const body = bodyLines.join('\n');

				if (!npcId || !format || !gameTypeRaw || !body) {
					return this.errorReply(
						`用法：/npcadmin team import npcId, format, gameType, 队伍名称` +
						`\n（下一行开始粘贴 PS Teambuilder Export）`
					);
				}
				const gameType = parseGameType(gameTypeRaw);
				if (gameType === 'randombattle') {
					return this.errorReply(`randombattle 格式不需要上传队伍（PS 会生成）。`);
				}

				const templates = NPC.readTemplatesRaw();
				const template = templates[npcId];
				if (!template) return this.errorReply(`NPC 不存在：${npcId}`);

				// 解析队伍文本
				const pokemon = parseImportedTeam(body);

				// 文件名
				const slot = getTeamSlot(template, gameType, format);
				const fileName = nextTeamFileName(npcId, format, slot);

				// 写盘
				const teamFileContent: NPCTeamFile = {
					format,
					pokemon,
				};
				if (teamName) teamFileContent.name = teamName;
				NPC.writeTeamFile(fileName, teamFileContent);

				// 更新 templates
				slot.push(fileName);
				NPC.writeTemplates(templates);
				NPC.reload();

				this.sendReply(
					`✓ 已为 ${template.name} 导入队伍（${gameType}/${format}）：${fileName}` +
					`${teamName ? `（${teamName}）` : ''}，共 ${pokemon.length} 只精灵。`
				);
				return this.parse(`/j view-npcadmin`);
			},

			delete(target, room, user) {
				requireUnlock.call(this, user);
				const params = target.split(',').map(s => s.trim());
				const [npcIdRaw, formatRaw, gameTypeRaw, fileName] = params;
				const npcId = toID(npcIdRaw);
				const format = toID(formatRaw);
				if (!npcId || !format || !gameTypeRaw || !fileName) {
					return this.errorReply(
						`用法：/npcadmin team delete npcId, format, gameType, fileName`
					);
				}
				const gameType = parseGameType(gameTypeRaw);
				if (gameType === 'randombattle') {
					return this.errorReply(`randombattle 不存队伍文件。`);
				}

				const templates = NPC.readTemplatesRaw();
				const template = templates[npcId];
				if (!template) return this.errorReply(`NPC 不存在：${npcId}`);

				const removed = removeTeamFromTemplate(template, gameType, format, fileName);
				if (!removed) {
					return this.errorReply(
						`${template.name} 的 ${gameType}/${format} 下没找到 ${fileName}。`
					);
				}
				NPC.deleteTeamFile(fileName);
				NPC.writeTemplates(templates);
				NPC.reload();

				this.sendReply(`✓ 已删除 ${template.name} 的队伍：${fileName}`);
				return this.parse(`/j view-npcadmin`);
			},

			rename(target, room, user) {
				requireUnlock.call(this, user);
				// npcId, format, gameType, fileName, newName
				const params = target.split(',').map(s => s.trim());
				const [npcIdRaw, formatRaw, gameTypeRaw, fileName, ...nameParts] = params;
				const newName = nameParts.join(',').trim();
				if (!npcIdRaw || !formatRaw || !gameTypeRaw || !fileName || !newName) {
					return this.errorReply(
						`用法：/npcadmin team rename npcId, format, gameType, fileName, 新名称`
					);
				}
				parseGameType(gameTypeRaw); // 只做校验，不用

				const content = NPC.readTeamFile(fileName);
				if (!content) return this.errorReply(`队伍文件不存在：${fileName}`);
				content.name = newName;
				NPC.writeTeamFile(fileName, content);
				NPC.reload();

				this.sendReply(`✓ ${fileName} 的名称已改为"${newName}"`);
				return this.parse(`/j view-npcadmin`);
			},
		},
	},
};

// -----------------------------------------------------------------------------
// 页面
// -----------------------------------------------------------------------------

function renderPsicons(pokemon: PokemonSet[]): string {
	return pokemon.map(p => `<psicon pokemon="${Utils.escapeHTML(p.species)}" />`).join('');
}

/** 渲染一个 NPC 的 teams 面板 */
function renderNPCCard(template: NPCTemplate, unlocked: boolean): string {
	let buf = `<details open><summary><strong>${Utils.escapeHTML(template.name)}</strong> `;
	buf += `<small>(${template.id}) · ${template.difficulty}</small>`;
	if (template.title) buf += ` <small>— ${Utils.escapeHTML(template.title)}</small>`;
	buf += `</summary>`;

	// 列出 singles / doubles / multi 下所有格式和队伍
	for (const gameType of ['singles', 'doubles', 'multi'] as const) {
		const bucket = template.teams[gameType];
		if (!bucket) continue;
		for (const format of Object.keys(bucket)) {
			const files = bucket[format];
			if (!files?.length) continue;
			buf += `<div style="margin:4px 0 4px 12px"><em>${gameType} / ${Utils.escapeHTML(format)}</em>`;
			buf += `<table style="margin-left:12px"><tbody>`;
			for (const file of files) {
				const content = NPC.readTeamFile(file);
				const displayName = content?.name || `(未命名)`;
				const icons = content?.pokemon ? renderPsicons(content.pokemon) : '';
				buf += `<tr>`;
				buf += `<td style="min-width:140px"><strong>${Utils.escapeHTML(displayName)}</strong></td>`;
				buf += `<td style="padding:0 8px">${icons}</td>`;
				buf += `<td>`;
				if (unlocked) {
					const delCmd = `/npcadmin team delete ${template.id}, ${format}, ${gameType}, ${file}`;
					const renameHint = `/npcadmin team rename ${template.id}, ${format}, ${gameType}, ${file}, 新名称`;
					buf += `<button class="button" name="send" value="${delCmd}">删除</button> `;
					buf += `<button class="button" name="send" value="/raw <small>复制下方命令，把"新名称"改成实际名字再发送：</small><br/><code>${Utils.escapeHTML(renameHint)}</code>">改名</button>`;
				} else {
					buf += `<small>（解锁后可操作）</small>`;
				}
				buf += `</td></tr>`;
			}
			buf += `</tbody></table>`;
			if (unlocked) {
				buf += `<small style="margin-left:12px;color:#888">` +
					`在聊天框粘贴：<code>/npcadmin team import ${template.id}, ${format}, ${gameType}, 队伍名称</code>` +
					`，另起一行粘贴 Teambuilder Export 文本提交。` +
					`</small>`;
			}
			buf += `</div>`;
		}
	}

	// 列出 randombattle
	if (template.teams.randombattle?.length) {
		buf += `<div style="margin:4px 0 4px 12px"><em>randombattle</em>: ${
			template.teams.randombattle.map(f => Utils.escapeHTML(f)).join(', ')
		}</div>`;
	}

	buf += `</details>`;
	return buf;
}

function renderAdminPage(user: User): string {
	const unlocked = isUnlocked(user);
	let buf = `<div class="pad">`;
	buf += `<h2>NPC 管理面板</h2>`;

	if (!unlocked) {
		buf += `<p style="color:#c00"><strong>当前未解锁</strong>。写操作被禁用。</p>`;
		buf += `<p>在聊天框输入 <code>/npcadmin unlock 你的密钥</code> 解锁 30 分钟。</p>`;
	} else {
		const left = Math.floor((UNLOCK_TTL - (Date.now() - (unlockedUsers.get(user.id) || 0))) / 60000);
		buf += `<p style="color:#060"><strong>✓ 已解锁</strong>（剩 ${left} 分钟）。`;
		buf += ` <button class="button" name="send" value="/npcadmin lock">锁定</button>`;
		buf += ` <button class="button" name="send" value="/npcadmin reload">重载缓存</button>`;
		buf += `</p>`;
	}

	buf += `<p><button class="button" name="send" value="/j view-npcadmin"><i class="fa fa-refresh"></i> 刷新</button></p>`;

	// 用法说明
	buf += `<details><summary><strong>如何导入队伍？</strong></summary>`;
	buf += `<ol>`;
	buf += `<li>在 PS Teambuilder 里编好一队，点"Export"复制整段文本</li>`;
	buf += `<li>在聊天框先打一行参数：<code>/npcadmin team import NPC_ID, 格式, 游戏类型, 队伍名称</code></li>`;
	buf += `<li>紧接着另起一行粘贴刚才复制的队伍文本，一起发送</li>`;
	buf += `<li>示例：<pre style="background:#f0f0f0;padding:6px">/npcadmin team import gymbrock, gen9nationaldex, singles, 沙暴地龙队
Tyranitar @ Leftovers
Ability: Sand Stream
EVs: 252 HP / 252 Atk / 4 SpD
Adamant Nature
- Stone Edge
...（后面省略）</pre></li>`;
	buf += `</ol>`;
	buf += `</details>`;

	buf += `<hr/>`;

	// 列出所有 NPC
	const npcs = NPC.getAll();
	if (!npcs.length) {
		buf += `<p>尚未定义任何 NPC。</p>`;
	} else {
		for (const npc of npcs) {
			buf += renderNPCCard(npc, unlocked);
		}
	}

	buf += `</div>`;
	return buf;
}

export const pages: Chat.PageTable = {
	npcadmin(query, user) {
		this.title = '[NPC 管理]';
		return renderAdminPage(user);
	},
};
