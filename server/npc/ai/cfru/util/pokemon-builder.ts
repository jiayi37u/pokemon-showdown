/**
 * AIPokemon builder —— 把三类数据源（request / tracker / multi 场景的拼装 request）
 * 统一到同一个底层构造函数，避免重复维护"解析 condition / details / stats / defaults"的逻辑。
 *
 * 调用方向：
 *   - buildPokemonFromRequest()          —— state-builder 单打/双打自家精灵（request.side.pokemon）
 *   - trackedPokemonToAIPokemon()        —— 对手精灵（从 BattleTracker 聚合，stats 需按公式估算）
 *   - buildAIPokemonForMulti()           —— multi-manager 的 p2/p4 自家精灵（含 tracker boosts）
 *
 * 这里只做共享的"字段解析 + 默认值"工作，具体数据源的字段挑选还在各自 state-builder /
 * multi-manager 文件里，以免换 request/tracker 的字段路径时跨层级跳。
 */

import { Dex } from '../../../../../sim/dex';
import type { AIPokemon } from '../types';
import { defaultBoosts } from '../types';

/** 解析 PS condition 字符串（"100/100" / "50/100 par" / "0 fnt"） */
export function parseCondition(condition: string): {
	currentHp: number;
	maxHp: number;
	hpPercent: number;
	status: string;
	fainted: boolean;
} {
	const parts = (condition || '100/100').split(' ');
	const hpParts = parts[0].split('/');
	const currentHp = parseInt(hpParts[0]) || 0;
	const maxHp = parseInt(hpParts[1]) || currentHp || 100;
	const status = parts[1] || '';
	const fainted = status === 'fnt' || currentHp === 0;
	const hpPercent = maxHp > 0 ? (currentHp / maxHp) * 100 : 0;
	return { currentHp, maxHp, hpPercent, status, fainted };
}

/** 解析 PS details 字符串（"Species, L50, M" / "Species-Forme, L100, F" / "Species-Forme"） */
export function parseDetails(details: string): {
	species: string;
	level: number;
	gender: string;
} {
	const parts = (details || '').split(',').map(s => s.trim());
	const species = parts[0] || 'Unknown';
	// L 开头的段才是等级；缺省时按 National Dex 等格式的默认 L100
	const levelPart = parts.find(p => p.startsWith('L')) || 'L100';
	const level = parseInt(levelPart.replace('L', '')) || 100;
	// 性别段是单字母 M/F/N
	const genderPart = parts.find(p => /^[MFN]$/.test(p)) || 'N';
	return { species, level, gender: genderPart };
}

/**
 * 构造 AIPokemon 的"骨架"，调用方只负责填 slot/species/stats/moves/ability/item/boosts/active
 * 等语义层字段。所有默认值（volatiles / abilityStatMod / lastMove / status 清理 / itemLost）
 * 在这里统一。
 */
export function makeAIPokemonSkeleton(spec: {
	slot: number;
	species: string;
	hp: number;
	maxHp: number;
	hpPercent: number;
	status: string;
	fainted: boolean;
	types: string[];
	ability: string;
	item: string;
	moves: string[];
	baseStats: AIPokemon['baseStats'];
	boosts?: AIPokemon['boosts'];
	active: boolean;
	level: number;
	gender: string;
	itemLost?: boolean;
	lastMove?: string;
}): AIPokemon {
	return {
		slot: spec.slot,
		species: spec.species,
		hp: spec.hp,
		maxHp: spec.maxHp,
		hpPercent: spec.hpPercent,
		status: spec.fainted ? '' : spec.status,
		sleepTurns: 0,
		toxicCounter: 0,
		types: spec.types,
		ability: spec.ability,
		item: spec.item,
		itemLost: spec.itemLost ?? false,
		moves: spec.moves,
		lastMove: spec.lastMove ?? '',
		baseStats: spec.baseStats,
		boosts: spec.boosts ?? defaultBoosts(),
		abilityStatMod: { stat: null, multiplier: 1 },
		volatiles: new Set<string>(),
		fainted: spec.fainted,
		active: spec.active,
		level: spec.level,
		gender: spec.gender,
	};
}

/** 共享的"species → types + baseStats fallback"查询，带默认空数组/中性 baseStats。 */
export function speciesDefaults(species: string): { types: string[]; baseStats: AIPokemon['baseStats'] } {
	const data = Dex.species.get(species);
	return {
		types: data?.types || [],
		baseStats: data?.baseStats || { hp: 100, atk: 100, def: 100, spa: 100, spd: 100, spe: 100 },
	};
}
