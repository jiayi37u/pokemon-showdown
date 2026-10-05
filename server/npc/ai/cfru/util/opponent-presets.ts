/**
 * Opponent preset 加载器 —— 为 NormalAI 的对手 stats 估算提供"常见练度"覆盖。
 *
 * 配置文件：`data/npc/opponent-presets.json`
 *   key = toID(species)（例：'garchomp'、'charizardmegay'）
 *   value = { nature, evs, ivs?, item? }
 *
 * 命中：用 preset 的 EV + nature 算出 stats，接管对手估算
 * 未命中：返回 null，调用方回退到 IV=31 / EV=85 / 无 nature 的既有逻辑
 *
 * JSON 文件在编译时拷到 dist/data/npc/，运行时按 cwd 读取；加载失败不报错，静默回退。
 */

import { FS } from '../../../../../lib';
import { toID } from '../../../../../sim/dex';
import type { AIPokemon } from '../types';

type StatKey = 'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe';

export interface OpponentPreset {
	nature: string;
	evs: Partial<Record<StatKey, number>>;
	ivs?: Partial<Record<StatKey, number>>;
	item?: string;
}

interface PresetFile { [speciesId: string]: OpponentPreset | AnyObject }

/** 自然性格 → 加/减 stat */
const NATURE_TABLE: { [nature: string]: { plus: StatKey | null; minus: StatKey | null } } = {
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

/** 按 species 名字查 preset。找不到或字段非法时返回 null。 */
export function getOpponentPreset(species: string): OpponentPreset | null {
	const presets = loadPresetsIfNeeded();
	const key = toID(species);
	const entry = presets[key];
	if (!entry || typeof entry !== 'object' || !entry.nature || !entry.evs) return null;
	// 过滤以 "_" 开头的注释字段
	if (key.startsWith('_')) return null;
	return entry as OpponentPreset;
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
	const natureMod = NATURE_TABLE[preset.nature] || { plus: null, minus: null };
	const defaultIV = 31;
	const iv = (k: StatKey) => preset.ivs?.[k] ?? defaultIV;
	const ev = (k: StatKey) => preset.evs[k] ?? 0;
	const nmul = (k: StatKey) => {
		if (natureMod.plus === k) return 1.1;
		if (natureMod.minus === k) return 0.9;
		return 1.0;
	};
	const stat = (k: StatKey) => Math.floor((
		Math.floor((2 * baseStats[k] + iv(k) + Math.floor(ev(k) / 4)) * level / 100) + 5
	) * nmul(k));
	// HP 的公式稍有不同：无性格修正，+level+10
	const hp = Math.floor((2 * baseStats.hp + iv('hp') + Math.floor(ev('hp') / 4)) * level / 100) + level + 10;
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
