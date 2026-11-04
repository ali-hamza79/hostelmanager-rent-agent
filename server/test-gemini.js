import 'dotenv/config';
import { google } from '@ai-sdk/google';
import { generateText } from 'ai';

const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
if (!apiKey) {
  console.error('Missing GOOGLE_GENERATIVE_AI_API_KEY. Add a newly generated key to server/.env.');
  process.exitCode = 1;
} else {
  const modelId = process.env.GOOGLE_GENERATIVE_AI_MODEL || 'gemini-3.6-flash';

  try {
    const result = await generateText({
      model: google(modelId),
      prompt: 'Say hello in one short sentence.',
      maxOutputTokens: 80,
    });
    console.log(`Model: ${modelId}`);
    console.log(result.text);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown provider error.';
    console.error(`Gemini test failed: ${message}`);
    process.exitCode = 1;
  }
}
