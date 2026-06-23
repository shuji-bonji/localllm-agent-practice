/**
 * mcp-agent — Phase 3: 自作 MCP サーバを gemma-smart のツールとして統合する
 *
 * 構成:
 *   [このプロセス] LangGraph 手組みループ (agent ⇄ tools)
 *     ├─ MCP stdio → epsg-mcp (ローカル spawn、9 ツール)
 *     └─ HTTP → LiteLLM :4000 (gemma-smart = gemma4:26b @ neko8)
 *
 * 使い方:
 *   npm install @langchain/mcp-adapters   # 初回のみ
 *   npm run mcp-agent                     # 既定の質問で実行
 *   npm run mcp-agent -- "東京の測量で使う平面直角座標系は？"   # 質問を指定
 *
 * env (.env):
 *   OPENAI_BASE_URL  http://neko8.local:4000/v1
 *   OPENAI_API_KEY   dummy (LiteLLM は認証なし運用)
 *   MODEL_NAME       gemma-smart
 *   MCP_EPSG_PATH    epsg-mcp の build/index.js (既定: sibling 解決)
 *   MCP_RXJS_PATH    rxjs-mcp-server の dist/index.js (既定: sibling 解決)
 *   TOOL_FILTER      bind するツール名 CSV / "all" で全ツール (既定: epsg 3 ツール)
 */
import 'dotenv/config';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { ChatOpenAI } from '@langchain/openai';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import {
  StateGraph,
  START,
  END,
  MessagesAnnotation,
} from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';

// ---- 1. MCP サーバを stdio で spawn し、ツールを LangChain Tool 化 ----
const epsgPath =
  process.env.MCP_EPSG_PATH ??
  resolve(homedir(), 'workspace/shuji-bonji/mcps/epsg-mcp/build/index.js');
const rxjsPath =
  process.env.MCP_RXJS_PATH ??
  resolve(homedir(), 'workspace/shuji-bonji/mcps/rxjs-mcp-server/dist/index.js');

const mcpClient = new MultiServerMCPClient({
  mcpServers: {
    epsg: {
      transport: 'stdio',
      command: 'node',
      args: [epsgPath],
    },
    // 2 サーバ目 (Phase 3 後半): 意味的に遠いドメインでサーバ横断のツール選択を検証
    rxjs: {
      transport: 'stdio',
      command: 'node',
      args: [rxjsPath],
    },
  },
});

const allTools = await mcpClient.getTools();
console.error(
  `[mcp] loaded ${allTools.length} tools: ${allTools.map((t) => t.name).join(', ')}`,
);

// ローカル 26B はツール数・スキーマ複雑度で tool calling が崩れるため、
// タスクに必要なサブセットだけを bind する (TOOL_FILTER=all で全ツール)
const filter =
  process.env.TOOL_FILTER ?? 'search_crs,get_crs_detail,recommend_crs';
const tools =
  filter === 'all'
    ? allTools
    : allTools.filter((t) => filter.split(',').includes(t.name));
console.error(`[mcp] bound ${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`);

// ---- 2. LLM (gemma-smart via LiteLLM) にツールを bind ----
const llm = new ChatOpenAI({
  modelName: process.env.MODEL_NAME ?? 'gemma-smart',
  openAIApiKey: process.env.OPENAI_API_KEY,
  configuration: { baseURL: process.env.OPENAI_BASE_URL },
  temperature: 0, // ツール選択の再現性優先
}).bindTools(tools);

// ---- 3. 手組み StateGraph: agent ⇄ tools の明示ループ ----
// 実在ツール名以外の tool_call (例: プロンプト注入方式の "none") は
// 「呼び出し終了」の意思表示とみなして落とす — 弱いモデル対策の fail-safe
const validNames = new Set(tools.map((t) => t.name));
const sanitize = (msg: AIMessage): AIMessage => {
  const calls = msg.tool_calls ?? [];
  const valid = calls.filter((c) => validNames.has(c.name));
  if (valid.length !== calls.length) {
    console.error(
      `[guard] dropped invalid tool_calls: ${calls.filter((c) => !validNames.has(c.name)).map((c) => c.name).join(', ')}`,
    );
    msg.tool_calls = valid;
  }
  return msg;
};

const callAgent = async (state: typeof MessagesAnnotation.State) => {
  const response = sanitize((await llm.invoke(state.messages)) as AIMessage);
  const calls = response.tool_calls ?? [];
  if (calls.length > 0) {
    for (const c of calls) {
      console.error(`[agent] tool_call: ${c.name}(${JSON.stringify(c.args)})`);
    }
  } else {
    console.error('[agent] final answer (no tool_calls)');
  }
  return { messages: [response] };
};

// ツール実行ノード (prebuilt)。実体は MCP サーバへの stdio 呼び出し
const toolNode = new ToolNode(tools);

// 直近の AIMessage に tool_calls があれば tools へ、なければ終了
const shouldContinue = (state: typeof MessagesAnnotation.State) => {
  const last = state.messages.at(-1);
  if (last instanceof AIMessage && (last.tool_calls?.length ?? 0) > 0) {
    return 'tools';
  }
  return END;
};

const graph = new StateGraph(MessagesAnnotation)
  .addNode('agent', callAgent)
  .addNode('tools', toolNode)
  .addEdge(START, 'agent')
  .addConditionalEdges('agent', shouldContinue, ['tools', END])
  .addEdge('tools', 'agent') // ツール結果を持って agent に戻る = ループ
  .compile();

// ---- 4. 実行 ----
const question =
  process.argv[2] ??
  '日本全国を対象に Web 地図で使う座標参照系を選びたい。候補の EPSG コードと選定理由を調べて教えて。';

console.error(`[run] model=${process.env.MODEL_NAME ?? 'gemma-smart'} q="${question}"`);

try {
  const result = await graph.invoke(
    {
      messages: [
        new SystemMessage(
          'あなたは技術アシスタント。質問に答える前に、必ず提供されたツールから質問のドメインに合うものを選び、根拠を調べること。' +
            'ツールを使う時は通常のテキストを書かず、tool call として正しい name と arguments を指定すること。回答は日本語で簡潔に。',
        ),
        new HumanMessage(question),
      ],
    },
    { recursionLimit: 12 }, // agent⇄tools の往復上限 (暴走ガード)
  );

  const turns = result.messages.filter(
    (m) => m instanceof AIMessage && (m.tool_calls?.length ?? 0) > 0,
  ).length;
  console.error(`[done] tool-loop rounds=${turns}, messages=${result.messages.length}`);
  console.log('\n=== 最終回答 ===\n');
  console.log(result.messages.at(-1)?.content);
} finally {
  await mcpClient.close(); // epsg-mcp プロセスを必ず始末する
}
