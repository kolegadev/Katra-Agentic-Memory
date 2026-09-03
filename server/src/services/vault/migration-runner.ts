/**
 * Katra Vault — F8 migration CLI entry point (contract F8).
 *
 * Thin wrapper around `runMigration` (migration.ts): argv parsing
 * (`--dry-run` default | `--apply`, `--key-file`, `--report-out`), dotenv
 * loading (server/.env then repo-root .env — the same mechanism the server
 * uses), a store built via `createVaultStore()`, and a REDACTED report
 * written to `vault-migration-report-<YYYY-MM-DD>-<mode>.json` plus a
 * <= 15-line summary on stdout. Exit 0 on success, 1 on failure.
 *
 * The runner NEVER prints key material or content: the report only ever
 * carries redacted fields (migration.ts guarantees this), and the summary
 * prints counts / static fields only.
 *
 * Exported helpers (`buildReportFileName`, `parseRunnerArgs`) are unit-tested
 * directly instead of spawning the full runner (contract criterion 7); the
 * main() flow runs only when the module is executed directly.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import { createVaultStore } from './store.js';
import { runMigration } from './migration.js';
import type { MigrationReport } from './migration.js';

export const DEFAULT_KEY_FILE = '~/.katra/keys/agentmail-lilly.key';
export const RUNNER_CALLER = Object.freeze({ user_id: 'satori', trusted: true });
export const RUNNER_OWNER_USER_ID = 'lilly';

export interface RunnerArgs {
  mode: 'dry-run' | 'apply';
  keyFile: string | null;
  reportOut: string | null;
  help: boolean;
  error: string | null;
}

const USAGE = `usage: vault-migrate [--dry-run | --apply] [--key-file PATH] [--report-out PATH]

  --dry-run      (default) scan + report only — deletes/imports NOTHING
  --apply        hard-delete legacy plaintext AgentMail docs + import the key
  --key-file     path to the AgentMail key file
                 (default ${DEFAULT_KEY_FILE})
  --report-out   JSON report destination (default ./vault-migration-report-<date>-<mode>.json)
  --help, -h     show this help

env (from server/.env or the repo-root .env):
  MONGODB_URI               Mongo connection string (required)
  DATABASE_NAME             default 'katra'
  KATRA_VAULT_MASTER_KEY    vault master key — REQUIRED for --apply`;

/** `vault-migration-report-<YYYY-MM-DD>-<mode>.json` (local date). */
export function buildReportFileName(
  mode: 'dry-run' | 'apply',
  now: Date = new Date(),
): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `vault-migration-report-${y}-${m}-${d}-${mode}.json`;
}

/** Parse CLI argv. Last mode flag wins; --dry-run is the default. */
export function parseRunnerArgs(argv: readonly string[]): RunnerArgs {
  const args: RunnerArgs = {
    mode: 'dry-run',
    keyFile: null,
    reportOut: null,
    help: false,
    error: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') args.mode = 'dry-run';
    else if (arg === '--apply') args.mode = 'apply';
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--key-file' || arg === '--report-out') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args.error = `${arg} requires a path`;
        break;
      }
      if (arg === '--key-file') args.keyFile = next;
      else args.reportOut = next;
      i++;
    } else {
      args.error = `unknown option: ${arg}`;
      break;
    }
  }
  return args;
}

/** dotenv with path resolution: server/.env first, then the repo-root .env
 *  (the runner is launched from server/ by scripts/vault-migrate.sh). */
export function loadDotEnv(): void {
  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, '.env'),
    path.join(cwd, '..', '.env'),
    path.join(cwd, '..', '..', '.env'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        dotenv.config({ path: candidate });
        return;
      }
    } catch {
      // Never fail env loading — the real error surfaces when a required
      // variable is missing.
    }
  }
}

/** <= 15 lines; counts and static fields only — never content or values. */
export function printSummary(report: MigrationReport, reportPath: string): void {
  const lines: string[] = [];
  lines.push(`[vault-migrate] mode=${report.mode} ran_at=${report.ran_at}`);
  const legacy = report.legacy_agentmail_docs;
  lines.push(`  legacy agentmail docs: ${legacy.length}`);
  const docLines = Math.min(legacy.length, 8);
  for (let i = 0; i < docLines; i++) {
    const d = legacy[i];
    lines.push(
      `    - ${d.collection} id=${String(d._id).slice(-8)} user=${d.user_id ?? '?'} score=${d.score}`,
    );
  }
  if (legacy.length > docLines) lines.push(`    … and ${legacy.length - docLines} more`);
  const totalDeleted = report.deleted.reduce((n, d) => n + d.ids.length, 0);
  const totalEmbeddings = report.deleted.reduce((n, d) => n + d.embeddings_removed, 0);
  lines.push(`  deleted: ${totalDeleted} docs across ${report.deleted.length} collection(s)`);
  lines.push(`  embeddings removed: ${totalEmbeddings}`);
  const ki = report.key_import;
  lines.push(
    `  key import: file_exists=${ki.file_exists} imported=${ki.imported} secret_id=${ki.secret_id ?? '—'} reason=${ki.reason ?? 'ok'}`,
  );
  lines.push(`  plaintext audit rows: ${report.plaintext_audit.length} (redacted)`);
  lines.push(`  full report: ${reportPath}`);
  console.log(lines.slice(0, 15).join('\n'));
}

async function main(): Promise<number> {
  const args = parseRunnerArgs(process.argv.slice(2));
  if (args.error !== null) {
    console.error(`[vault-migrate] ${args.error}`);
    console.error(USAGE);
    return 1;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  loadDotEnv();

  const mongodbUri = process.env.MONGODB_URI;
  if (!mongodbUri) {
    console.error(
      '[vault-migrate] MONGODB_URI is not set (checked server/.env and the repo-root .env)',
    );
    return 1;
  }
  if (args.mode === 'apply' && !process.env.KATRA_VAULT_MASTER_KEY) {
    console.error('[vault-migrate] KATRA_VAULT_MASTER_KEY is required for --apply');
    return 1;
  }

  const databaseName = process.env.DATABASE_NAME || 'katra';
  const home = os.homedir();
  const keyFilePath = args.keyFile ?? path.join(home, '.katra', 'keys', 'agentmail-lilly.key');
  const reportPath = path.resolve(
    args.reportOut ?? path.join(process.cwd(), buildReportFileName(args.mode)),
  );

  let client: MongoClient | null = null;
  try {
    client = new MongoClient(mongodbUri, { serverSelectionTimeoutMS: 15000 });
    await client.connect();
    const db = client.db(databaseName);
    const store = createVaultStore({ db });
    const report = await runMigration({
      db,
      store,
      caller: { ...RUNNER_CALLER },
      ownerUserId: RUNNER_OWNER_USER_ID,
      keyFilePath,
      mode: args.mode,
    });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    printSummary(report, reportPath);
    return 0;
  } catch (error) {
    console.error(
      '[vault-migrate] failed:',
      error instanceof Error ? error.message : String(error),
    );
    return 1;
  } finally {
    if (client !== null) await client.close().catch(() => undefined);
  }
}

// Run only when executed directly (esbuild bundle via scripts/vault-migrate.sh),
// never when unit tests import the exported helpers.
const isDirectRun =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.exitCode = 1;
    });
}
