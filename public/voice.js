const INPUT_RATE = 16_000;
const PRE_ROLL_MS = 280;
const END_OF_TURN_MS = 650;
const MAX_TURN_MS = 14_000;

function encodeWav(chunks, sourceRate) {
  const frames = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const source = new Float32Array(frames);
  let offset = 0;
  for (const chunk of chunks) {
    source.set(chunk, offset);
    offset += chunk.length;
  }
  const ratio = sourceRate / INPUT_RATE;
  const length = Math.floor(frames / ratio);
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const marker = (position, name) => {
    for (let i = 0; i < name.length; i++) view.setUint8(position + i, name.charCodeAt(i));
  };
  marker(0, 'RIFF');
  view.setUint32(4, buffer.byteLength - 8, true);
  marker(8, 'WAVE');
  marker(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, INPUT_RATE, true);
  view.setUint32(28, INPUT_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  marker(36, 'data');
  view.setUint32(40, length * 2, true);

  for (let frame = 0; frame < length; frame++) {
    const first = Math.floor(frame * ratio);
    const end = Math.min(frames, Math.max(first + 1, Math.floor((frame + 1) * ratio)));
    let sum = 0;
    for (let index = first; index < end; index++) sum += source[index];
    const sample = Math.max(-1, Math.min(1, sum / (end - first)));
    view.setInt16(44 + frame * 2, sample * (sample < 0 ? 32768 : 32767), true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function rootMeanSquare(samples) {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

async function responseMessage(response, fallback) {
  try {
    const payload = await response.json();
    return typeof payload.error === 'string' ? payload.error : fallback;
  } catch {
    return fallback;
  }
}

function requestSignal(controller) {
  return AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
}

export function createVoice({ onUtterance, onState, onError, onLevel, onInterrupt, getSessionId }) {
  let context;
  let captureModule;
  let mic;
  let starting;
  let captureGeneration = 0;
  let inputLanguage = 'indic-auto';
  let disposed = false;
  let state = 'idle';
  let transcribing;
  let playback;
  let noiseFloor = 0.003;
  let onsetMs = 0;
  let preRoll = [];
  let preRollMs = 0;
  let recording;

  function updateState() {
    const next = playback ? 'speaking' : transcribing ? 'processing' : mic ? 'listening' : 'idle';
    if (next === state) return;
    state = next;
    onState?.(next);
  }

  function resetDetection() {
    onsetMs = 0;
    preRoll = [];
    preRollMs = 0;
    recording = null;
  }

  function headers(extra) {
    const sessionId = getSessionId?.();
    return sessionId ? { ...extra, 'X-Session-Id': sessionId } : extra;
  }

  async function prepare() {
    if (disposed) throw new Error('This voice session has ended.');
    const AudioEngine = window.AudioContext || window.webkitAudioContext;
    if (!AudioEngine) throw new Error('This browser cannot play call audio. Try a recent Chromium browser.');
    if (!context) context = new AudioEngine();
    if (context.state === 'running') return;
    let timer;
    try {
      await Promise.race([
        context.resume(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Click the voice button to enable audio playback.')), 2000);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function sendRecording(chunks, rate) {
    const request = new AbortController();
    transcribing = request;
    updateState();
    try {
      const response = await fetch('/api/voice/transcribe', {
        method: 'POST',
        headers: headers({ 'Content-Type': 'audio/wav', 'X-Language': inputLanguage }),
        body: encodeWav(chunks, rate),
        signal: requestSignal(request)
      });
      if (!response.ok) throw new Error(await responseMessage(response, 'Could not transcribe that turn. Try again.'));
      const payload = await response.json();
      if (request.signal.aborted || transcribing !== request) return;
      if (typeof payload.text !== 'string' || !payload.text.trim()) {
        onError?.('I could not catch that. Try speaking a little closer to the microphone.');
        return;
      }
      await onUtterance?.({ text: payload.text.trim(), language: payload.language });
    } catch (error) {
      if (!request.signal.aborted) {
        onError?.(error.name === 'TimeoutError' ? 'Transcription took too long. Please try again.' : error.message);
      }
    } finally {
      if (transcribing === request) {
        transcribing = null;
        updateState();
      }
    }
  }

  function capture(samples, rate) {
    const level = rootMeanSquare(samples);
    onLevel?.(Math.min(1, level * 8));
    if (transcribing && !playback && !recording) return;
    const duration = samples.length * 1000 / rate;

    if (recording) {
      recording.chunks.push(samples);
      recording.duration += duration;
      recording.silence = level >= Math.max(0.009, noiseFloor * 2) ? 0 : recording.silence + duration;
      if (recording.silence >= END_OF_TURN_MS || recording.duration >= MAX_TURN_MS) {
        const { chunks } = recording;
        resetDetection();
        void sendRecording(chunks, rate);
      }
      return;
    }

    preRoll.push(samples);
    preRollMs += duration;
    while (preRollMs > PRE_ROLL_MS && preRoll.length > 1) {
      preRollMs -= preRoll.shift().length * 1000 / rate;
    }
    // Raise the floor while speaker audio is playing; microphone echo cancellation handles the rest.
    const threshold = playback ? Math.max(0.028, noiseFloor * 4) : Math.max(0.012, noiseFloor * 3);
    if (level >= threshold) {
      onsetMs += duration;
    } else {
      onsetMs = 0;
      if (!playback) noiseFloor = noiseFloor * 0.96 + Math.min(level, 0.025) * 0.04;
    }
    if (onsetMs < (playback ? 145 : 90)) return;

    const next = { chunks: preRoll, duration: preRollMs, silence: 0 };
    resetDetection();
    if (playback) {
      stopSpeaking();
      onInterrupt?.();
    }
    recording = next;
  }

  function releaseMicrophone(active) {
    if (!active) return;
    active.worklet.port.onmessage = null;
    active.source.disconnect();
    active.worklet.disconnect();
    active.silent.disconnect();
    active.stream.getTracks().forEach(track => track.stop());
  }

  function startListening(language = 'indic-auto') {
    inputLanguage = language;
    if (mic) return Promise.resolve();
    if (starting) return starting;
    const generation = ++captureGeneration;
    const request = (async () => {
      let stream;
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('Microphone access needs a secure browser context, such as localhost or HTTPS.');
        }
        await prepare();
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
        if (generation !== captureGeneration || disposed) return;
        if (!context.audioWorklet) throw new Error('This browser cannot capture live voice. Try a recent Chromium browser.');
        if (!captureModule) {
          captureModule = context.audioWorklet.addModule('/voice-capture.js').catch(error => {
            captureModule = null;
            throw error;
          });
        }
        await captureModule;
        if (generation !== captureGeneration || disposed) return;
        const source = context.createMediaStreamSource(stream);
        const worklet = new AudioWorkletNode(context, 'dispatch-voice-capture', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1]
        });
        const silent = context.createGain();
        silent.gain.value = 0;
        source.connect(worklet);
        worklet.connect(silent);
        silent.connect(context.destination);
        worklet.port.onmessage = ({ data }) => {
          if (generation === captureGeneration && mic?.worklet === worklet) capture(data, context.sampleRate);
        };
        mic = { source, worklet, silent, stream };
        stream = null;
        noiseFloor = 0.003;
        resetDetection();
        updateState();
      } catch (error) {
        if (generation !== captureGeneration || disposed) return;
        const message = error.name === 'NotAllowedError'
          ? 'Microphone access was denied. Allow it in your browser or type your message.'
          : error.name === 'NotFoundError'
            ? 'No microphone was found. Connect one or type your message.'
            : error.message;
        onError?.(message);
        throw new Error(message);
      } finally {
        stream?.getTracks().forEach(track => track.stop());
      }
    })();
    starting = request;
    void request.finally(() => {
      if (starting === request) starting = null;
    }).catch(() => {});
    return request;
  }

  function stopListening() {
    captureGeneration++;
    starting = null;
    releaseMicrophone(mic);
    mic = null;
    transcribing?.abort();
    transcribing = null;
    resetDetection();
    onLevel?.(0);
    updateState();
  }

  function haltPlayback(active) {
    active.controller.abort();
    for (const source of active.nodes) {
      try { source.stop(); } catch {}
    }
  }

  function stopSpeaking() {
    if (!playback) return;
    const active = playback;
    playback = null;
    haltPlayback(active);
    updateState();
  }

  function scheduleBuffer(active, buffer) {
    if (active.controller.signal.aborted) return;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    active.nodes.add(source);
    active.last = new Promise(resolve => {
      source.onended = () => {
        source.disconnect();
        active.nodes.delete(source);
        resolve();
      };
    });
    const start = Math.max(active.nextTime, context.currentTime + 0.045);
    source.start(start);
    active.nextTime = start + buffer.duration;
  }

  async function playPcm(response, active) {
    const rate = Number(response.headers.get('X-Sample-Rate'));
    if (!Number.isInteger(rate) || rate < 8000 || rate > 96_000 || !response.body) {
      throw new Error('The voice service returned an unsupported audio format.');
    }
    const reader = response.body.getReader();
    let previousByte = null;
    let heardAudio = false;
    try {
      while (!active.controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done || active.controller.signal.aborted) break;
        if (!value.length) continue;
        let bytes = value;
        if (previousByte !== null) {
          bytes = new Uint8Array(value.length + 1);
          bytes[0] = previousByte;
          bytes.set(value, 1);
        }
        previousByte = bytes.length % 2 ? bytes[bytes.length - 1] : null;
        const count = Math.floor(bytes.length / 2);
        if (!count) continue;
        const buffer = context.createBuffer(1, count, rate);
        const samples = buffer.getChannelData(0);
        const pcm = new DataView(bytes.buffer, bytes.byteOffset, count * 2);
        for (let index = 0; index < count; index++) samples[index] = pcm.getInt16(index * 2, true) / 32768;
        scheduleBuffer(active, buffer);
        heardAudio = true;
      }
      if (!active.controller.signal.aborted && (!heardAudio || previousByte !== null)) {
        throw new Error('The voice service ended the reply before complete audio arrived.');
      }
    } finally {
      if (active.controller.signal.aborted) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async function speak(text, language) {
    if (!text || disposed) return;
    stopSpeaking();
    const active = { controller: new AbortController(), nodes: new Set(), nextTime: 0, last: null };
    playback = active;
    updateState();
    try {
      await prepare();
      if (active.controller.signal.aborted) return;
      const response = await fetch('/api/voice/speak', {
        method: 'POST',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ text, language }),
        signal: requestSignal(active.controller)
      });
      if (!response.ok) throw new Error(await responseMessage(response, 'Could not play the reply. Try again.'));
      if (response.headers.get('Content-Type')?.startsWith('audio/pcm')) {
        await playPcm(response, active);
      } else {
        const encoded = await response.arrayBuffer();
        if (!active.controller.signal.aborted) scheduleBuffer(active, await context.decodeAudioData(encoded));
      }
      await active.last;
    } catch (error) {
      if (!active.controller.signal.aborted) {
        haltPlayback(active);
        onError?.(error.name === 'TimeoutError' ? 'Audio playback took too long. Please try again.' : error.message);
      }
    } finally {
      if (playback === active) {
        playback = null;
        updateState();
      }
    }
  }

  function dispose() {
    disposed = true;
    stopListening();
    stopSpeaking();
    if (context && context.state !== 'closed') void context.close().catch(() => {});
  }

  return { prepare, startListening, stopListening, speak, stopSpeaking, dispose };
}
