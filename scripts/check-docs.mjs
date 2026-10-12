/**
 * Mechanical doc check: every backticked repository path must exist, every "`symbol` in `path`"
 * claim must be true, and every quoted test name must exist in the suite. Run after refactors:
 *   node scripts/check-docs.mjs [file ...]      (defaults to README, interview-prep, PROGRESS, DECISIONS)
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const files = process.argv.slice(2).length ? process.argv.slice(2) : ['README.md', 'docs/interview-prep.md', 'PROGRESS.md', 'DECISIONS.md'];

const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  if (n === 'node_modules' || n === 'dist' || n === '.git') return [];
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const sourceText = (p) => (statSync(p).isDirectory() ? walk(p).filter((f) => /\.(ts|tsx|mjs)$/.test(f)).map((f) => readFileSync(f, 'utf8')).join('\n') : readFileSync(p, 'utf8'));
const testText = ['test'].flatMap(walk).filter((f) => f.endsWith('.ts')).map((f) => readFileSync(f, 'utf8')).join('\n').toLowerCase();

const looksLikePath = (s) => /^(src|docs|scripts|test|web)\//.test(s) || /^[\w.-]+\.(md|json|ts|mjs)$/.test(s);
const problems = [];

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  let checked = 0;

  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const tok = m[1].trim();
    if (!looksLikePath(tok) || /[*{}<>$]|\s/.test(tok)) continue;
    checked++;
    if (!existsSync(tok)) problems.push(`${file}: path does not exist: ${tok}`);
  }

  for (const m of text.matchAll(/`([\w.()]+)`\s+in\s+`([\w./-]+)`/g)) {
    const sym = m[1].replace(/\(\)$/, '').split('.').pop();
    if (!existsSync(m[2])) { problems.push(`${file}: path in symbol claim does not exist: ${m[2]}`); continue; }
    checked++;
    if (!sourceText(m[2]).includes(sym)) problems.push(`${file}: "${sym}" not found in ${m[2]}`);
  }

  const quoted = [...text.matchAll(/\(\s*"([^"]{20,})"\s*\)/g), ...text.matchAll(/Test:\s*"([^"]{20,})"/g), ...text.matchAll(/:\s*"([^"]{20,})"\)/g)];
  for (const m of quoted) {
    checked++;
    const name = m[1].replace(/\s+/g, ' ').toLowerCase(); // quotes may wrap across lines in the markdown
    if (!testText.includes(name)) problems.push(`${file}: no test named like "${m[1]}"`);
  }
  // relative markdown links: [text](path#anchor)
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1].split('#')[0];
    if (!target || /^(https?:|mailto:)/.test(target)) continue;
    checked++;
    const resolved = join(file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.', target);
    if (!existsSync(resolved)) problems.push(`${file}: broken link: ${m[1]}`);
  }
  console.log(`${file}: ${checked} claims checked`);
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('all documentation references resolve');
