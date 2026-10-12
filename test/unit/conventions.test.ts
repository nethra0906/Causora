/**
 * Mechanical enforcement of the working agreement (IMPLEMENTATION_PLAN §5). These are the lint
 * rules the blueprint asked for, as tests: a violation fails CI rather than relying on review.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith('.ts') ? [p] : [];
  });
}
const rel = (p: string) => relative(process.cwd(), p).split(sep).join('/');
const files = sources('src');

/** Strip comments so prose that mentions a banned token does not trip the rule. */
const code = (p: string) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('Date.now() is banned outside the infrastructure clock (event time comes from the injectable clock)', () => {
  const allowed = new Set(['src/lib/time.ts']);
  const offenders = files.filter((f) => !allowed.has(rel(f)) && /\bDate\.now\s*\(/.test(code(f))).map(rel);
  assert.deepEqual(offenders, []);
});

test('no causora.* attribute is spelled as a string literal outside the contract package', () => {
  const offenders = files.filter((f) => rel(f) !== 'src/contracts/index.ts' && /['"`]causora\.(?!db['"`])[a-z_]+/.test(code(f))).map(rel);
  assert.deepEqual(offenders, []);
});

test('no x-causora-* / causora-* header is spelled as a literal outside the contract package', () => {
  const offenders = files.filter((f) => rel(f) !== 'src/contracts/index.ts' && /['"`](x-)?causora-[a-z-]+/.test(code(f))).map(rel);
  assert.deepEqual(offenders, []);
});

test('only the bus package touches the message tables, and only through publish()/subscribe()', () => {
  const offenders = files.filter((f) => !rel(f).startsWith('src/bus/') && /INTO\s+messages|FROM\s+deliveries/i.test(code(f))).map(rel);
  assert.deepEqual(offenders, []);
});

test('ground-truth fields are read only by the platform’s evaluation/derivation paths, never by analysis scoring', () => {
  const analysis = code('src/platform/analysis.ts');
  // The single permitted mention is the destructuring inside toRankable().
  const mentions = analysis.match(/experiment_id|is_fault_injected/g) ?? [];
  assert.equal(mentions.length, 2, 'only the two names inside toRankable()');
});
