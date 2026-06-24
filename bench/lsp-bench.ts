/**
 * lsp-bench — step1.5: 自作 coding-agent の LSP 効果を before/after で測る
 *
 * 同じ固定タスクを 2 条件で走らせて比較する:
 *   - none : ツール無し (素の LLM)            ← LSP 無し
 *   - lsp  : Serena (symbol-level LSP) を bind  ← LSP 有り
 * メトリクス: 正答(期待部分文字列の一致) / 総トークン(中央値) / tool-loop 往復(中央値)。
 *
 * 実行 (neko8 上、:4000 稼働 + uv 導入済み):
 *   LSP_PROJECT=~/workspace/shuji-bonji/mcps/rxjs-mcp-server npm run lsp-bench
 *
 * env:
 *   LSP_PROJECT   Serena が解析する対象リポジトリ (lsp 条件で必須)
 *   BENCH_TASKS   タスク JSON パス (既定 bench/tasks.json)
 *   BENCH_REPEAT  各タスクの繰り返し回数 (既定 1。variance を見るなら 3 以上)
 *   MODEL_NAME / OPENAI_BASE_URL ...  coding-agent.ts と共通
 */
import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runCodingAgent, type ToolMode } from '../src/coding-agent.js';

interface Task {
  id: string;
  goal: string;
  expect: string[];
}
interface TasksFile {
  note?: string;
  tasks: Task[];
}

const tasksPath = process.env.BENCH_TASKS ?? resolve('bench/tasks.json');
const { tasks } = JSON.parse(readFileSync(tasksPath, 'utf8')) as TasksFile;
const repeat = Number(process.env.BENCH_REPEAT ?? 1);
const modes: ToolMode[] = ['none', 'lsp'];

// preflight: lsp 条件は LSP_PROJECT が実在しないと Serena が project を開けず
// 全ツールが失敗して「計測したつもり」の無効データになる。先に弾く。
if (modes.includes('lsp')) {
  const project = process.env.LSP_PROJECT;
  if (!project || !existsSync(project)) {
    console.error(
      `[preflight] LSP_PROJECT が未設定か実在しません: ${project ?? '(未設定)'}\n` +
        '  対象リポジトリを この環境(neko8) に clone し、その実在パスを指定してください。\n' +
        '  例: LSP_PROJECT=/Users/bonji/workspace/localllm-agent-practice npm run lsp-bench',
    );
    process.exit(1);
  }
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

interface Agg {
  mode: ToolMode;
  pass: number;
  n: number;
  errors: number;
  tokens: number;
  rounds: number;
}

const results: Agg[] = [];

for (const mode of modes) {
  const tokensArr: number[] = [];
  const roundsArr: number[] = [];
  let pass = 0;
  let n = 0;
  let errors = 0;

  for (const t of tasks) {
    for (let r = 0; r < repeat; r++) {
      n++;
      try {
        const res = await runCodingAgent(t.goal, { tools: mode });
        const ok = t.expect.every((e) => res.text.toLowerCase().includes(e.toLowerCase()));
        if (ok) pass++;
        tokensArr.push(res.tokens.total);
        roundsArr.push(res.rounds);
        console.error(
          `[${mode}] ${t.id} #${r + 1} ok=${ok} tokens=${res.tokens.total} rounds=${res.rounds}`,
        );
      } catch (e) {
        errors++;
        console.error(`[${mode}] ${t.id} #${r + 1} ERROR ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  results.push({ mode, pass, n, errors, tokens: median(tokensArr), rounds: median(roundsArr) });
}

console.log('\n=== step1.5 LSP before/after ===');
console.log(`tasks=${tasks.length} repeat=${repeat} model=${process.env.MODEL_NAME ?? 'gemma-smart'}`);
console.log('mode\t正答\tエラー\t総tokens(中央)\t往復(中央)');
for (const a of results) {
  const tok = a.tokens === 0 && a.errors === a.n ? 'N/A(全エラー)' : String(a.tokens);
  console.log(`${a.mode}\t${a.pass}/${a.n}\t${a.errors}/${a.n}\t${tok}\t${a.rounds}`);
}

// 差分の一言サマリ (none → lsp)。lsp が全エラーなら token 比較は出さない。
const none = results.find((r) => r.mode === 'none');
const lsp = results.find((r) => r.mode === 'lsp');
if (none && lsp) {
  let tokLine = '';
  if (lsp.errors === lsp.n) {
    tokLine = '、lsp は全エラー(収束せず) のため token 比較なし';
  } else if (none.tokens > 0) {
    const dTok = Math.round(((lsp.tokens - none.tokens) / none.tokens) * 100);
    tokLine = `、総tokens ${dTok >= 0 ? '+' : ''}${dTok}%`;
  }
  console.log(`\nLSP 有無の差: 正答 ${none.pass}/${none.n} → ${lsp.pass}/${lsp.n}${tokLine}`);
}
