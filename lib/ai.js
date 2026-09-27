const PROVIDER_NAMES = {
  openai: 'ChatGPT (OpenAI)',
  gemini: 'Gemini',
  mistral: 'Mistral',
  anthropic: 'Anthropic (Claude)',
};

const SYSTEM_PROMPT =
  'Kamu adalah Ruto AI, asisten AI ramah yang membalas pesan WhatsApp dengan singkat, natural, dan santai seperti manusia. Jangan pernah bilang kamu adalah bot atau AI kecuali ditanya langsung.';

async function askOpenAI(apiKey, userText) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userText },
      ],
      max_tokens: 500,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || 'Maaf, aku belum bisa jawab itu sekarang.';
}

async function askGemini(apiKey, userText) {
  const model = 'gemini-1.5-flash';
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: userText }] }],
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (
    (data.candidates?.[0]?.content?.parts || []).map((p) => p.text).join('').trim() ||
    'Maaf, aku belum bisa jawab itu sekarang.'
  );
}

async function askMistral(apiKey, userText) {
  const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'mistral-small-latest',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userText },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Mistral error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || 'Maaf, aku belum bisa jawab itu sekarang.';
}

async function askAnthropic(apiKey, userText) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userText }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const block = (data.content || []).find((c) => c.type === 'text');
  return block?.text?.trim() || 'Maaf, aku belum bisa jawab itu sekarang.';
}

async function askRuto(provider, apiKey, userText) {
  switch (provider) {
    case 'openai':
      return askOpenAI(apiKey, userText);
    case 'gemini':
      return askGemini(apiKey, userText);
    case 'mistral':
      return askMistral(apiKey, userText);
    case 'anthropic':
    default:
      return askAnthropic(apiKey, userText);
  }
}

module.exports = { askRuto, PROVIDER_NAMES };
