#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import { formatSqlChecked, coerceFormatOptions } from '../src/plpgsqlFormatter';
import { readFormatConfigFile, readRepoFormatConfig } from '../src/repoFormatConfig';

interface CliArgs {
	file?: string;
	directory?: string;
	stdin?: boolean;
	config?: string;
	out?: string;
	recursive?: boolean;
	concurrency?: number;
	help?: boolean;
}

function parseArgs(): CliArgs {
	const args: CliArgs = {};
	const argv = process.argv.slice(2);

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];

		if (arg === '--file' && argv[i + 1]) {
			args.file = argv[++i];
		} else if (arg === '--directory' || arg === '-d') {
			if (argv[i + 1]) {
				args.directory = argv[++i];
			}
		} else if (arg === '--stdin') {
			args.stdin = true;
		} else if (arg === '--config' && argv[i + 1]) {
			args.config = argv[++i];
		} else if (arg === '--out' && argv[i + 1]) {
			args.out = argv[++i];
		} else if (arg === '--recursive' || arg === '-r') {
			args.recursive = true;
		} else if (arg === '--concurrency' || arg === '-j') {
			if (argv[i + 1]) {
				const concValue = parseInt(argv[++i], 10);
				if (!isNaN(concValue) && concValue > 0) {
					args.concurrency = concValue;
				}
			}
		} else if (arg === '--help' || arg === '-h') {
			args.help = true;
		}
	}

	return args;
}

function printHelp(): void {
	console.log(`pgformat - PostgreSQL SQL Formatter

Usage:
  pgformat --file <path> [--config <path>] [--out <path>]
  pgformat --directory <path> [--recursive] [--config <path>] [--out <path>] [--concurrency <n>]
  pgformat --stdin [--config <path>]
  pgformat --help

Options:
  --file <path>     Input SQL file to format
  --directory <path>, -d <path>  Directory containing SQL files to format
  --stdin           Read SQL from stdin (default if no --file)
  --config <path>   Path to .pgformat.json config file (default: .pgformat.json in current dir)
  --out <path>      Output file/directory (default: stdout for --file, overwrite for --directory)
  --recursive, -r   Search directory recursively for SQL files (used with --directory)
  --concurrency <n>, -j <n>  Number of parallel files to format (default: 5)
  --help, -h        Show this help message

Exit Codes:
  0                 Success
  1                 Formatting rejected by safety net (code unchanged)
  2                 I/O error (file not found, permission denied, etc.)

Examples:
  pgformat --file schema.sql
  pgformat --file schema.sql --config .pgformat.json --out formatted.sql
  pgformat --directory ./sql --recursive --config .pgformat.json
  pgformat --directory ./sql --out ./formatted_sql
  pgformat --directory ./sql --recursive --concurrency 10
  cat schema.sql | pgformat --stdin
  pgformat --stdin --config my-config.json < schema.sql > formatted.sql
`);
}

async function readInput(args: CliArgs): Promise<string> {
	if (args.file) {
		try {
			return fs.readFileSync(args.file, 'utf-8');
		} catch (e) {
			console.error(`Error reading file ${args.file}: ${e instanceof Error ? e.message : String(e)}`);
			process.exit(2);
		}
	}

	// Read from stdin
	return new Promise((resolve, reject) => {
		let data = '';
		process.stdin.setEncoding('utf-8');

		process.stdin.on('readable', () => {
			let chunk;
			while ((chunk = process.stdin.read()) !== null) {
				data += chunk;
			}
		});

		process.stdin.on('end', () => resolve(data));
		process.stdin.on('error', reject);
	});
}

function collectSqlFiles(dir: string, recursive: boolean = false): string[] {
	const files: string[] = [];

	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);

			if (entry.isFile() && entry.name.endsWith('.sql')) {
				files.push(fullPath);
			} else if (entry.isDirectory() && recursive) {
				files.push(...collectSqlFiles(fullPath, recursive));
			}
		}
	} catch (e) {
		console.error(`Error reading directory ${dir}: ${e instanceof Error ? e.message : String(e)}`);
		process.exit(2);
	}

	return files;
}

interface FormatResult {
	file: string;
	status: 'success' | 'skipped' | 'error';
	reason?: string;
}

async function formatFile(
	sqlFile: string,
	dirPath: string,
	outputDir: string | undefined,
	options: any
): Promise<FormatResult> {
	try {
		const input = fs.readFileSync(sqlFile, 'utf-8');
		const result = formatSqlChecked(input, options);

		if (!result.ok) {
			return {
				file: sqlFile,
				status: 'skipped',
				reason: result.reason,
			};
		}

		let outputPath: string;
		if (outputDir) {
			// Preserve directory structure in output
			const relPath = path.relative(dirPath, sqlFile);
			outputPath = path.join(outputDir, relPath);
			const outputFileDir = path.dirname(outputPath);
			fs.mkdirSync(outputFileDir, { recursive: true });
		} else {
			// Overwrite original file
			outputPath = sqlFile;
		}

		fs.writeFileSync(outputPath, result.text, 'utf-8');
		return {
			file: sqlFile,
			status: 'success',
		};
	} catch (e) {
		return {
			file: sqlFile,
			status: 'error',
			reason: e instanceof Error ? e.message : String(e),
		};
	}
}

async function formatFilesWithConcurrency(
	files: string[],
	dirPath: string,
	outputDir: string | undefined,
	options: any,
	concurrency: number = 5
): Promise<FormatResult[]> {
	const results: FormatResult[] = [];
	let index = 0;

	async function worker(): Promise<void> {
		while (index < files.length) {
			const fileIndex = index++;
			const file = files[fileIndex];
			const result = await formatFile(file, dirPath, outputDir, options);
			results[fileIndex] = result;
		}
	}

	// Create worker pool
	const workers: Promise<void>[] = [];
	for (let i = 0; i < Math.min(concurrency, files.length); i++) {
		workers.push(worker());
	}

	await Promise.all(workers);
	return results;
}

async function formatDirectory(args: CliArgs): Promise<void> {
	const dirPath = args.directory!;
	const recursive = args.recursive ?? false;

	// Collect all SQL files
	const sqlFiles = collectSqlFiles(dirPath, recursive);

	if (sqlFiles.length === 0) {
		console.log(`No SQL files found in ${dirPath}${recursive ? ' (recursive)' : ''}`);
		process.exit(0);
	}

	console.log(`Found ${sqlFiles.length} SQL file(s)`);

	const config = loadConfig(args);
	const options = coerceFormatOptions(config);

	// Ensure output directory exists if specified
	let outputDir: string | undefined;
	if (args.out) {
		outputDir = path.resolve(args.out);
		try {
			fs.mkdirSync(outputDir, { recursive: true });
		} catch (e) {
			console.error(`Error creating output directory ${outputDir}: ${e instanceof Error ? e.message : String(e)}`);
			process.exit(2);
		}
	}

	// Format files with concurrency control
	const concurrency = args.concurrency ?? 5;
	if (concurrency < 1 || concurrency > 100) {
		console.error('Error: Concurrency must be between 1 and 100');
		process.exit(2);
	}
	const results = await formatFilesWithConcurrency(sqlFiles, dirPath, outputDir, options, concurrency);

	let successCount = 0;
	let skippedCount = 0;
	let errorCount = 0;

	// Print results
	for (const result of results) {
		if (result.status === 'success') {
			console.log(`✓ ${result.file}`);
			successCount++;
		} else if (result.status === 'skipped') {
			console.log(`⊘ ${result.file} - Formatting skipped: ${result.reason}`);
			skippedCount++;
		} else {
			console.error(`✗ ${result.file} - Error: ${result.reason}`);
			errorCount++;
		}
	}

	// Print summary
	console.log(`\nSummary: ${successCount} formatted, ${skippedCount} skipped, ${errorCount} errors`);

	// Exit with error code if there were errors or all were skipped
	if (errorCount > 0 || successCount === 0) {
		process.exit(errorCount > 0 ? 2 : 1);
	}
}

function loadConfig(args: CliArgs): object {
	try {
		if (args.config) {
			return readFormatConfigFile(path.resolve(args.config));
		}
		return readRepoFormatConfig(process.cwd());
	} catch (e) {
		console.error(`Error reading config ${args.config ?? '.pgformat.json'}: ${e instanceof Error ? e.message : String(e)}`);
		process.exit(2);
	}
}

async function main(): Promise<void> {
	const args = parseArgs();

	if (args.help) {
		printHelp();
		process.exit(0);
	}

	// Handle directory formatting
	if (args.directory) {
		await formatDirectory(args);
		return;
	}

	// Handle single file or stdin formatting
	try {
		const input = await readInput(args);
		const config = loadConfig(args);
		const options = coerceFormatOptions(config);

		const result = formatSqlChecked(input, options);

		if (!result.ok) {
			console.error(`Formatting skipped: ${result.reason}`);
			process.exit(1);
		}

		const output = result.text;

		if (args.out) {
			try {
				fs.writeFileSync(args.out, output, 'utf-8');
			} catch (e) {
				console.error(`Error writing to ${args.out}: ${e instanceof Error ? e.message : String(e)}`);
				process.exit(2);
			}
		} else {
			process.stdout.write(output);
		}
	} catch (e) {
		console.error(`Formatting error: ${e instanceof Error ? e.message : String(e)}`);
		process.exit(2);
	}
}

main();
