/**
 * a2a-smoke — A2A プロトコル層 (層2) のオフライン疎通テスト
 *
 * neko8 を使わずに「Agent Card 発見 → message/send → Task 完了 → artifact 受領」の
 * 一連を検証する。層1 (runCodingAgent) は使わず、固定応答の EchoExecutor に差し替える。
 * これにより、ネットワーク非依存で A2A の配管 (Card・JSON-RPC・Task ライフサイクル) を確認できる。
 *
 *   npm run a2a:smoke
 */
import { randomUUID } from 'node:crypto';
import type {
  Task,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from '@a2a-js/sdk';
import type {
  AgentExecutor,
  RequestContext,
  ExecutionEventBus,
} from '@a2a-js/sdk/server';
import { ClientFactory } from '@a2a-js/sdk/client';

// Agent Card に載る url を本テストの待受ポートに合わせてから server を読み込む
// (codingAgentCard は import 時に env を読むため、動的 import の前に設定する)
const PORT = 41999;
const BASE = `http://localhost:${PORT}`;
process.env.A2A_PORT = String(PORT);
process.env.A2A_PUBLIC_URL = BASE;
const { buildApp } = await import('../src/a2a-server.js');

// 層1 を使わない固定応答 executor (neko8 不要)
class EchoExecutor implements AgentExecutor {
  cancelTask = async (): Promise<void> => {};
  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage } = ctx;
    bus.publish({
      kind: 'task',
      id: taskId,
      contextId,
      status: { state: 'submitted', timestamp: new Date().toISOString() },
      history: [userMessage],
    } satisfies Task);
    bus.publish({
      kind: 'status-update',
      taskId,
      contextId,
      status: { state: 'working', timestamp: new Date().toISOString() },
      final: false,
    } satisfies TaskStatusUpdateEvent);
    const echo = (userMessage.parts ?? [])
      .filter((p): p is { kind: 'text'; text: string } => p.kind === 'text')
      .map((p) => p.text)
      .join('\n');
    bus.publish({
      kind: 'artifact-update',
      taskId,
      contextId,
      artifact: {
        artifactId: 'echo',
        name: 'echo.txt',
        parts: [{ kind: 'text', text: `echo: ${echo}` }],
      },
    } satisfies TaskArtifactUpdateEvent);
    bus.publish({
      kind: 'status-update',
      taskId,
      contextId,
      status: { state: 'completed', timestamp: new Date().toISOString() },
      final: true,
    } satisfies TaskStatusUpdateEvent);
    bus.finished();
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

const server = buildApp(new EchoExecutor()).listen(PORT);
await new Promise((r) => server.once('listening', r));

try {
  // 1. Agent Card 発見
  const cardRes = await fetch(`${BASE}/.well-known/agent-card.json`);
  assert(cardRes.ok, `agent-card HTTP ${cardRes.status}`);
  const card = (await cardRes.json()) as { name: string; skills: { id: string }[] };
  assert(card.name === 'neko8-coding-agent', `card.name = ${card.name}`);
  assert(card.skills.some((s) => s.id === 'coding-task'), 'skill coding-task missing');
  console.log(`✅ Agent Card: ${card.name} / skills=[${card.skills.map((s) => s.id).join(',')}]`);

  // 2. message/send (SDK クライアント経由)
  const client = await new ClientFactory().createFromUrl(BASE);
  const result = await client.sendMessage({
    message: {
      kind: 'message',
      messageId: randomUUID(),
      role: 'user',
      parts: [{ kind: 'text', text: 'hello a2a' }],
    },
  });

  assert(result.kind === 'task', `expected task, got ${result.kind}`);
  const task = result as Task;
  assert(task.status.state === 'completed', `state = ${task.status.state}`);
  const art = task.artifacts?.[0];
  const artText =
    art?.parts?.[0] && art.parts[0].kind === 'text' ? art.parts[0].text : '';
  assert(artText === 'echo: hello a2a', `artifact text = ${artText}`);
  console.log(`✅ message/send → task ${task.status.state}, artifact="${artText}"`);

  console.log('\n✅ A2A smoke test PASSED (プロトコル層の配管 OK)');
} finally {
  server.close();
}
