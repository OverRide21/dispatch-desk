const endpoint = 'https://api.sarvam.ai/v1/chat/completions';
const speechEndpoint = 'https://api.sarvam.ai/speech-to-text';
const speechLanguages = new Set(['en-IN', 'hi-IN', 'mr-IN']);

export function sarvamEnabled() {
  return Boolean(process.env.SARVAM_API_KEY?.trim());
}

export async function transcribeWithSarvam(audio, { language, keyterms, signal } = {}) {
  const key = process.env.SARVAM_API_KEY?.trim();
  const requested = speechLanguages.has(language) ? language : 'unknown';
  const form = new FormData();
  form.set('file', new Blob([audio], { type: 'audio/wav' }), 'utterance.wav');
  form.set('model', 'saaras:v4');
  form.set('mode', 'codemix');
  form.set('language_code', requested);
  if (keyterms?.length) form.set('keyterms', JSON.stringify(keyterms));

  const response = await fetch(speechEndpoint, {
    method: 'POST', headers: { 'api-subscription-key': key }, body: form, redirect: 'error', signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const status = [401, 402, 403, 503].includes(response.status) ? 503 : response.status === 429 ? 429 : 502;
    throw Object.assign(new Error('Sarvam transcription failed.'), { status });
  }
  const data = await response.json();
  if (typeof data?.transcript !== 'string') throw new Error('Sarvam returned an unreadable transcript.');
  const detected = data.language_code === 'en-US' ? 'en-IN' : data.language_code;
  return {
    text: data.transcript.trim(),
    language: speechLanguages.has(requested) ? requested : speechLanguages.has(detected) ? detected : 'hi-IN',
  };
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
