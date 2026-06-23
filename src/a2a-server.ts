/**
 * a2a-server — 層2: UC-6 コーディングエージェントを A2A プロトコルで公開する
 *
 * 構成:
 *   [このプロセス]
 *     ├─ A2A サーバ (@a2a-js/sdk + express)  ← Claude / 他エージェントの入口
 *     │    GET  /.well-known/agent-card.json   能力発見
 *     │    POST /a2a/jsonrpc                    message/send, message/stream, tasks/get, tasks/cancel
 *     └─ CodingAgentExecutor → runCodingAgent() (層1, LangGraph.js)
 *          └─ neko8 LiteLLM :4000 (gemma-smart) + MCP ツール群
 *
 * 判断の主体は neko8 側 (このプロセス内のエージェント)。Claude はゴールを渡すだけ。
 *
 * 使い方:
 *   npm run a2a            # :41241 で起動
 *   curl http://localhost:41241/.well-known/agent-card.json
 *
 * env:
 *   A2A_PORT          待受ポート (既定 41241)
 *   A2A_PUBLIC_URL    Agent Card に載せる公開 URL (既定 http://localhost:${port})
 *   OPENAI_BASE_URL / MODEL_NAME ...  層1 が neko8 を叩くための設定 (coding-agent.ts 参照)
 */
import 'dotenv/config';
import express from 'express';
import { randomUUID } from 'node:crypto';
import type {
  AgentCard,
  Task,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from '@a2a-js/sdk';
import {
  type AgentExecutor,
  type RequestContext,
  type ExecutionEventBus,
  DefaultRequestHandler,
  InMemoryTaskStore,
} from '@a2a-js/sdk/server';
import {
  agentCardHandler,
  jsonRpcHandler,
  UserBuilder,
} from '@a2a-js/sdk/server/express';
import { runCodingAgent } from './coding-agent.js';

const PORT = Number(process.env.A2A_PORT ?? 41241);
const PUBLIC_URL = process.env.A2A_PUBLIC_URL ?? `http://localhost:${PORT}`;
const JSONRPC_PATH = '/a2a/jsonrpc';

// ---- Agent Card: 能力発見の入口 ----
export const codingAgentCard: AgentCard = {
  name: 'neko8-coding-agent',
  description:
    'neko8 (M1 Pro) 上で動く UC-6 コーディング専門エージェント。gemma-smart を頭脳に、MCP ツールで根拠を調べつつコーディングタスクを自律実行する。',
  protocolVersion: '0.3.0',
  version: '0.1.0',
  url: `${PUBLIC_URL}${JSONRPC_PATH}`,
  preferredTransport: 'JSONRPC',
  capabilities: { streaming: true, pushNotifications: false },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [
    {
      id: 'coding-task',
      name: 'Coding task',
      description:
        'TypeScript / フロントエンド中心のコーディング支援。実装・リファクタ・調査・説明をゴール委譲で受け付ける。',
      tags: ['coding', 'typescript', 'frontend'],
      examples: [
        'RxJS の switchMap と mergeMap の使い分けをコード付きで説明して',
        'この関数を async/await にリファクタして',
      ],
    },
  ],
};

// ---- 層2 → 層1 の接着: Task ライフサイクルを回しつつ runCodingAgent を起動 ----
export class CodingAgentExecutor implements AgentExecutor {
  private cancelled = new Set<string>();

  public cancelTask = async (taskId: string): Promise<void> => {
    this.cancelled.add(taskId);
  };

  public async execute(
    ctx: RequestContext,
    bus: ExecutionEventBus,
  ): Promise<void> {
    const { taskId, contextId, userMessage, task } = ctx;

    // 1. 初回なら Task を submitted で起こす
    if (!task) {
      const initial: Task = {
        kind: 'task',
        id: taskId,
        contextId,
        status: { state: 'submitted', timestamp: new Date().toISOString() },
        history: [userMessage],
      };
      bus.publish(initial);
    }

    // 2. ユーザ入力 (text part) を取り出す
    const userText = (userMessage.parts ?? [])
      .filter((p): p is { kind: 'text'; text: string } => p.kind === 'text')
      .map((p) => p.text)
      .join('\n')
      .trim();

    if (!userText) {
      bus.publish(failed(taskId, contextId, 'text part が空です'));
      bus.finished();
      return;
    }

    const working = (note: string) =>
      bus.publish({
        kind: 'status-update',
        taskId,
        contextId,
        status: {
          state: 'working',
          timestamp: new Date().toISOString(),
          message: {
            kind: 'message',
            messageId: randomUUID(),
            role: 'agent',
            parts: [{ kind: 'text', text: note }],
            contextId,
            taskId,
          },
        },
        final: false,
      } satisfies TaskStatusUpdateEvent);

    working('working');

    try {
      // 3. 層1 (自律ループ) を起動。進捗は status-update へ中継
      const result = await runCodingAgent(userText, { onStatus: working });

      if (this.cancelled.has(taskId)) {
        bus.publish({
          kind: 'status-update',
          taskId,
          contextId,
          status: { state: 'canceled', timestamp: new Date().toISOString() },
          final: true,
        } satisfies TaskStatusUpdateEvent);
        bus.finished();
        this.cancelled.delete(taskId);
        return;
      }

      // 4. 成果物を artifact として返す
      bus.publish({
        kind: 'artifact-update',
        taskId,
        contextId,
        artifact: {
          artifactId: 'coding-result',
          name: 'answer.md',
          parts: [{ kind: 'text', text: result.text }],
        },
      } satisfies TaskArtifactUpdateEvent);

      // 5. completed (rounds / tools をメタに残す)
      bus.publish({
        kind: 'status-update',
        taskId,
        contextId,
        status: { state: 'completed', timestamp: new Date().toISOString() },
        metadata: { rounds: result.rounds, tools: result.tools },
        final: true,
      } satisfies TaskStatusUpdateEvent);
      bus.finished();
    } catch (e) {
      bus.publish(
        failed(taskId, contextId, e instanceof Error ? e.message : String(e)),
      );
      bus.finished();
    }
  }
}

function failed(
  taskId: string,
  contextId: string,
  msg: string,
): TaskStatusUpdateEvent {
  return {
    kind: 'status-update',
    taskId,
    contextId,
    status: {
      state: 'failed',
      timestamp: new Date().toISOString(),
      message: {
        kind: 'message',
        messageId: randomUUID(),
        role: 'agent',
        parts: [{ kind: 'text', text: msg }],
        contextId,
        taskId,
      },
    },
    final: true,
  };
}

/** Express アプリを組み立てる (テストから executor を差し替えられるよう関数化) */
export function buildApp(executor: AgentExecutor = new CodingAgentExecutor()) {
  const handler = new DefaultRequestHandler(
    codingAgentCard,
    new InMemoryTaskStore(),
    executor,
  );
  const app = express();
  app.use(
    '/.well-known/agent-card.json',
    agentCardHandler({ agentCardProvider: handler }),
  );
  app.use(
    JSONRPC_PATH,
    jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }),
  );
  return app;
}

// 直接起動時のみ listen (import 時は副作用なし)
if (import.meta.url === `file://${process.argv[1]}`) {
  buildApp().listen(PORT, () => {
    console.error(`🚀 neko8-coding-agent (A2A) on ${PUBLIC_URL}`);
    console.error(`   card: ${PUBLIC_URL}/.well-known/agent-card.json`);
    console.error(`   rpc : ${PUBLIC_URL}${JSONRPC_PATH}`);
  });
}
