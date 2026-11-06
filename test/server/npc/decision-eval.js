'use strict';
const assert = require('assert').strict;
const { buildFrame, grade } = require('../../npc/decision-eval');

describe('User-labeled Hard decision evaluation', () => {
	it('grades the selected move strictly, without accepting another move or a switch', () => {
		const request = { active: [{ moves: [{ id: 'stealthrock' }, { id: 'uturn' }] }] };
		assert.equal(grade('stealthrock', 'move 1', request).passed, true);
		assert.equal(grade('stealthrock', 'move 2', request).passed, false);
		assert.equal(grade('stealthrock', 'switch 1', request).passed, false);
		assert.equal(grade('stealthrock', undefined, request).passed, false);
	});
	it('rejects protocol containing actions after the target decision boundary', () => {
		assert.throws(() => buildFrame({ turn: 4, protocol: [
			'|turn|4', '|move|p1a: Excadrill|Earthquake|p2a: Landorus',
		] }), /must stop at the target turn/);
	});
});
