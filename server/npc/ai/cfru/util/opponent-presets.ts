/**
 * Opponent preset 加载器 —— 对手能力值估算与承伤威胁判断的手工预设。
 *
 * 配置文件：`data/npc/opponent-presets.json`
 *   key = toID(species)（例：'garchomp'、'charizardmegay'）
 *   value = { nameZh?, nature?, evs?, ivs?, item?, moves? }
 *
 * 缺省 EV 使用每项 85；显式 EV 表中未写的项目为 0。缺省 IV=31，性格无修正。
 * moves 提供候选，不写入已揭露信息；剩余槽限制共存组合，实露四招后忽略预设招式。
 *
 * JSON 文件在编译时拷到 dist/data/npc/，运行时按 cwd 读取；加载失败不报错，静默回退。
 */

import { FS } from '../../../../../lib';
import { Dex, toID } from '../../../../../sim/dex';
import type { AIPokemon, OpponentMoveKnowledge } from '../types';

type StatKey = 'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe';

export interface OpponentPreset {
	nameZh?: string;
	nature?: string;
	evs?: Partial<Record<StatKey, number>>;
	ivs?: Partial<Record<StatKey, number>>;
	item?: string;
	moves?: string[];
}

interface PresetFile { [speciesId: string]: OpponentPreset | AnyObject }

/** 自然性格 → 加/减 stat */
const NATURE_TABLE: { [nature: string]: { plus: StatKey | null, minus: StatKey | null } } = {
	Hardy: { plus: null, minus: null },
	Lonely: { plus: 'atk', minus: 'def' },
	Brave: { plus: 'atk', minus: 'spe' },
	Adamant: { plus: 'atk', minus: 'spa' },
	Naughty: { plus: 'atk', minus: 'spd' },
	Bold: { plus: 'def', minus: 'atk' },
	Docile: { plus: null, minus: null },
	Relaxed: { plus: 'def', minus: 'spe' },
	Impish: { plus: 'def', minus: 'spa' },
	Lax: { plus: 'def', minus: 'spd' },
	Timid: { plus: 'spe', minus: 'atk' },
	Hasty: { plus: 'spe', minus: 'def' },
	Serious: { plus: null, minus: null },
	Jolly: { plus: 'spe', minus: 'spa' },
	Naive: { plus: 'spe', minus: 'spd' },
	Modest: { plus: 'spa', minus: 'atk' },
	Mild: { plus: 'spa', minus: 'def' },
	Quiet: { plus: 'spa', minus: 'spe' },
	Bashful: { plus: null, minus: null },
	Rash: { plus: 'spa', minus: 'spd' },
	Calm: { plus: 'spd', minus: 'atk' },
	Gentle: { plus: 'spd', minus: 'def' },
	Sassy: { plus: 'spd', minus: 'spe' },
	Careful: { plus: 'spd', minus: 'spa' },
	Quirky: { plus: null, minus: null },
};

let cache: PresetFile | null = null;
let loadAttempted = false;

function loadPresetsIfNeeded(): PresetFile {
	if (cache) return cache;
	if (loadAttempted) return cache || {};
	loadAttempted = true;
	try {
		const raw = FS('data/npc/opponent-presets.json').readIfExistsSync();
		if (!raw) {
			cache = {};
			return cache;
		}
		const parsed = JSON.parse(raw) as PresetFile;
		cache = parsed;
		return cache;
	} catch (err) {
		// 配置坏了不要阻塞运行，回退到默认估算
		console.error('[opponent-presets] load failed, falling back to default stats', err);
		cache = {};
		return cache;
	}
}

/** Cosmetic forms and move-unlocked forms with identical battle traits share configuration priors. */
export function presetSpeciesId(name: string, formatId = ''): string {
	const dex = formatId ? Dex.forFormat(formatId) : Dex;
	const species = dex.species.get(name);
	if (species.isCosmeticForme) return toID(species.baseSpecies);
	const base = dex.species.get(species.baseSpecies);
	if (species.requiredMove && !species.battleOnly && !species.requiredItem &&
		Object.entries(species.baseStats).every(([stat, value]) => base.baseStats[stat as StatKey] === value) &&
		JSON.stringify(species.types) === JSON.stringify(base.types) &&
		JSON.stringify(species.abilities) === JSON.stringify(base.abilities)) return base.id;
	return species.id;
}

/** 按 species 名字查 preset。找不到或字段非法时返回 null。 */
export function getOpponentPreset(species: string, formatId = ''): OpponentPreset | null {
	const presets = loadPresetsIfNeeded();
	const key = toID(species);
	const entry = presets[key] || presets[presetSpeciesId(species, formatId)];
	if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
	// 过滤以 "_" 开头的注释字段
	if (species.startsWith('_')) return null;
	if (formatId && entry.item) {
		const dex = Dex.forFormat(formatId);
		if (dex.items.get(entry.item).gen > dex.gen) return { ...entry, item: undefined };
	}
	return entry;
}

/** Keep facts and possible moves separate, including the number of unobserved slots. */
export function getOpponentMoveKnowledge(
	species: string, revealedMoves: readonly string[], formatId = ''
): OpponentMoveKnowledge {
	const dex = formatId ? Dex.forFormat(formatId) : Dex;
	const revealed = new Set(
		revealedMoves.map(move => dex.moves.get(move)).filter(move => move.exists).map(move => move.id)
	);
	const remainingSlots = Math.max(0, 4 - revealed.size);
	const candidates = new Set<string>();
	const presetMoves = getOpponentPreset(species, formatId)?.moves;
	if (remainingSlots && Array.isArray(presetMoves)) {
		for (const name of presetMoves) {
			if (typeof name !== 'string') continue;
			const move = dex.moves.get(name);
			if (move.exists && move.gen <= dex.gen && !revealed.has(move.id) &&
				!(revealed.has('hiddenpower' as ID) && move.id.startsWith('hiddenpower'))) candidates.add(move.id);
		}
	}
	return { revealedMoves: [...revealed], presetCandidates: [...candidates], remainingSlots };
}

/** Injectively match moves to slots; overlapping slash options must not consume one slot twice. */
export function compatibleMoveSlots(slots: string[][], moves: readonly string[]): boolean {
	const unique = [...new Set(moves.map(toID))];
	const matches = (known: string, candidate: string) => known === candidate ||
		(known === 'hiddenpower' && candidate.startsWith('hiddenpower'));
	const assign = (index: number, used: number): boolean => index === unique.length ||
		slots.some((slot, i) => !(used & (1 << i)) && slot.some(m => matches(unique[index], m)) &&
			assign(index + 1, used | (1 << i)));
	return unique.length <= slots.length && assign(0, 0);
}

/** Whether these moves can coexist with public observations, not whether they are guaranteed. */
export function canHaveOpponentMoves(knowledge: OpponentMoveKnowledge, moves: readonly string[]): boolean {
	const requested = [...new Set(moves.map(toID))];
	if (requested.some(m => !knowledge.revealedMoves.includes(m) && !knowledge.presetCandidates.includes(m))) return false;
	const additional = requested.filter(m => !knowledge.revealedMoves.includes(m) &&
		!(m.startsWith('hiddenpower') && knowledge.revealedMoves.includes('hiddenpower')));
	if (additional.length > knowledge.remainingSlots) return false;
	const combined = [...new Set([...knowledge.revealedMoves, ...requested])].filter(m =>
		!(m === 'hiddenpower' && requested.some(id => id !== 'hiddenpower' && id.startsWith('hiddenpower'))));
	if (combined.filter(m => m.startsWith('hiddenpower')).length > 1) return false;
	if (knowledge.movePools && !knowledge.movePools.some(pool =>
		compatibleMoveSlots(pool.map(move => [move]), combined))) return false;
	return !knowledge.slots || compatibleMoveSlots(knowledge.slots, combined);
}

/** Normal evaluates each possible attack independently; this is not a complete moveset. */
export function getOpponentThreatMoves(species: string, revealedMoves: readonly string[], formatId = ''): string[] {
	const knowledge = getOpponentMoveKnowledge(species, revealedMoves, formatId);
	return [...knowledge.revealedMoves, ...knowledge.presetCandidates];
}

/**
 * 用 preset 的 EV + nature 算出 Pokemon 的实际 stats。
 *
 * @param baseStats 种族值
 * @param level 等级
 * @param preset nature + EV + 可选 IV 覆盖
 * @returns 实际 stats（和 request.side.pokemon[i].stats 格式一致）
 */
export function computeStatsFromPreset(
	baseStats: AIPokemon['baseStats'],
	level: number,
	preset: OpponentPreset
): AIPokemon['baseStats'] {
	const natureMod = NATURE_TABLE[preset.nature || 'Hardy'] || { plus: null, minus: null };
	const defaultIV = 31;
	const iv = (k: StatKey) => preset.ivs?.[k] ?? defaultIV;
	const ev = (k: StatKey) => preset.evs ? (preset.evs[k] ?? 0) : 85;
	const nmul = (k: StatKey) => {
		if (natureMod.plus === k) return 1.1;
		if (natureMod.minus === k) return 0.9;
		return 1.0;
	};
	const stat = (k: StatKey) => Math.floor((
		Math.floor((2 * baseStats[k] + iv(k) + Math.floor(ev(k) / 4)) * level / 100) + 5
	) * nmul(k));
	// HP 的公式稍有不同：无性格修正，+level+10
	const hp = baseStats.hp === 1 ? 1 :
		Math.floor((2 * baseStats.hp + iv('hp') + Math.floor(ev('hp') / 4)) * level / 100) + level + 10;
	return {
		hp,
		atk: stat('atk'),
		def: stat('def'),
		spa: stat('spa'),
		spd: stat('spd'),
		spe: stat('spe'),
	};
}

/** 测试辅助：清空缓存强制下一次重新加载（生产用不到） */
export function _clearPresetCacheForTests(): void {
	cache = null;
	loadAttempted = false;
}
