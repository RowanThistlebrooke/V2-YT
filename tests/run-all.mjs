// Runs every test_*.mjs file in this directory as its own subprocess (each
// manages its own env vars/global.fetch stubbing and calls process.exit
// itself), aggregates pass/fail counts, and exits non-zero if anything
// failed — this is what `npm test` and CI both invoke.
import { readdirSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(__dirname)
  .filter(f => f.startsWith('test_') && f.endsWith('.mjs'))
  .sort();

let totalPass = 0, totalFail = 0;
const failedFiles = [];

for (const file of files) {
  process.stdout.write('\n=== ' + file + ' ===\n');
  const result = spawnSync(process.execPath, [path.join(__dirname, file)], { encoding: 'utf8' });
  process.stdout.write(result.stdout || '');
  if (result.stderr) process.stderr.write(result.stderr);

  const summary = /---\s*(\d+)\s*passed,\s*(\d+)\s*failed\s*---/.exec(result.stdout || '');
  if (summary) {
    totalPass += Number(summary[1]);
    totalFail += Number(summary[2]);
    if (Number(summary[2]) > 0) failedFiles.push(file);
  } else {
    // File crashed before printing a summary (uncaught exception) — count as one failure.
    totalFail += 1;
    failedFiles.push(file);
  }
  if (result.status !== 0 && !summary) {
    process.stdout.write(file + ' exited with status ' + result.status + ' and no test summary — treated as a failure.\n');
  }
}

console.log('\n============================');
console.log(totalPass, 'passed,', totalFail, 'failed across', files.length, 'files');
if (failedFiles.length) console.log('Failed files:', failedFiles.join(', '));
console.log('============================');
process.exit(totalFail > 0 ? 1 : 0);
