import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const report = JSON.parse(readFileSync(join(process.env.DATASET_CACHE ?? '.cache', 'update-report.json'), 'utf8'));
console.log(`Archive: ${report.archive.name}\n`);
console.log(`Changed mappings: ${report.changed}; verified ${report.verified}, derived episode rules ${report.derived}, extended ${report.extended}, identified without a model ${report.resolved ?? 0}.`);
console.log(`Adjudicated in one model turn: ${report.adjudicated ?? 0} (${report.adjudicatedMatched ?? 0} matched). Codex subjects: ${report.codexSubjects} (${report.researchMatched} matched); queue left: ${report.queued.remaining} of ${report.queued.unmapped} new + ${report.queued.research} research.`);
if (report.queued.backlog) console.log(`Backlog allowance: ${report.queued.backlog.taken} of ${report.queued.backlog.eligible} eligible older subjects entered this run.`);
console.log('');
const k = (u, key) => Math.round((u?.[key] ?? 0) / 1000);
if (report.usage) console.log(`Tokens paid for: adjudication ${k(report.usage.adjudication, 'input_tokens')}k in (${k(report.usage.adjudication, 'cached_input_tokens')}k cached) / ${k(report.usage.adjudication, 'output_tokens')}k out; research ${k(report.usage.research, 'input_tokens')}k in (${k(report.usage.research, 'cached_input_tokens')}k cached) / ${k(report.usage.research, 'output_tokens')}k out.\n`);
const counts = {};
for (const row of report.report) counts[`${row.kind}/${row.status}`] = (counts[`${row.kind}/${row.status}`] ?? 0) + 1;
for (const [key, count] of Object.entries(counts).sort()) console.log(`- ${key}: ${count}`);
if (report.absent.length) console.log(`\nMapped subjects missing from Bangumi (merged or hidden; maintainer action): ${report.absent.join(', ')}`);
try {
  const summary = JSON.parse(readFileSync('sources/coverage-summary.json', 'utf8'));
  const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
  console.log('\nProgress by air-date band (TV/OVA/剧场版/WEB; the last row is every other platform):\n\n| Band | Subjects | Mapped | Episode-level | Unresolved | Unanalyzed | Episode images |\n| --- | --- | --- | --- | --- | --- | --- |');
  for (const b of summary.bands) console.log(`| ${b.label} | ${b.subjects} | ${b.mapped} (${pct(b.mapped, b.subjects)}) | ${b.episodeLevel} (${pct(b.episodeLevel, b.subjects)}) | ${b.unresolved} | ${b.unanalyzed} | ${pct(b.images.present, b.images.checked)} |`);
} catch (error) { if (error.code !== 'ENOENT') throw error; }
console.log('\nPending/error details are recorded in state/progress.json; research artifacts live under the runner cache directory.');
