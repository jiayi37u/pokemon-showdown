'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

describe('REPL socket errors', () => {
	it('closes a disconnected session without an uncaught error and keeps accepting sessions', () => {
		// A child uses the real Repl.start; test/main.js disables it in the test server.
		execFileSync(process.execPath, ['-e', `
			const assert = require('assert').strict;
			const net = require('net');
			const { Duplex } = require('stream');
			const { EventEmitter } = require('events');
			const { Repl } = require('./dist/lib/repl');
			global.Config = { repl: true };
			Repl.setupListeners = () => {};
			let connect;
			net.createServer = handler => {
				connect = handler;
				return Object.assign(new EventEmitter(), { listen() {} });
			};
			Repl.start('test', () => 42);
			function socket() {
				const output = [];
				return Object.assign(new Duplex({
					read() {},
					write(chunk, encoding, callback) { output.push(chunk.toString()); callback(); },
				}), { output });
			}
			const broken = socket();
			connect(broken);
			assert.doesNotThrow(() => broken.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
			assert(broken.destroyed);
			const healthy = socket();
			connect(healthy);
			healthy.push('6 * 7\\n');
			setImmediate(() => {
				assert(healthy.output.join('').includes('42'));
				healthy.push(null);
				healthy.destroy();
			});
		`], { cwd: path.resolve(__dirname, '../..'), stdio: 'pipe' });
	});
});
