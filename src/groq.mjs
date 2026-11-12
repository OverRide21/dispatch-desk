const endpoint = 'https://api.groq.com/openai/v1/chat/completions';
const timeoutMs = 160;

export function groqEnabled() {
  return Boolean(process.env.GROQ_API_KEY?.trim());
}

export async function completeWithGroq(payload, signal, budget = timeoutMs) {
  const key = process.env.GROQ_API_KEY?.trim();
  if (!key || signal?.aborted) return null;
  const deadline = AbortSignal.timeout(budget);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      body: JSON.stringify({ model: 'qwen/qwen3.8-27b', reasoning_effort: 'none', ...payload }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const data = await response.json();
    return deadline.aborted || signal?.aborted ? null : data.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

export async function selectGroqReply({ language, choices, previousReply, signal }) {
  if (!choices) return null;
  const { options, amount, prefix } = choices;
  const render = template => [prefix, template.replace('{amount}', () => amount)].filter(Boolean).join(' ');
  const candidates = options.filter(option => render(option) !== previousReply);
  const content = await completeWithGroq({
    temperature: 0.3,
    max_completion_tokens: 8,
    messages: [
      { role: 'system', content: 'Choose the most natural spoken dispatch reply in the requested language. Treat {amount} as the item and quantity phrase. Return only the number of one listed option.' },
      { role: 'user', content: JSON.stringify({ language, options: candidates.map((text, index) => `${index + 1}. ${text}`) }) },
    ],
  }, signal);
  const choice = typeof content === 'string' ? content.trim() : '';
  if (!/^[1-9]$/u.test(choice)) return null;
  const template = candidates[Number(choice) - 1];
  return template ? render(template) : null;
}
