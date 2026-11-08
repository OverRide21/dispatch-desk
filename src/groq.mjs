const endpoint = 'https://api.groq.com/openai/v1/chat/completions';
const timeoutMs = 1_800;

export function groqEnabled() {
  return Boolean(process.env.GROQ_API_KEY?.trim());
}

export async function selectGroqReply({ language, choices, previousReply, signal }) {
  const key = process.env.GROQ_API_KEY?.trim();
  if (!key || !choices || signal?.aborted) return null;
  const { options, amount, prefix } = choices;
  const render = template => [prefix, template.replace('{amount}', () => amount)].filter(Boolean).join(' ');
  const candidates = options.filter(option => render(option) !== previousReply);
  const deadline = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      body: JSON.stringify({
        model: 'qwen/qwen3.8-27b',
        reasoning_effort: 'none',
        temperature: 0.3,
        max_completion_tokens: 8,
        messages: [
          { role: 'system', content: 'Choose the most natural spoken dispatch reply in the requested language. Treat {amount} as the item and quantity phrase. Return only the number of one listed option.' },
          { role: 'user', content: JSON.stringify({ language, options: candidates.map((text, index) => `${index + 1}. ${text}`) }) },
        ],
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const data = await response.json();
    const choice = data.choices?.[0]?.message?.content?.trim();
    if (deadline.aborted || signal?.aborted || !/^[1-9]$/u.test(choice ?? '')) return null;
    const template = candidates[Number(choice) - 1];
    if (!template) return null;
    return render(template);
  } catch {
    return null;
  }
}
