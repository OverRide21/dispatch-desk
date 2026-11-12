export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.NEXT_PHASE === 'phase-production-build' || process.env.VERCEL ||
      process.env.DISPATCH_STOREFRONT_ENABLED !== '1') return;
  const { startShippingWorker } = await import('./src/shipping-worker.mjs');
  startShippingWorker();
}
