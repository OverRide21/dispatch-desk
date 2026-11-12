import { dispatchHandlers } from '../../../../src/http.mjs';

export const runtime = 'nodejs';
export const GET = dispatchHandlers.voiceUsage;
export const PATCH = dispatchHandlers.saveVoiceUsage;
