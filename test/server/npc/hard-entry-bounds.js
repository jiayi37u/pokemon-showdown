'use strict';
const assert = require('assert').strict;
const { optimisticValue, pessimisticValue } = require('../../../dist/server/npc/ai/hard/search');

describe('Hard entry bounds', () => {
	it('preserves nested entry choices, chance mass and configuration weights across sibling trees', () => {
		const leaves = [];
		const expected = lower => [0, 1].reduce((total, config) => {
			const replies = [0, 1].map(reply => {
				const visit = (path, depth, weight, entries) => {
					if (depth === 3) {
						const value = (config + 1) * 17 - reply * 13 + path.reduce((sum, n, i) => sum + (i + 1) * (n - 1) ** 3, 0);
						if (!lower) leaves.push({ config, configWeight: config ? 0.3 : 0.7,
							reply: `${reply}`, weight, value, entries });
						return value;
					}
					const values = [0, 1, 2].map(choice => {
						const entry = { key: `${config}/${reply}/${path}`, side: depth === 1 ? 'opponent' : 'self',
							choice: `${choice}`, depth };
						return [0.2, 0.8].reduce((sum, mass, chance) => sum + mass *
							visit([...path, choice, chance], depth + 1, weight * mass, [...entries, entry]), 0);
					});
					return (lower || depth === 1 ? Math.min : Math.max)(...values);
				};
				return visit([], 0, 1, []);
			});
			return total + (config ? 0.3 : 0.7) * Math.min(...replies);
		}, 0);
		const upper = expected(false), lower = expected(true);
		assert(Math.abs(optimisticValue(leaves) - upper) < 1e-9);
		assert(Math.abs(pessimisticValue(leaves) - lower) < 1e-9);
	});
});
