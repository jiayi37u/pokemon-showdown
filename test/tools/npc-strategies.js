'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { convertStrategies } = require('../../tools/convert-npc-strategies');

describe('NPC strategy conversion', () => {
	it('preserves source species and factual choices with reproducible output', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'npc-strategies-'));
		try {
			const source = path.join(root, 'source');
			const output = path.join(root, 'output');
			fs.mkdirSync(path.join(source, 'gen6uu'), { recursive: true });
			const sets = [{ name: 'Mixed', items: ['charizarditex', 'lifeorb'], natures: ['jolly'],
				moves: [['firepunch', 'flareblitz'], ['dragondance']], evs: [{ atk: 252, spe: 252 }],
				ivs: [{ spa: 0 }], gender: 'M', details: 'Prose', tips: 'Prose', teamOptions: 'Prose' }];
			const rows = [{ speciesId: 'tornadus', sets: [{ name: 'Acrobatics', items: ['noitem'], moves: [['acrobatics']] }] },
				{ speciesId: 'charizard', overview: 'Prose', sets }];
			const raw = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
			fs.writeFileSync(path.join(source, 'gen6uu/pokemon.jsonl'), raw);
			convertStrategies(source, output);
			const first = fs.readFileSync(path.join(output, 'gen6uu.json'), 'utf8');
			const data = JSON.parse(first);
			assert.equal(data.sourceSha256, createHash('sha256').update(raw).digest('hex'));
			assert.deepEqual(Object.keys(data.species), ['charizard', 'tornadus']);
			const { details, tips, teamOptions, ...facts } = sets[0];
			assert.deepEqual(data.species.charizard, [facts]);
			assert.equal(data.species.charizard[0].abilities, undefined);
			assert.deepEqual(data.species.tornadus[0].items, ['noitem']);
			convertStrategies(source, output);
			assert.equal(fs.readFileSync(path.join(output, 'gen6uu.json'), 'utf8'), first);
			const fresh = path.join(root, 'fresh');
			convertStrategies(source, fresh);
			assert.equal(fs.readFileSync(path.join(fresh, 'gen6uu.json'), 'utf8'), first);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
