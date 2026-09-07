import { readFileSync } from 'node:fs';
const report = JSON.parse(readFileSync('.cache/update-report.json', 'utf8'));
console.log(`Archive: ${report.archive.name}\n\nChanged mappings: ${report.changed}; Codex subjects: ${report.codexSubjects}.\n`);
const counts = {};
for (const row of report.report) counts[row.status] = (counts[row.status] ?? 0) + 1;
for (const [status, count] of Object.entries(counts)) console.log(`- ${status}: ${count}`);
console.log('\nPending/error details are recorded in state/progress.json.');
