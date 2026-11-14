import { dispatchHandlers } from '../../../src/http.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = dispatchHandlers.session;
export const POST = dispatchHandlers.guestSession;
