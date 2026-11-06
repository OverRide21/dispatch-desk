import { dispatchHandlers } from '../../../src/http.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = dispatchHandlers.auth;
export const POST = dispatchHandlers.signIn;
export const DELETE = dispatchHandlers.signOut;
