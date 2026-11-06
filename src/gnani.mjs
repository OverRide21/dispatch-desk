import { Readable } from 'node:stream';

const SAMPLE_RATE = 24_000;
const LANGUAGES = new Set(['mr-IN', 'hi-IN', 'en-IN']);

export function voiceAvailable() {
  return Boolean(process.env.GNANI_API_KEY?.trim());
}

function voiceError(message, status = 502) {
  return Object.assign(new Error(message), { status });
}

function responseError(status) {
  if (status === 401 || status === 403) {
    return voiceError('Gnani rejected the configured key or model access. Check the key and your account permissions.', 503);
  }
  if (status === 429) return voiceError('Gnani is receiving too many requests. Please try again in a moment.', 429);
  return voiceError('Gnani could not complete the audio request. Please try again.');
}

async function providerRequest(path, options, signal) {
  const key = process.env.GNANI_API_KEY?.trim();
  if (!key) throw voiceError('Live voice requires a Gnani API key on the server.', 503);
  const base = (process.env.GNANI_BASE_URL || 'https://api.vachana.ai').replace(/\/+$/, '');
  const timeout = AbortSignal.timeout(25_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await fetch(`${base}${path}`, {
      ...options,
      method: 'POST',
      headers: { ...options.headers, 'X-API-Key-ID': key },
      signal: requestSignal
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw responseError(response.status);
    }
    return response;
  } catch (error) {
    if (signal?.aborted || error.status) throw error;
    if (timeout.aborted) throw voiceError('Gnani took too long to respond. Please try again.', 504);
    throw voiceError('Could not connect to the Gnani speech service. Please try again.');
  }
}

export async function transcribe(audioBuffer, { language, signal } = {}) {
  const model = process.env.GNANI_STT_MODEL || 'prisma-v3.0';
  const requested = LANGUAGES.has(language) ? language : model === 'prisma-v2.5' ? 'hi-IN' : 'indic-auto';
  const form = new FormData();
  form.set('audio_file', new Blob([audioBuffer], { type: 'audio/wav' }), 'utterance.wav');
  form.set('language_code', requested);
  if (model !== 'prisma-v2.5') {
    form.set('model', model);
    form.set('format', 'transcribe');
  }
  const response = await providerRequest('/stt/v3', { body: form }, signal);
  const data = await response.json().catch(() => {
    throw voiceError('Gnani returned an unreadable transcript. Please try again.');
  });
  if (data.success === false || typeof data.transcript !== 'string') {
    throw voiceError('Gnani could not read that audio. Please try speaking again.');
  }
  const detected = data.detected_language_code === 'hi-en' ? 'hi-IN' : data.detected_language_code;
  return {
    text: data.transcript.trim(),
    language: LANGUAGES.has(detected) ? detected : LANGUAGES.has(requested) ? requested : 'hi-IN'
  };
}

function decodeSseEvent(event) {
  let name = '';
  const lines = [];
  for (const line of event.split(/\r?\n/)) {
    if (line.startsWith('event:')) name = line.slice(6).trim();
    if (line.startsWith('data:')) lines.push(line.slice(5).trimStart());
  }
  if (name === 'error') throw voiceError('Gnani could not generate speech for this reply.');
  if (!lines.length) return {};
  let data;
  try {
    data = JSON.parse(lines.join('\n'));
  } catch {
    throw voiceError('Gnani returned unreadable speech data.');
  }
  if (data?.type === 'error' || data?.error) throw voiceError('Gnani could not generate speech for this reply.');
  return {
    complete: name === 'complete' || data?.is_final === true,
    audio: typeof data?.audio === 'string' && data.audio ? Buffer.from(data.audio, 'base64') : null
  };
}

async function* decodeAudio(stream) {
  const decoder = new TextDecoder();
  let buffer = '';
  let heardAudio = false;
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      const result = decodeSseEvent(buffer.slice(0, boundary.index));
      buffer = buffer.slice(boundary.index + boundary[0].length);
      if (result.audio?.length) {
        heardAudio = true;
        yield result.audio;
      }
      if (result.complete) {
        if (!heardAudio) throw voiceError('Gnani returned an empty audio reply.');
        return;
      }
    }
    if (buffer.length > 2_000_000) throw voiceError('Gnani returned an oversized speech event.');
  }
  const last = decodeSseEvent(buffer + decoder.decode());
  if (last.audio?.length) {
    heardAudio = true;
    yield last.audio;
  }
  if (!last.complete || !heardAudio) throw voiceError('Gnani ended the audio reply early.');
}

export async function synthesize(text, { language, signal } = {}) {
  const locale = LANGUAGES.has(language) ? language : 'hi-IN';
  const model = process.env.GNANI_TTS_MODEL || 'timbre-v3.0';
  const v25Voices = { 'mr-IN': 'Zahira', 'hi-IN': 'Nalini', 'en-IN': 'Kaveri' };
  const voice = process.env.GNANI_TTS_VOICE || (model === 'timbre-v2.5' ? v25Voices[locale] : 'Shivani');
  const response = await providerRequest('/api/v1/tts/sse', {
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      text,
      language: locale,
      model,
      voice,
      audio_config: {
        encoding: 'linear_pcm',
        container: 'raw',
        sample_rate: SAMPLE_RATE,
        num_channels: 1,
        sample_width: 2
      }
    })
  }, signal);
  if (!response.body) throw voiceError('Gnani returned no audio stream.');
  return {
    body: Readable.toWeb(Readable.from(decodeAudio(response.body), { objectMode: false })),
    contentType: 'audio/pcm',
    sampleRate: SAMPLE_RATE
  };
}
