const maxDailyLimit = 1_000_000_000;
const statement = (sql, ...args) => ({ sql, args });

function usageError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

export function wavDurationMilliseconds(input) {
  const invalid = () => usageError(400, 'voice-invalid-wav', 'Send a valid PCM WAV recording.');
  if (input.length < 44 || input.toString('ascii', 0, 4) !== 'RIFF' ||
      input.toString('ascii', 8, 12) !== 'WAVE') throw invalid();
  const end = input.readUInt32LE(4) + 8;
  if (end !== input.length) throw invalid();
  let blockAlign, sampleRate, dataBytes;
  for (let offset = 12; offset + 8 <= end;) {
    const kind = input.toString('ascii', offset, offset + 4);
    const size = input.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size + (size % 2) > end) throw invalid();
    if (kind === 'fmt ') {
      if (blockAlign || size < 16) throw invalid();
      const format = input.readUInt16LE(start);
      const channels = input.readUInt16LE(start + 2);
      sampleRate = input.readUInt32LE(start + 4);
      const byteRate = input.readUInt32LE(start + 8);
      blockAlign = input.readUInt16LE(start + 12);
      const bits = input.readUInt16LE(start + 14);
      if (format !== 1 || channels < 1 || channels > 8 || sampleRate < 8000 || sampleRate > 192_000 ||
          ![8, 16, 24, 32].includes(bits) || blockAlign !== channels * bits / 8 ||
          byteRate !== blockAlign * sampleRate) throw invalid();
    } else if (kind === 'data') {
      if (dataBytes !== undefined) throw invalid();
      dataBytes = size;
    }
    offset = start + size + (size % 2);
    if (offset < end && offset + 8 > end) throw invalid();
  }
  if (!blockAlign || !dataBytes || dataBytes % blockAlign) throw invalid();
  return Math.ceil(dataBytes / (blockAlign * sampleRate) * 1000);
}

export async function setupVoiceUsage(db) {
  await db.batch([
    `CREATE TABLE IF NOT EXISTS voice_usage_limits (
      workspace_id TEXT PRIMARY KEY,
      transcription_seconds INTEGER CHECK (transcription_seconds >= 0),
      synthesis_characters INTEGER CHECK (synthesis_characters >= 0)
    ) STRICT`,
    `CREATE TABLE IF NOT EXISTS voice_call_usage (
      workspace_id TEXT NOT NULL, day TEXT NOT NULL, call_id TEXT NOT NULL,
      transcription_ms INTEGER NOT NULL CHECK (transcription_ms >= 0),
      synthesis_chars INTEGER NOT NULL CHECK (synthesis_chars >= 0),
      PRIMARY KEY (workspace_id, day, call_id)
    ) STRICT`,
    `CREATE INDEX IF NOT EXISTS voice_usage_by_call ON voice_call_usage (workspace_id, call_id)`,
  ], 'write');
}

const totalUsage = `SELECT COALESCE(SUM(transcription_ms), 0) AS transcriptionMs,
  COALESCE(SUM(synthesis_chars), 0) AS synthesisCharacters FROM voice_call_usage`;
const readLimits = `SELECT transcription_seconds AS transcriptionSeconds,
  synthesis_characters AS synthesisCharacters FROM voice_usage_limits WHERE workspace_id = ?`;
const reserveUsage = `
  WITH incoming(workspace_id, day, call_id, transcription_ms, synthesis_chars) AS (VALUES (?, ?, ?, ?, ?)),
    totals AS (
      SELECT COALESCE(SUM(u.transcription_ms), 0) AS transcription_ms,
             COALESCE(SUM(u.synthesis_chars), 0) AS synthesis_chars
      FROM incoming i LEFT JOIN voice_call_usage u ON u.workspace_id = i.workspace_id AND u.day = i.day
    )
  INSERT INTO voice_call_usage (workspace_id, day, call_id, transcription_ms, synthesis_chars)
  SELECT i.workspace_id, i.day, i.call_id, i.transcription_ms, i.synthesis_chars
  FROM incoming i CROSS JOIN totals t LEFT JOIN voice_usage_limits l ON l.workspace_id = i.workspace_id
  WHERE (i.transcription_ms = 0 OR l.transcription_seconds IS NULL OR
         t.transcription_ms + i.transcription_ms <= l.transcription_seconds * 1000)
    AND (i.synthesis_chars = 0 OR l.synthesis_characters IS NULL OR
         t.synthesis_chars + i.synthesis_chars <= l.synthesis_characters)
  ON CONFLICT(workspace_id, day, call_id) DO UPDATE SET
    transcription_ms = voice_call_usage.transcription_ms + excluded.transcription_ms,
    synthesis_chars = voice_call_usage.synthesis_chars + excluded.synthesis_chars
  RETURNING call_id
`;

function validLimit(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0 && value <= maxDailyLimit);
}

function totalsFrom(row) {
  return { transcriptionSeconds: row.transcriptionMs / 1000, synthesisCharacters: row.synthesisCharacters };
}

export function createVoiceUsage(db, now = () => new Date()) {
  const dayKey = () => now().toISOString().slice(0, 10);
  return {
    async reserve(workspaceId, callId, { transcriptionMilliseconds = 0, synthesisCharacters = 0 }) {
      if (![transcriptionMilliseconds, synthesisCharacters].every(value => Number.isSafeInteger(value) && value >= 0) ||
          !(transcriptionMilliseconds || synthesisCharacters)) throw new TypeError('Voice usage must be positive.');
      const result = await db.execute(statement(reserveUsage,
        workspaceId, dayKey(), callId, transcriptionMilliseconds, synthesisCharacters));
      if (!result.rows.length) {
        const message = transcriptionMilliseconds
          ? 'The workspace reached its daily voice transcription budget. You can continue by text.'
          : 'The workspace reached its daily voice playback budget. The reply is available in the transcript.';
        throw usageError(429, 'voice-budget-exhausted', message);
      }
    },
    async summary(workspaceId, callId) {
      const day = dayKey();
      const queries = [
        statement(readLimits, workspaceId),
        statement(totalUsage + ' WHERE workspace_id = ? AND day = ?', workspaceId, day),
      ];
      if (callId) queries.push(statement(totalUsage + ' WHERE workspace_id = ? AND call_id = ?', workspaceId, callId));
      const [limits, today, call] = await db.batch(queries, 'read');
      const { transcriptionSeconds = null, synthesisCharacters = null } = limits.rows[0] ?? {};
      return { day, limits: { transcriptionSeconds, synthesisCharacters }, today: totalsFrom(today.rows[0]), call: call ? totalsFrom(call.rows[0]) : null };
    },
    async setLimits(workspaceId, input) {
      const { transcriptionSeconds, synthesisCharacters } = input ?? {};
      if (!validLimit(transcriptionSeconds) || !validLimit(synthesisCharacters)) {
        throw usageError(400, 'voice-budget-invalid', 'Enter whole daily limits between 0 and 1,000,000,000, or leave them blank.');
      }
      await db.execute(statement(`INSERT INTO voice_usage_limits (workspace_id, transcription_seconds, synthesis_characters)
        VALUES (?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET
          transcription_seconds = excluded.transcription_seconds, synthesis_characters = excluded.synthesis_characters`,
      workspaceId, transcriptionSeconds, synthesisCharacters));
    },
  };
}
