import { dispatchHandlers } from '../../../src/http.mjs';

export const runtime = 'nodejs';
export const GET = dispatchHandlers.catalog;
export const PUT = dispatchHandlers.saveProduct;
export const PATCH = dispatchHandlers.addStock;
