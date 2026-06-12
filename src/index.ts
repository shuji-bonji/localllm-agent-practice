import 'dotenv/config';
import { ChatOpenAI } from '@langchain/openai';

const llm = new ChatOpenAI({
  modelName: process.env.MODEL_NAME ?? 'gemma-smart',
  openAIApiKey: process.env.OPENAI_API_KEY,
  configuration: {
    baseURL: process.env.OPENAI_BASE_URL,
  },
  temperature: 0.3,
});

const response = await llm.invoke([
  {
    role: 'system',
    content: 'あなたは TypeScript に詳しい技術アシスタントです。',
  },
  { role: 'user', content: 'RxJS の `switchMap` を 3 行で説明してください。' },
]);

console.log(response.content);
