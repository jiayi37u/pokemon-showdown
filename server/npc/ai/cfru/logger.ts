/**
 * CFRU AI - Decision Logger
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Logging system for AI decision process.
 * Supports console output and file logging for debugging and verification.
 *
 * @license MIT
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
	BattleState,
	AIPokemon,
	AIMove,
	MoveScore,
	SwitchScore,
	ScoreBreakdown,
} from './types';

/** Log levels */
export enum LogLevel {
	NONE = 0,      // No logging
	DECISION = 1,  // Final decisions only
	SCORING = 2,   // Include scoring details
	VERBOSE = 3,   // Include all details
}

/** Logger configuration */
export interface LoggerConfig {
	/** Log level for console output */
	consoleLevel: LogLevel;

	/** Log level for file output */
	fileLevel: LogLevel;

	/** Log file path (null = no file logging) */
	logFilePath: string | null;

	/** Whether to include timestamps */
	includeTimestamp: boolean;

	/** Battle ID for log identification */
	battleId: string;

	/** AI player position ('p1' | 'p2') */
	playerPosition: string;
}

/** Default logger config */
export const DEFAULT_LOGGER_CONFIG: LoggerConfig = {
	consoleLevel: LogLevel.NONE,
	fileLevel: LogLevel.DECISION,
	logFilePath: null,
	includeTimestamp: true,
	battleId: 'unknown',
	playerPosition: 'p2',
};

/** Decision log entry */
export interface DecisionLogEntry {
	turn: number;
	timestamp: string;
	phase: 'move' | 'switch' | 'team_preview';
	pokemon: string;
	decision: string;
	scores?: MoveScoreLog[];
	/** Scores grouped by target (for doubles) - Map from target name to scores */
	scoresByTarget?: Map<string, MoveScoreLog[]>;
	/** Chosen target name (for doubles) */
	chosenTarget?: string;
	switchScores?: SwitchScoreLog[];
	reasoning?: string[];
	battleState?: BattleStateLog;
}

/** Move score log (simplified for readability) */
export interface MoveScoreLog {
	move: string;
	score: number;
	breakdown: {
		base: number;
		negatives: number;
		positives: number;
		final: number;
	};
	flags: string[];
	details?: string[];
}

/** Switch score log */
export interface SwitchScoreLog {
	pokemon: string;
	score: number;
	reasons: string[];
}

/** Battle state log (simplified) */
export interface BattleStateLog {
	self: {
		active: string[];
		reserves: string[];
	};
	opponent: {
		active: string[];
		reserves: string[];
	};
	field: {
		weather: string;
		terrain: string;
		trickroom: boolean;
	};
}

/**
 * AI Decision Logger
 */
export class AIDecisionLogger {
	private config: LoggerConfig;
	private logEntries: DecisionLogEntry[] = [];
	private fileStream: fs.WriteStream | null = null;

	constructor(config: Partial<LoggerConfig> = {}) {
		this.config = { ...DEFAULT_LOGGER_CONFIG, ...config };

		// Initialize file stream if needed
		if (this.config.logFilePath && this.config.fileLevel > LogLevel.NONE) {
			this.initFileStream();
		}
	}

	/**
	 * Initialize file stream for logging
	 */
	private initFileStream(): void {
		if (!this.config.logFilePath) return;

		try {
			// Ensure directory exists
			const dir = path.dirname(this.config.logFilePath);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}

			this.fileStream = fs.createWriteStream(this.config.logFilePath, { flags: 'a' });

			// Write header
			this.fileStream.write(`\n${'='.repeat(80)}\n`);
			this.fileStream.write(`AI Decision Log - Battle: ${this.config.battleId}\n`);
			this.fileStream.write(`Player: ${this.config.playerPosition}\n`);
			this.fileStream.write(`Started: ${new Date().toISOString()}\n`);
			this.fileStream.write(`${'='.repeat(80)}\n\n`);
		} catch (e) {
			console.error(`[AILogger] Failed to initialize log file: ${e}`);
			this.fileStream = null;
		}
	}

	/**
	 * Update configuration
	 */
	updateConfig(config: Partial<LoggerConfig>): void {
		this.config = { ...this.config, ...config };

		// Reinitialize file stream if path changed
		if (config.logFilePath && config.logFilePath !== this.config.logFilePath) {
			this.closeFileStream();
			this.initFileStream();
		}
	}

	/**
	 * Log a move decision
	 * @param scoresByTarget - Optional: Map from target name to scores (for doubles multi-target logging)
	 * @param chosenTarget - Optional: Name of the chosen target (for doubles)
	 */
	logMoveDecision(
		turn: number,
		pokemon: AIPokemon,
		scores: MoveScore[],
		chosenMove: AIMove,
		state: BattleState,
		reasoning: string[] = [],
		scoresByTarget?: Map<string, MoveScore[]>,
		chosenTarget?: string
	): void {
		const entry: DecisionLogEntry = {
			turn,
			timestamp: new Date().toISOString(),
			phase: 'move',
			pokemon: `${pokemon.species} (${pokemon.hpPercent.toFixed(0)}%)`,
			decision: chosenTarget ? `Use ${chosenMove.name} on ${chosenTarget}` : `Use ${chosenMove.name}`,
			scores: this.convertMoveScores(scores),
			reasoning,
			chosenTarget,
		};

		// Convert multi-target scores if provided
		if (scoresByTarget && scoresByTarget.size > 0) {
			entry.scoresByTarget = new Map();
			for (const [targetName, targetScores] of scoresByTarget) {
				entry.scoresByTarget.set(targetName, this.convertMoveScores(targetScores));
			}
		}

		if (this.config.fileLevel >= LogLevel.VERBOSE || this.config.consoleLevel >= LogLevel.VERBOSE) {
			entry.battleState = this.convertBattleState(state);
		}

		this.addEntry(entry);
	}

	/**
	 * Log a switch decision
	 */
	logSwitchDecision(
		turn: number,
		currentPokemon: AIPokemon | null,
		switchTo: AIPokemon,
		switchScores: SwitchScoreLog[],
		reason: string,
		state: BattleState
	): void {
		const entry: DecisionLogEntry = {
			turn,
			timestamp: new Date().toISOString(),
			phase: 'switch',
			pokemon: currentPokemon ? `${currentPokemon.species}` : 'None (forced)',
			decision: `Switch to ${switchTo.species}`,
			switchScores,
			reasoning: [reason],
		};

		if (this.config.fileLevel >= LogLevel.VERBOSE || this.config.consoleLevel >= LogLevel.VERBOSE) {
			entry.battleState = this.convertBattleState(state);
		}

		this.addEntry(entry);
	}

	/**
	 * Log team preview decision
	 */
	logTeamPreview(
		turn: number,
		team: AIPokemon[],
		order: number[],
		reasoning: string[] = []
	): void {
		const entry: DecisionLogEntry = {
			turn,
			timestamp: new Date().toISOString(),
			phase: 'team_preview',
			pokemon: 'Team',
			decision: `Lead order: ${order.map(i => team[i - 1]?.species || i).join(', ')}`,
			reasoning,
		};

		this.addEntry(entry);
	}

	/**
	 * Add entry to log
	 */
	private addEntry(entry: DecisionLogEntry): void {
		this.logEntries.push(entry);

		// Console output
		if (this.config.consoleLevel > LogLevel.NONE) {
			this.printToConsole(entry);
		}

		// File output
		if (this.fileStream && this.config.fileLevel > LogLevel.NONE) {
			this.writeToFile(entry);
		}
	}

	/**
	 * Print entry to console
	 */
	private printToConsole(entry: DecisionLogEntry): void {
		const prefix = `[AI T${entry.turn} ${this.config.playerPosition}]`;

		// Basic decision
		console.log(`${prefix} ${entry.pokemon} -> ${entry.decision}`);

		// Scoring details - prefer multi-target if available (doubles)
		if (this.config.consoleLevel >= LogLevel.SCORING) {
			if (entry.scoresByTarget && entry.scoresByTarget.size > 0) {
				// Multi-target scoring (doubles)
				for (const [targetName, scores] of entry.scoresByTarget) {
					const isChosen = targetName === entry.chosenTarget;
					const marker = isChosen ? ' [CHOSEN]' : '';
					console.log(`${prefix} vs ${targetName}${marker}:`);
					this.printScores(prefix, scores);
				}
			} else if (entry.scores) {
				// Single target scoring
				console.log(`${prefix} Move Scores:`);
				this.printScores(prefix, entry.scores);
			}
		}

		// Switch scores
		if (this.config.consoleLevel >= LogLevel.SCORING && entry.switchScores) {
			console.log(`${prefix} Switch Scores:`);
			for (const score of entry.switchScores) {
				console.log(`${prefix}   ${score.pokemon}: ${score.score}`);
				if (this.config.consoleLevel >= LogLevel.VERBOSE) {
					for (const reason of score.reasons) {
						console.log(`${prefix}     - ${reason}`);
					}
				}
			}
		}

		// Reasoning
		if (entry.reasoning && entry.reasoning.length > 0) {
			console.log(`${prefix} Reasoning: ${entry.reasoning.join('; ')}`);
		}
	}

	/**
	 * Print move scores helper
	 */
	private printScores(prefix: string, scores: MoveScoreLog[]): void {
		for (const score of scores) {
			const flags = score.flags.length > 0 ? ` [${score.flags.join(', ')}]` : '';
			console.log(`${prefix}   ${score.move}: ${score.score} (${score.breakdown.negatives}/${score.breakdown.positives})${flags}`);

			if (this.config.consoleLevel >= LogLevel.VERBOSE && score.details) {
				for (const detail of score.details) {
					console.log(`${prefix}     - ${detail}`);
				}
			}
		}
	}

	/**
	 * Write entry to file
	 */
	private writeToFile(entry: DecisionLogEntry): void {
		if (!this.fileStream) return;

		const lines: string[] = [];

		// Header
		lines.push(`--- Turn ${entry.turn} | ${entry.phase.toUpperCase()} ---`);
		if (this.config.includeTimestamp) {
			lines.push(`Time: ${entry.timestamp}`);
		}
		lines.push(`Pokemon: ${entry.pokemon}`);
		lines.push(`Decision: ${entry.decision}`);

		// Move scores
		if (this.config.fileLevel >= LogLevel.SCORING && entry.scores) {
			lines.push('');
			lines.push('Move Scores:');
			for (const score of entry.scores) {
				const flags = score.flags.length > 0 ? ` [${score.flags.join(', ')}]` : '';
				lines.push(`  ${score.move}: ${score.score}${flags}`);
				lines.push(`    Base: ${score.breakdown.base}, Neg: ${score.breakdown.negatives}, Pos: +${score.breakdown.positives}, Final: ${score.breakdown.final}`);

				if (this.config.fileLevel >= LogLevel.VERBOSE && score.details) {
					for (const detail of score.details) {
						lines.push(`      - ${detail}`);
					}
				}
			}
		}

		// Switch scores
		if (this.config.fileLevel >= LogLevel.SCORING && entry.switchScores) {
			lines.push('');
			lines.push('Switch Scores:');
			for (const score of entry.switchScores) {
				lines.push(`  ${score.pokemon}: ${score.score}`);
				for (const reason of score.reasons) {
					lines.push(`    - ${reason}`);
				}
			}
		}

		// Reasoning
		if (entry.reasoning && entry.reasoning.length > 0) {
			lines.push('');
			lines.push(`Reasoning: ${entry.reasoning.join('; ')}`);
		}

		// Battle state (verbose only)
		if (this.config.fileLevel >= LogLevel.VERBOSE && entry.battleState) {
			lines.push('');
			lines.push('Battle State:');
			lines.push(`  Self Active: ${entry.battleState.self.active.join(', ')}`);
			lines.push(`  Self Reserves: ${entry.battleState.self.reserves.join(', ')}`);
			lines.push(`  Opponent Active: ${entry.battleState.opponent.active.join(', ')}`);
			lines.push(`  Opponent Reserves: ${entry.battleState.opponent.reserves.join(', ')}`);
			if (entry.battleState.field.weather) {
				lines.push(`  Weather: ${entry.battleState.field.weather}`);
			}
			if (entry.battleState.field.terrain) {
				lines.push(`  Terrain: ${entry.battleState.field.terrain}`);
			}
			if (entry.battleState.field.trickroom) {
				lines.push(`  Trick Room: active`);
			}
		}

		lines.push('');

		this.fileStream.write(lines.join('\n') + '\n');
	}

	/**
	 * Convert MoveScore array to log format
	 */
	private convertMoveScores(scores: MoveScore[]): MoveScoreLog[] {
		return scores.map(s => {
			const flags: string[] = [];
			if (s.flags.canKO) flags.push('KO');
			if (s.flags.can2HKO) flags.push('2HKO');
			if (s.flags.goesFirst) flags.push('FIRST');
			if (s.flags.isSuperEffective) flags.push('SE');
			if (s.flags.isImmune) flags.push('IMMUNE');

			return {
				move: s.move.name,
				score: s.score,
				breakdown: {
					base: s.breakdown.base,
					negatives: s.breakdown.negatives,
					positives: s.breakdown.positives,
					final: s.breakdown.final,
				},
				flags,
				details: s.breakdown.details.map(d => `${d.reason}: ${d.amount > 0 ? '+' : ''}${d.amount}`),
			};
		});
	}

	/**
	 * Convert BattleState to log format
	 */
	private convertBattleState(state: BattleState): BattleStateLog {
		return {
			self: {
				active: state.self.active.map(p => `${p.species} (${p.hpPercent.toFixed(0)}%)`),
				reserves: state.self.reserve.filter(p => !p.fainted).map(p => `${p.species} (${p.hpPercent.toFixed(0)}%)`),
			},
			opponent: {
				active: state.opponent.active.map(p => `${p.species} (${p.hpPercent.toFixed(0)}%)`),
				reserves: state.opponent.reserve.filter(p => !p.fainted).map(p => p.species),
			},
			field: {
				weather: state.field.weather || '',
				terrain: state.field.terrain || '',
				trickroom: state.field.trickroom,
			},
		};
	}

	/**
	 * Get all log entries
	 */
	getEntries(): DecisionLogEntry[] {
		return [...this.logEntries];
	}

	/**
	 * Export log to JSON
	 */
	exportJSON(): string {
		return JSON.stringify({
			battleId: this.config.battleId,
			player: this.config.playerPosition,
			entries: this.logEntries,
		}, null, 2);
	}

	/**
	 * Export log to readable text
	 */
	exportText(): string {
		const lines: string[] = [];

		lines.push(`${'='.repeat(60)}`);
		lines.push(`AI Decision Log - Battle: ${this.config.battleId}`);
		lines.push(`Player: ${this.config.playerPosition}`);
		lines.push(`Total Decisions: ${this.logEntries.length}`);
		lines.push(`${'='.repeat(60)}`);
		lines.push('');

		for (const entry of this.logEntries) {
			lines.push(`[Turn ${entry.turn}] ${entry.pokemon} -> ${entry.decision}`);

			if (entry.scores) {
				for (const score of entry.scores) {
					lines.push(`  ${score.move}: ${score.score}`);
				}
			}

			if (entry.reasoning && entry.reasoning.length > 0) {
				lines.push(`  Reason: ${entry.reasoning.join('; ')}`);
			}

			lines.push('');
		}

		return lines.join('\n');
	}

	/**
	 * Save log to file
	 */
	saveToFile(filePath: string, format: 'json' | 'text' = 'text'): void {
		try {
			const dir = path.dirname(filePath);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}

			const content = format === 'json' ? this.exportJSON() : this.exportText();
			fs.writeFileSync(filePath, content);
		} catch (e) {
			console.error(`[AILogger] Failed to save log: ${e}`);
		}
	}

	/**
	 * Close file stream
	 */
	closeFileStream(): void {
		if (this.fileStream) {
			this.fileStream.write(`\n${'='.repeat(80)}\n`);
			this.fileStream.write(`Log ended: ${new Date().toISOString()}\n`);
			this.fileStream.write(`Total decisions: ${this.logEntries.length}\n`);
			this.fileStream.write(`${'='.repeat(80)}\n`);
			this.fileStream.end();
			this.fileStream = null;
		}
	}

	/**
	 * Clear log entries
	 */
	clear(): void {
		this.logEntries = [];
	}
}

/**
 * Create a logger for a battle
 */
export function createBattleLogger(
	battleId: string,
	playerPosition: string,
	options: {
		console?: LogLevel;
		file?: LogLevel;
		logDir?: string;
	} = {}
): AIDecisionLogger {
	const logFilePath = options.logDir
		? path.join(options.logDir, `ai-log-${battleId}-${playerPosition}.txt`)
		: null;

	return new AIDecisionLogger({
		battleId,
		playerPosition,
		consoleLevel: options.console ?? LogLevel.NONE,
		fileLevel: options.file ?? LogLevel.DECISION,
		logFilePath,
	});
}
