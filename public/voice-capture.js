class DispatchVoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(2048);
    this.offset = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel?.length) return true;

    let cursor = 0;
    while (cursor < channel.length) {
      const count = Math.min(this.samples.length - this.offset, channel.length - cursor);
      this.samples.set(channel.subarray(cursor, cursor + count), this.offset);
      this.offset += count;
      cursor += count;
      if (this.offset === this.samples.length) {
        this.port.postMessage(this.samples, [this.samples.buffer]);
        this.samples = new Float32Array(2048);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('dispatch-voice-capture', DispatchVoiceCapture);
