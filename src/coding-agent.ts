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

/**
 * ツール構成:
 *  - 'auto': 既存の best-effort (rxjs-mcp があれば bind) — A2A の既定
 *  - 'none': ツール無し (素の LLM) — step1.5 の LSP 無し条件
 *  - 'lsp' : Serena (symbol-level LSP) を bind — step1.5 の LSP 有り条件
 */
export type ToolMode = 'none' | 'lsp' | 'auto';

export interface CodingAgentResult {
  /** 最終回答テキスト */
  text: string;
  /** agent⇄tools の往復回数 */
  rounds: number;
  /** 実際に bind したツール名 */
  tools: string[];
  /** ループ全体のトークン使用量 (usage_metadata 集計) */
  tokens: { input: number; output: number; total: number };
}

export interface RunOptions {
  /** 進捗テキストを受け取るフック (A2A の status-update へ中継する用) */
  onStatus?: (note: string) => void;
  /** ツール構成 (既定 'auto')。step1.5 計測は 'none' / 'lsp' を切替える */
  tools?: ToolMode;
}

type StdioServer = { transport: 'stdio'; command: string; args: string[] };

/**
 * モードに応じて MCP サーバを spawn し、bind 可能なツール一覧を返す。
 *  - 'none': 何も起動しない
 *  - 'lsp' : Serena (symbol-level LSP) を起動。LSP_PROJECT に対象リポジトリが必要
 *  - 'auto': rxjs-mcp を best-effort (dist があれば)
 * spawn できる実体が無ければツール無しで続行 (最小構成を壊さない)。
 */
async function loadTools(mode: ToolMode): Promise<{
  client: MultiServerMCPClient | null;
  tools: StructuredToolInterface[];
}> {
  if (mode === 'none') {
    return { client: null, tools: [] };
  }

  const servers: Record<string, StdioServer> = {};
  let filter: string;

  if (mode === 'lsp') {
    // step1.5: Serena を計測器として繋ぐ。symbol 名で呼べるため 26B でも通りやすい。
    const project = process.env.LSP_PROJECT;
    if (!project) {
      throw new Error("tools:'lsp' には LSP_PROJECT (対象リポジトリの絶対パス) が必要です");
    }
    const command = process.env.SERENA_CMD ?? 'uvx';
    // 既定は uvx で oraios/serena を取得し stdio 起動。SERENA_ARGS で上書き可 (CSV)
    const baseArgs = (
      process.env.SERENA_ARGS ??
      '--from,git+https://github.com/oraios/serena,serena,start-mcp-server,--context,ide-assistant,--transport,stdio'
    ).split(',');
    servers.serena = { transport: 'stdio', command, args: [...baseArgs, '--project', project] };
    // 26B のツール過多崩れ対策: read-only な symbol 系 3 つだけ bind
    filter =
      process.env.LSP_TOOL_FILTER ??
      'find_symbol,find_referencing_symbols,get_symbols_overview';
  } else {
    // 'auto': 既存の best-effort (rxjs-mcp があれば)
    const rxjsPath =
      process.env.MCP_RXJS_PATH ??
      resolve(homedir(), 'workspace/shuji-bonji/mcps/rxjs-mcp-server/dist/index.js');
    if (existsSync(rxjsPath)) {
      servers.rxjs = { transport: 'stdio', command: 'node', args: [rxjsPath] };
    }
    filter = process.env.TOOL_FILTER ?? 'all';
  }

  if (Object.keys(servers).length === 0) {
    return { client: null, tools: [] };
  }

  const client = new MultiServerMCPClient({ mcpServers: servers });
  const all = await client.getTools();
  const tools =
    filter === 'all' ? all : all.filter((t) => filter.split(',').includes(t.name));
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
  const mode: ToolMode = opts.tools ?? 'auto';
  const { client, tools } = await loadTools(mode);
  onStatus?.(
    tools.length > 0
      ? `ツール ${tools.length} 件を読み込み (mode=${mode}): ${tools.map((t) => t.name).join(', ')}`
      : `ツール無し (mode=${mode}, 素の LLM コーディングモード)`,
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

    // ループ全体のトークンを集計 (各 AIMessage の usage_metadata を合算)
    let input = 0;
    let output = 0;
    for (const m of result.messages) {
      if (m instanceof AIMessage && m.usage_metadata) {
        input += m.usage_metadata.input_tokens ?? 0;
        output += m.usage_metadata.output_tokens ?? 0;
      }
    }

    return {
      text,
      rounds,
      tools: tools.map((t) => t.name),
      tokens: { input, output, total: input + output },
    };
  } finally {
    await client?.close();
  }
}
