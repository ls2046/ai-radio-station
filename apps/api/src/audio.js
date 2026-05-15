const sampleRate = 44100;

function writeString(view, offset, value) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function envelope(position, total) {
  const fadeSamples = Math.min(sampleRate * 0.08, total / 2);
  if (position < fadeSamples) return position / fadeSamples;
  if (position > total - fadeSamples) return (total - position) / fadeSamples;
  return 1;
}

export function createToneWav({
  durationSeconds = 2,
  frequency = 440,
  secondaryFrequency = 0,
  volume = 0.28,
  pulse = false
}) {
  const totalSamples = Math.floor(sampleRate * durationSeconds);
  const dataSize = totalSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  for (let sample = 0; sample < totalSamples; sample += 1) {
    const time = sample / sampleRate;
    const wobble = pulse ? 1 + Math.sin(time * Math.PI * 2 * 0.9) * 0.04 : 1;
    const primary = Math.sin(Math.PI * 2 * frequency * wobble * time);
    const secondary = secondaryFrequency
      ? Math.sin(Math.PI * 2 * secondaryFrequency * time) * 0.45
      : 0;
    const softNoise = Math.sin(Math.PI * 2 * 82 * time) * 0.08;
    const value = (primary + secondary + softNoise) * volume * envelope(sample, totalSamples);
    view.setInt16(44 + sample * 2, Math.max(-1, Math.min(1, value)) * 32767, true);
  }

  return buffer;
}

export function hostToneWav(tone = "intro") {
  const presets = {
    intro: { durationSeconds: 2.5, frequency: 220, secondaryFrequency: 330, pulse: true },
    transition: { durationSeconds: 2.0, frequency: 261.63, secondaryFrequency: 392, pulse: true },
    outro: { durationSeconds: 2.8, frequency: 196, secondaryFrequency: 293.66, pulse: true }
  };
  return createToneWav(presets[tone] ?? presets.intro);
}
