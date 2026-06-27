#!/usr/bin/env node
// @ts-check
/**
 * accept.mjs — UC-6 単体の「外部検証ゲート」
 *
 * OpenCode（や任意のコーディングエージェント）が生成したプロジェクトを、
 * モデルの自己申告に依らず **こちら側で** typecheck / test / build を実行して
 * 緑(PASS)/赤(FAIL) を権威的に判定する。
 *
 * 背景: gpt-oss は検証を飛ばして「緑になったはず」と誤申告した実績がある
 * (opencode/eval-task-todo.md フェア比較 2026-06-23)。だから合否は
 * エージェントの外で機械的に決める。
 *
 * 依存なし(Node 標準のみ)。mikuro でそのまま動く。
 *
 * 使い方:
 *   node bench/accept.mjs <targetDir>
 *   node bench/accept.mjs ~/workspace/investigation/eval/gptoss \
 *        --model gpt-oss --task todo-app --record ~/uc6-ledger.md
 *
 * オプション:
 *   --model <name>     実績台帳に記録するモデル名
 *   --task  <id>       実績台帳に記録するタスク id
 *   --record <path>    Markdown 実績台帳に1行追記(なければ作成)
 *   --no-install       npm install / ci をスキップ(依存導入済みの再判定用)
 *
 * 終了コード: 全ステップ緑なら 0、1つでも赤なら 1。CI / ループのゲートに使える。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

// ---- 引数パース --------------------------------------------------------
const argv = process.argv.slice(2);
const opts = { dir: '.', model: '-', task: '-', record: '', install: true };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--model') opts.model = argv[++i];
  else if (a === '--task') opts.task = argv[++i];
  else if (a === '--record') opts.record = argv[++i];
  else if (a === '--no-install') opts.install = false;
  else if (!a.startsWith('--')) opts.dir = a;
}
const dir = resolve(opts.dir);

// ---- ユーティリティ ----------------------------------------------------
const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', dim: '\x1b[2m', x: '\x1b[0m' };
const ok = (s) => `${C.g}${s}${C.x}`;
const ng = (s) => `${C.r}${s}${C.x}`;

/** package.json の scripts を読む(無ければ {}) */
function readScripts() {
  const p = join(dir, 'package.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')).scripts ?? {};
  } catch {
    return null;
  }
}

/** コマンドを target dir で実行し {code, ms} を返す */
function run(cmd, args) {
  const t0 = Date.now();
  const res = spawnSync(cmd, args, {
    cwd: dir,
    stdio: 'inherit',
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  return { code: res.status ?? 1, ms: Date.now() - t0 };
}

/**
 * 1ステップを実行。npm script があればそれを、無ければ fallback を使う。
 * gate(typecheck/test/build) で npm script が無い場合は「ゲート未整備」= FAIL 扱い。
 */
function step(label, scriptName, fallback, { gate = true } = {}) {
  const scripts = readScripts();
  if (scripts === null) {
    return { label, code: 1, ms: 0, note: 'package.json なし' };
  }
  let r;
  if (scripts[scriptName]) {
    console.log(`\n${C.dim}▶ ${label}: npm run ${scriptName}${C.x}`);
    // 注意: `npm run <script> --silent` は --silent がスクリプト側 (tsc 等) に
    // 漏れて誤動作する環境がある。npm のログ抑制は env で行い、引数は渡さない。
    r = run('npm', ['run', scriptName]);
  } else if (fallback) {
    if (gate) {
      // 受け入れ条件としての script が欠落 = エージェントがゲートを用意しなかった
      console.log(`\n${C.y}▶ ${label}: "${scriptName}" script 欠落 → fallback (${fallback.join(' ')})${C.x}`);
    } else {
      console.log(`\n${C.dim}▶ ${label}: ${fallback.join(' ')}${C.x}`);
    }
    r = run(fallback[0], fallback.slice(1));
    return {
      label,
      code: r.code,
      ms: r.ms,
      note: gate ? `script 欠落(fallback判定)` : '',
    };
  } else {
    return { label, code: 1, ms: 0, note: `"${scriptName}" script 無し` };
  }
  return { label, code: r.code, ms: r.ms, note: '' };
}

// ---- 実行 --------------------------------------------------------------
console.log(`\n=== UC-6 acceptance gate ===`);
console.log(`target : ${dir}`);
console.log(`model  : ${opts.model}   task: ${opts.task}`);

if (!existsSync(join(dir, 'package.json'))) {
  console.error(ng(`\nFATAL: ${dir} に package.json が無い。対象ディレクトリを確認。`));
  process.exit(1);
}

const results = [];

// 0) 依存導入(判定対象外。失敗したら以降は走らせても無意味なので中断)
if (opts.install) {
  const useCi = existsSync(join(dir, 'package-lock.json'));
  console.log(`\n${C.dim}▶ install: npm ${useCi ? 'ci' : 'install'}${C.x}`);
  const inst = run('npm', [useCi ? 'ci' : 'install', '--no-audit', '--no-fund']);
  if (inst.code !== 0) {
    console.error(ng(`\nFAIL: 依存導入に失敗。これ以上は判定不能。`));
    process.exit(1);
  }
}

// 1) typecheck  2) test  ← 全プロジェクト共通の必須ゲート
results.push(step('typecheck', 'typecheck', ['npx', 'tsc', '--noEmit']));
results.push(step('test', 'test', ['npx', 'vitest', 'run']));

// 3) build ← プロジェクト種別で適応:
//   - build script があれば必須実行(プロジェクトが build を宣言している)
//   - 無くても root に index.html があれば「Vite アプリ」とみなし vite build
//   - どちらも無ければ「ライブラリ」= web build 不要 → SKIP(判定対象外)
//   ライブラリ課題(KVストア等)に vite build を強制しない。
{
  const scriptsNow = readScripts() ?? {};
  if (scriptsNow.build) {
    results.push(step('build', 'build', null, { gate: true }));
  } else if (existsSync(join(dir, 'index.html'))) {
    results.push(step('build', 'build', ['npx', 'vite', 'build']));
  } else {
    console.log(`\n${C.dim}▶ build: SKIP(ライブラリ＝build script も index.html も無し)${C.x}`);
    results.push({ label: 'build', code: 0, ms: 0, note: 'N/A(library)', skipped: true });
  }
}

// ---- 判定とサマリ ------------------------------------------------------
const pass = results.every((r) => r.code === 0);
console.log(`\n=== verdict ===`);
for (const r of results) {
  const mark = r.skipped ? `${C.dim}N/A ${C.x}` : r.code === 0 ? ok('PASS') : ng('FAIL');
  const sec = (r.ms / 1000).toFixed(1).padStart(5);
  console.log(`  ${mark}  ${r.label.padEnd(10)} ${sec}s ${r.note ? C.dim + r.note + C.x : ''}`);
}
console.log(`\n  OVERALL: ${pass ? ok('GREEN ✅') : ng('RED ❌')}\n`);

// ---- 実績台帳に追記(任意) ----------------------------------------------
if (opts.record) {
  const ledger = resolve(opts.record);
  const header =
    '# UC-6 実績台帳\n\n' +
    '| 日時 | model | task | typecheck | test | build | 判定 |\n' +
    '| --- | --- | --- | --- | --- | --- | --- |\n';
  if (!existsSync(ledger)) writeFileSync(ledger, header);
  const cell = (r) => (r.skipped ? '—' : r.code === 0 ? '✅' : '❌');
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const row =
    `| ${now} | ${opts.model} | ${opts.task} | ` +
    `${cell(results[0])} | ${cell(results[1])} | ${cell(results[2])} | ` +
    `${pass ? '**GREEN**' : 'RED'} |\n`;
  appendFileSync(ledger, row);
  console.log(`${C.dim}記録: ${ledger}${C.x}\n`);
}

process.exit(pass ? 0 : 1);
