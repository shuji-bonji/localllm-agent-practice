/**
 * coding-agent — 層1: UC-6 コーディング専門エージェント本体 (A2A から呼ばれる中身)
 *
 * 役割:
 *   neko8 の gemma-smart (LiteLLM :4000) を頭脳に、コーディング支援タスクを
 *   「ゴールを受けて自分で手順を決めて」進める自律ループ。判断の主体は neko8 側。
 *   A2A サーバ (src/a2a-server.ts) はこの関数を起動し、進捗を Task として中継するだけ。
 *
 * 設計メモ:
 *   - mcp-agent.ts (Phase 3) の手組み StateGraph (agent ⇄ tools) を再利用可能な関数に整理。
 *   - MCP ツールは「あれば使う」best-effort。rxjs-mcp の dist が存在すれば bind する。
 *     存在しなければツール無しの素の LLM コーディングエージェントとして動く
 *     (neko8 :4000 さえあれば最小構成で立ち上がる)。
 *   - step1.5 の lsp-mcp はここに MCP サーバを 1 個足すだけで接続できる差込口。
 */
import { existsSync } from 'node:fs';
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
import type { StructuredToolInterface } from '@langchain/core/tools';

const SYSTEM_PROMPT =
  'あなたは熟練の TypeScript / フロントエンド開発者として振る舞うコーディング専門エージェント。' +
  '与えられたゴールに対し、必要ならツールで根拠を調べてから、簡潔で正確なコード・説明を返す。' +
  'ツールを使う時は通常のテキストを書かず、tool call として正しい name と arguments を指定すること。' +
  '回答は日本語で、コードは ```ts コードブロックで示すこと。';

export interface CodingAgentResult {
  /** 最終回答テキスト */
  text: string;
  /** agent⇄tools の往復回数 */
  rounds: number;
  /** 実際に bind したツール名 */
  tools: string[];
}

export interface RunOptions {
  /** 進捗テキストを受け取るフック (A2A の status-update へ中継する用) */
  onStatus?: (note: string) => void;
}

/** rxjs-mcp / lsp-mcp 等を best-effort で起動し、bind 可能なツール一覧を返す */
async function loadTools(): Promise<{
  client: MultiServerMCPClient | null;
  tools: StructuredToolInterface[];
}> {
  const rxjsPath =
    process.env.MCP_RXJS_PATH ??
    resolve(homedir(), 'workspace/shuji-bonji/mcps/rxjs-mcp-server/dist/index.js');

  // ツールを spawn できる実体が無ければツール無しで続行 (最小構成を壊さない)
  const servers: Record<string, { transport: 'stdio'; command: string; args: string[] }> = {};
  if (existsSync(rxjsPath)) {
    servers.rxjs = { transport: 'stdio', command: 'node', args: [rxjsPath] };
  }
  // step1.5: ここに lsp-mcp を足す
  // const lspPath = process.env.MCP_LSP_PATH; if (lspPath && existsSync(lspPath)) { servers.lsp = {...} }

  if (Object.keys(servers).length === 0) {
    return { client: null, tools: [] };
  }

  const client = new MultiServerMCPClient({ mcpServers: servers });
  const all = await client.getTools();
  // 26B はツール数・スキーマ複雑度で tool calling が崩れるため必要分だけ bind
  const filter = process.env.TOOL_FILTER ?? 'all';
  const tools =
    filter === 'all'
      ? all
      : all.filter((t) => filter.split(',').includes(t.name));
  return { client, tools };
}

/**
 * コーディングエージェントを 1 回実行する。
 * A2A executor からは「ゴール文字列を渡して最終回答を受け取る」だけで使える。
 */
export async function runCodingAgent(
  userText: string,
  opts: RunOptions = {},
): Promise<CodingAgentResult> {
  const { onStatus } = opts;
  const { client, tools } = await loadTools();
  onStatus?.(
    tools.length > 0
      ? `ツール ${tools.length} 件を読み込み: ${tools.map((t) => t.name).join(', ')}`
      : 'ツール無し (素の LLM コーディングモード)',
  );

  try {
    const baseLlm = new ChatOpenAI({
      modelName: process.env.MODEL_NAME ?? 'gemma-smart',
      openAIApiKey: process.env.OPENAI_API_KEY ?? 'dummy',
      configuration: { baseURL: process.env.OPENAI_BASE_URL },
      temperature: 0,
    });
    const llm = tools.length > 0 ? baseLlm.bindTools(tools) : baseLlm;

    const validNames = new Set(tools.map((t) => t.name));
    const sanitize = (msg: AIMessage): AIMessage => {
      const calls = msg.tool_calls ?? [];
      const valid = calls.filter((c) => validNames.has(c.name));
      if (valid.length !== calls.length) msg.tool_calls = valid;
      return msg;
    };

    const callAgent = async (state: typeof MessagesAnnotation.State) => {
      const response = sanitize((await llm.invoke(state.messages)) as AIMessage);
      const calls = response.tool_calls ?? [];
      if (calls.length > 0) {
        onStatus?.(`ツール呼び出し: ${calls.map((c) => c.name).join(', ')}`);
      }
      return { messages: [response] };
    };

    const shouldContinue = (state: typeof MessagesAnnotation.State) => {
      const last = state.messages.at(-1);
      if (last instanceof AIMessage && (last.tool_calls?.length ?? 0) > 0) {
        return 'tools';
      }
      return END;
    };

    const builder = new StateGraph(MessagesAnnotation).addNode('agent', callAgent);
    const graph =
      tools.length > 0
        ? builder
            .addNode('tools', new ToolNode(tools))
            .addEdge(START, 'agent')
            .addConditionalEdges('agent', shouldContinue, ['tools', END])
            .addEdge('tools', 'agent')
            .compile()
        : builder.addEdge(START, 'agent').addEdge('agent', END).compile();

    onStatus?.('推論を開始');
    const result = await graph.invoke(
      {
        messages: [
          new SystemMessage(SYSTEM_PROMPT),
          new HumanMessage(userText),
        ],
      },
      { recursionLimit: 12 },
    );

    const rounds = result.messages.filter(
      (m) => m instanceof AIMessage && (m.tool_calls?.length ?? 0) > 0,
    ).length;
    const last = result.messages.at(-1);
    const text =
      typeof last?.content === 'string'
        ? last.content
        : JSON.stringify(last?.content ?? '');

    return { text, rounds, tools: tools.map((t) => t.name) };
  } finally {
    await client?.close();
  }
}
