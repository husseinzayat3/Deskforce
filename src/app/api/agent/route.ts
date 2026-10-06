import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';

export async function POST(req: NextRequest) {
  try {
    const { prompt, apiProvider, systemPrompt, maxTokens = 2500 } = await req.json();

    let responseText = '';
    let tokensUsed = 0;

    if (apiProvider === 'Grok') {
      const apiKey = process.env.GROK_API_KEY || 'dummy-key';
      if (apiKey !== 'dummy-key') {
        const grok = new OpenAI({ apiKey, baseURL: 'https://api.x.ai/v1' });
        const messages: any[] = [];
        if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
        messages.push({ role: "user", content: prompt });
        
        const completion = await grok.chat.completions.create({
          messages,
          model: "grok-3",
          max_tokens: maxTokens,
        });
        responseText = completion.choices[0].message.content || '';
        tokensUsed = completion.usage?.total_tokens || 10;
      } else {
        responseText = "[Mock Grok Response] " + prompt;
        tokensUsed = 15;
      }
    } else if (apiProvider === 'OpenAI') {
      const apiKey = process.env.OPENAI_API_KEY || 'dummy-key';
      if (apiKey !== 'dummy-key') {
        const openai = new OpenAI({ apiKey });
        const messages: any[] = [];
        if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
        messages.push({ role: "user", content: prompt });
        
        const completion = await openai.chat.completions.create({
          messages,
          model: "gpt-4o-mini",
          max_tokens: maxTokens,
        });
        responseText = completion.choices[0].message.content || '';
        tokensUsed = completion.usage?.total_tokens || 10;
      } else {
        responseText = "[Mock OpenAI Response] " + prompt;
        tokensUsed = 20;
      }
    } else if (apiProvider === 'Ollama') {
      // Local ollama server, mock or try fetching
      try {
        const ollamaPrompt = systemPrompt ? `System Instructions:\n${systemPrompt}\n\nUser Task:\n${prompt}` : prompt;
        const res = await fetch('http://127.0.0.1:11434/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'llama3', // Adjust to local available model
            prompt: ollamaPrompt,
            stream: false,
            options: { num_predict: maxTokens }
          })
        });
        if (res.ok) {
          const data = await res.json();
          responseText = data.response;
          tokensUsed = data.eval_count || 10;
        } else {
          const errText = await res.text();
          throw new Error(`Local Ollama failed: ${res.status} ${errText}`);
        }
      } catch (e: any) {
        responseText = "[Local Ollama Error] Ensure Ollama is running and the 'llama3' model is installed. Details: " + e.message;
        tokensUsed = 0;
      }
    }

    return NextResponse.json({ response: responseText, tokens: tokensUsed });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
