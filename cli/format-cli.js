#!/usr/bin/env node
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const plpgsqlFormatter_1 = require("../src/plpgsqlFormatter");
function parseArgs() {
    const args = {};
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--file' && argv[i + 1]) {
            args.file = argv[++i];
        }
        else if (arg === '--stdin') {
            args.stdin = true;
        }
        else if (arg === '--config' && argv[i + 1]) {
            args.config = argv[++i];
        }
        else if (arg === '--out' && argv[i + 1]) {
            args.out = argv[++i];
        }
        else if (arg === '--help' || arg === '-h') {
            args.help = true;
        }
    }
    return args;
}
function printHelp() {
    console.log(`pgformat - PostgreSQL SQL Formatter

Usage:
  pgformat --file <path> [--config <path>] [--out <path>]
  pgformat --stdin [--config <path>]
  pgformat --help

Options:
  --file <path>     Input SQL file to format
  --stdin           Read SQL from stdin (default if no --file)
  --config <path>   Path to .pgformat.json config file (default: .pgformat.json in current dir)
  --out <path>      Output file (default: stdout)
  --help, -h        Show this help message

Exit Codes:
  0                 Success
  1                 Formatting rejected by safety net (code unchanged)
  2                 I/O error (file not found, permission denied, etc.)

Examples:
  pgformat --file schema.sql
  pgformat --file schema.sql --config .pgformat.json --out formatted.sql
  cat schema.sql | pgformat --stdin
  pgformat --stdin --config my-config.json < schema.sql > formatted.sql
`);
}
async function readInput(args) {
    if (args.file) {
        try {
            return fs.readFileSync(args.file, 'utf-8');
        }
        catch (e) {
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
function loadConfig(args) {
    let config = {};
    // Try to load from specified --config or default .pgformat.json
    const configPath = args.config || '.pgformat.json';
    try {
        if (fs.existsSync(configPath)) {
            const content = fs.readFileSync(configPath, 'utf-8');
            config = JSON.parse(content);
        }
    }
    catch (e) {
        console.error(`Error reading config ${configPath}: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(2);
    }
    return config;
}
async function main() {
    const args = parseArgs();
    if (args.help) {
        printHelp();
        process.exit(0);
    }
    try {
        const input = await readInput(args);
        const config = loadConfig(args);
        const options = (0, plpgsqlFormatter_1.coerceFormatOptions)(config);
        const result = (0, plpgsqlFormatter_1.formatSqlChecked)(input, options);
        if (!result.ok) {
            console.error(`Formatting skipped: ${result.reason}`);
            process.exit(1);
        }
        const output = result.text;
        if (args.out) {
            try {
                fs.writeFileSync(args.out, output, 'utf-8');
            }
            catch (e) {
                console.error(`Error writing to ${args.out}: ${e instanceof Error ? e.message : String(e)}`);
                process.exit(2);
            }
        }
        else {
            process.stdout.write(output);
        }
    }
    catch (e) {
        console.error(`Formatting error: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(2);
    }
}
main();
//# sourceMappingURL=format-cli.js.map