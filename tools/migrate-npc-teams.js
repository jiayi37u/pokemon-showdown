#!/usr/bin/env node
/**
 * 一次性迁移脚本：把 data/npc/ 从旧 schema 迁到新 schema。
 *
 * 旧 team 文件：{ "format": "gen9ou", "pokemon": [...], "name"?: "..." }
 * 新 team 文件：{ "name"?: "...", "formats": ["gen9ou"], "pokemon": [...] }
 *
 * 旧 templates.json 的 teams：{ singles: {fmt:[file]}, doubles: {...}, multi: {...}, randombattle: [...] }
 * 新 templates.json 的 teams：{ teams: [file], randomFormats: [...] }
 *
 * 幂等：已经是新 schema 的文件不动。
 *
 * 跑法：node tools/migrate-npc-teams.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '..', 'data', 'npc');
const TEAMS_DIR = path.join(DATA_DIR, 'teams');
const TEMPLATES_PATH = path.join(DATA_DIR, 'templates.json');

function migrateTeamFile(filePath) {
	const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
	// 已经迁好的
	if (Array.isArray(raw.formats)) {
		console.log(`[skip] ${path.basename(filePath)} 已是新 schema`);
		return false;
	}
	if (typeof raw.format !== 'string') {
		console.log(`[warn] ${path.basename(filePath)} 没有 format 字段，跳过`);
		return false;
	}

	// 按 npc-admin 的 formatTeamJson 风格重写（保持 evs/ivs/moves 行内）
	const out = {};
	if (raw.name) out.name = raw.name;
	out.formats = [raw.format];
	out.pokemon = raw.pokemon;

	fs.writeFileSync(filePath, formatTeamJson(out));
	console.log(`[ok] ${path.basename(filePath)}  format="${raw.format}" → formats=["${raw.format}"]`);
	return true;
}

function inlineStringify(val) {
	if (Array.isArray(val)) return '[' + val.map(v => JSON.stringify(v)).join(', ') + ']';
	if (val && typeof val === 'object') {
		const parts = [];
		for (const k of Object.keys(val)) parts.push(JSON.stringify(k) + ': ' + JSON.stringify(val[k]));
		return '{ ' + parts.join(', ') + ' }';
	}
	return JSON.stringify(val);
}

function formatTeamJson(team) {
	const inlineKeys = new Set(['evs', 'ivs', 'moves']);
	const monLines = [];
	for (const mon of team.pokemon) {
		const fieldLines = [];
		for (const key of Object.keys(mon)) {
			const val = mon[key];
			if (inlineKeys.has(key)) {
				fieldLines.push('      ' + JSON.stringify(key) + ': ' + inlineStringify(val));
			} else {
				fieldLines.push('      ' + JSON.stringify(key) + ': ' + JSON.stringify(val));
			}
		}
		monLines.push('    {\n' + fieldLines.join(',\n') + '\n    }');
	}
	let buf = '{\n';
	if (team.name) {
		buf += '  ' + JSON.stringify('name') + ': ' + JSON.stringify(team.name) + ',\n';
	}
	buf += '  ' + JSON.stringify('formats') + ': ' + inlineStringify(team.formats) + ',\n';
	buf += '  ' + JSON.stringify('pokemon') + ': [\n' + monLines.join(',\n') + '\n  ]\n';
	buf += '}\n';
	return buf;
}

function migrateTemplatesFile() {
	const raw = JSON.parse(fs.readFileSync(TEMPLATES_PATH, 'utf8'));
	let changed = 0;

	for (const npcId of Object.keys(raw)) {
		const tpl = raw[npcId];
		if (!tpl.teams) continue;
		// 已经是新 schema（teams 是 string[]，randomFormats 独立）
		if (Array.isArray(tpl.teams) && Array.isArray(tpl.randomFormats)) {
			console.log(`[skip] templates.${npcId} 已是新 schema`);
			continue;
		}

		const seen = new Set();
		const flat = [];
		let randomFormats = [];
		if (Array.isArray(tpl.teams)) {
			// 过渡 schema：teams 已是 array 但没 randomFormats
			for (const f of tpl.teams) {
				if (!seen.has(f)) { seen.add(f); flat.push(f); }
			}
		} else if (tpl.teams.teams && Array.isArray(tpl.teams.teams)) {
			// 过渡 schema：teams.teams + teams.randomFormats
			for (const f of tpl.teams.teams) {
				if (!seen.has(f)) { seen.add(f); flat.push(f); }
			}
			randomFormats = tpl.teams.randomFormats || tpl.teams.randombattle || [];
		} else {
			// 旧 schema：嵌套字典
			for (const bucketKey of ['singles', 'doubles', 'multi']) {
				const bucket = tpl.teams[bucketKey];
				if (!bucket) continue;
				for (const format of Object.keys(bucket)) {
					const files = bucket[format];
					if (!Array.isArray(files)) continue;
					for (const f of files) {
						if (!seen.has(f)) { seen.add(f); flat.push(f); }
					}
				}
			}
			randomFormats = tpl.teams.randombattle || [];
		}

		delete tpl.teams;
		tpl.teams = flat;
		tpl.randomFormats = randomFormats;
		console.log(`[ok] templates.${npcId}  → ${flat.length} teams, ${randomFormats.length} random formats`);
		changed++;
	}

	if (changed) {
		fs.writeFileSync(TEMPLATES_PATH, JSON.stringify(raw, null, 2) + '\n');
	} else {
		console.log('[skip] templates.json 已是新 schema');
	}
}

function pruneDeadRefs() {
	const raw = JSON.parse(fs.readFileSync(TEMPLATES_PATH, 'utf8'));
	const existingFiles = new Set(fs.readdirSync(TEAMS_DIR).filter(f => f.endsWith('.json')));
	let pruned = 0;
	for (const npcId of Object.keys(raw)) {
		const tpl = raw[npcId];
		if (!Array.isArray(tpl.teams)) continue;
		const kept = [];
		for (const file of tpl.teams) {
			if (existingFiles.has(file)) {
				kept.push(file);
			} else {
				console.log(`[prune] templates.${npcId}  → ${file} 不存在，摘掉`);
				pruned++;
			}
		}
		tpl.teams = kept;
	}
	if (pruned) fs.writeFileSync(TEMPLATES_PATH, JSON.stringify(raw, null, 2) + '\n');
	else console.log('[skip] 无死引用');
}

function main() {
	console.log('=== 迁移 team files ===');
	const files = fs.readdirSync(TEAMS_DIR).filter(f => f.endsWith('.json'));
	let migrated = 0;
	for (const file of files) {
		if (migrateTeamFile(path.join(TEAMS_DIR, file))) migrated++;
	}
	console.log(`[summary] ${migrated}/${files.length} team files migrated`);

	console.log();
	console.log('=== 迁移 templates.json ===');
	migrateTemplatesFile();

	console.log();
	console.log('=== 清理 templates.json 中的死引用 ===');
	pruneDeadRefs();

	console.log();
	console.log('Done.');
}

main();
