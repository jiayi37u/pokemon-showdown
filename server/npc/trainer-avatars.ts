import { Utils } from '../../lib';

const catalogue: { source: string, avatars: Record<string, string> } = require('../../data/npc/trainer-avatars.json');

export const TRAINER_AVATAR_SOURCE = catalogue.source;
export const TRAINER_AVATAR_LIMIT = 10;

export function hasTrainerAvatar(id: string): boolean {
	return Object.prototype.hasOwnProperty.call(catalogue.avatars, id);
}

export function trainerAvatarCredit(id: string): string {
	return hasTrainerAvatar(id) ? catalogue.avatars[id] : '';
}

/** Prefer exact/partial matches; permit small typos in a trainer name or full variant ID. */
export function searchTrainerAvatars(query: string): { total: number, ids: string[] } {
	const key = toID(query);
	if (query.trim() && !key) return { total: 0, ids: [] };
	const matches: { id: string, score: number }[] = [];
	for (const id of Object.keys(catalogue.avatars)) {
		const normalized = toID(id);
		let score: number;
		if (!key || normalized === key) {
			score = 0;
		} else if (normalized.startsWith(key)) {
			score = 1;
		} else if (normalized.includes(key)) {
			score = 2;
		} else {
			if (key.length < 3) continue;
			const limit = key.length < 5 ? 1 : 2;
			const distance = Math.min(
				Utils.levenshtein(normalized, key, limit),
				Utils.levenshtein(id.split('-')[0], key, limit)
			);
			if (distance > limit) continue;
			score = 3 + distance;
		}
		matches.push({ id, score });
	}
	const directMatches = matches.filter(match => match.score < 3);
	const results = directMatches.length ? directMatches : matches;
	results.sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));
	return { total: results.length, ids: results.slice(0, TRAINER_AVATAR_LIMIT).map(match => match.id) };
}
