import { readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const roots = ['server/src', 'scripts'];
const files = [];

async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(target);
    else if (/\.(?:js|mjs)$/.test(entry.name)) files.push(target);
  }
}

for (const root of roots) await collect(root);
const failures = [];
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    const source = await readFile(file, 'utf8');
    if (!file.endsWith(path.join('scripts', 'lint.mjs')) && /dangerouslySetInnerHTML/.test(source)) failures.push(`${file}: raw HTML injection is disallowed.`);
    if (/console\.(?:log|info|warn|error)\s*\(\s*(?:process\.env|env)\.(?:JWT_SECRET|DATABASE_URL|TEST_DATABASE_URL|SEED_PASSWORD)/i.test(source)) {
      failures.push(`${file}: possible secret-bearing console output.`);
    }
  } catch (error) {
    failures.push(`${file}: ${error.stderr?.toString().trim() || error.message}`);
  }
}

try {
  execFileSync('git', ['check-ignore', '.env'], { stdio: 'pipe' });
} catch {
  failures.push('.env is not ignored by Git.');
}

if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else {
  console.log(`Lint passed: syntax checked ${files.length} server and script files; secret/HTML guards passed; .env is ignored.`);
}
