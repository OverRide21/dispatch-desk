const endpoint = 'https://api.sarvam.ai/v1/chat/completions';

export function sarvamEnabled() {
  return Boolean(process.env.SARVAM_API_KEY?.trim());
}

export async function interpretWithSarvam(messages, schema, signal) {
  const key = process.env.SARVAM_API_KEY?.trim();
  if (!key || signal?.aborted) return null;
  const timeout = AbortSignal.timeout(3_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'api-subscription-key': key, 'Content-Type': 'application/json' },
      redirect: 'error',
      signal: requestSignal,
      body: JSON.stringify({
        model: 'sarvam-105b', messages, temperature: 0, reasoning_effort: null, max_tokens: 128,
        response_format: { type: 'json_schema', json_schema: { name: 'dispatch_order_action', strict: true, schema } },
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const data = await response.json();
    const choice = data.choices?.[0];
    return requestSignal.aborted || choice?.finish_reason !== 'stop' ? null : choice.message?.content ?? null;
  } catch {
    return null;
  }
}
