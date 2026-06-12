import 'dotenv/config';
import { ChatOpenAI } from '@langchain/openai';

const llm = new ChatOpenAI({
  modelName: process.env.MODEL_NAME ?? 'gemma-smart',
  openAIApiKey: process.env.OPENAI_API_KEY,
  configuration: { baseURL: process.env.OPENAI_BASE_URL },
  streaming: true,
});

const stream = await llm.stream([
  {
    role: 'user',
    content: 'Svelte 5 の Runes について 5 行で説明してください。',
  },
]);

for await (const chunk of stream) {
  process.stdout.write(chunk.content as string);
}
process.stdout.write('\n');
