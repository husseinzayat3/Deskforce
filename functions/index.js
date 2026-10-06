const { onRequest } = require("firebase-functions/v2/https");

const OpenAI = require("openai");

exports.agentTask = onRequest({ cors: true }, async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { prompt, apiProvider } = req.body;
    let responseText = '';
    let tokensUsed = 0;

    if (apiProvider === 'Grok') {
      const apiKey = process.env.GROK_API_KEY || 'dummy-key';
      if (apiKey !== 'dummy-key') {
        const grok = new OpenAI({ apiKey, baseURL: 'https://api.x.ai/v1' });
        const messages = [];
        messages.push({ role: "user", content: prompt });
        
        const completion = await grok.chat.completions.create({
          messages,
          model: "grok-beta",
        });
        responseText = completion.choices[0].message.content || '';
        tokensUsed = completion.usage?.total_tokens || 10;
      } else {
        responseText = "[Firebase Mock Grok Response] " + prompt;
        tokensUsed = 15;
      }
    } else if (apiProvider === 'OpenAI') {
      const apiKey = process.env.OPENAI_API_KEY || 'dummy-key';
      if (apiKey !== 'dummy-key') {
        const openai = new OpenAI({ apiKey });
        const completion = await openai.chat.completions.create({
          messages: [{ role: "user", content: prompt }],
          model: "gpt-4o-mini",
        });
        responseText = completion.choices[0].message.content || '';
        tokensUsed = completion.usage?.total_tokens || 10;
      } else {
        responseText = "[Firebase Mock OpenAI Response] " + prompt;
        tokensUsed = 20;
      }
    } else if (apiProvider === 'Ollama') {
      // For local Ollama, usually requires running locally or providing an accessible URL.
      // Assuming a reachable ollama URL in env if running remotely, otherwise mocked.
      const ollamaUrl = process.env.OLLAMA_URL || 'http://host.docker.internal:11434/api/generate';
      try {
        const fetch = require('node-fetch'); // node 18 has fetch natively, but just in case
        const ollamaRes = await fetch(ollamaUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'llama3',
            prompt: prompt,
            stream: false
          })
        });
        if (ollamaRes.ok) {
          const data = await ollamaRes.json();
          responseText = data.response;
          tokensUsed = data.eval_count || 10;
        } else {
          throw new Error("Ollama connection failed");
        }
      } catch (e) {
        responseText = "[Firebase Mock Ollama] Cannot reach " + ollamaUrl;
        tokensUsed = 5;
      }
    }

    return res.status(200).json({ response: responseText, tokens: tokensUsed });
  } catch (error) {
    console.error("Function error:", error);
    return res.status(500).json({ error: error.message });
  }
});
