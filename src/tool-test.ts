import 'dotenv/config';
import { ChatOpenAI } from '@langchain/openai';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

const llm = new ChatOpenAI({
  modelName: 'gemma-smart', // 26b を使う(e4b は精度低下する可能性)
  openAIApiKey: process.env.OPENAI_API_KEY,
  configuration: { baseURL: process.env.OPENAI_BASE_URL },
});

// シンプルなダミーツールを定義
const getCurrentWeather = tool(
  async ({ location }) => {
    return JSON.stringify({ location, temperature: 22, condition: '晴れ' });
  },
  {
    name: 'get_current_weather',
    description: '指定された地域の現在の天気を返す',
    schema: z.object({
      location: z.string().describe('天気を取得する地域名 (例: Tokyo)'),
    }),
  },
);

const llmWithTools = llm.bindTools([getCurrentWeather]);

const response = await llmWithTools.invoke([
  { role: 'user', content: '東京の今の天気を教えてください。' },
]);

console.log('=== Response ===');
console.log(response);
console.log('=== Tool Calls ===');
console.log(response.tool_calls);
