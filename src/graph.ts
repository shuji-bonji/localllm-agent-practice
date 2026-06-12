import 'dotenv/config';
import { ChatOpenAI } from '@langchain/openai';
import {
  StateGraph,
  START,
  END,
  MessagesAnnotation,
} from '@langchain/langgraph';

const llm = new ChatOpenAI({
  modelName: process.env.MODEL_NAME ?? 'gemma-smart',
  openAIApiKey: process.env.OPENAI_API_KEY,
  configuration: { baseURL: process.env.OPENAI_BASE_URL },
});

// 1 ノードのみのシンプルなグラフ
// MessagesAnnotation は { messages: BaseMessage[] } の state を自動定義してくれる
const callLLM = async (state: typeof MessagesAnnotation.State) => {
  const response = await llm.invoke(state.messages);
  return { messages: [response] };
};

const graph = new StateGraph(MessagesAnnotation)
  .addNode('agent', callLLM)
  .addEdge(START, 'agent')
  .addEdge('agent', END)
  .compile();

// マルチターン対話のシミュレーション
let state = {
  messages: [
    {
      role: 'system' as const,
      content: 'あなたは丁寧な日本語で答える技術アシスタント。',
    },
    {
      role: 'user' as const,
      content: 'TypeScript の satisfies 演算子の用途を 1 文で。',
    },
  ],
};

const result1 = await graph.invoke(state);
console.log('Round 1:', result1.messages.at(-1)?.content);

// 続きを問う(state を引き継ぐ)
state = {
  messages: [
    ...result1.messages,
    {
      role: 'user' as const,
      content: '具体的な使用例を 1 つ示してください。',
    } as any,
  ],
};

const result2 = await graph.invoke(state);
console.log('Round 2:', result2.messages.at(-1)?.content);
