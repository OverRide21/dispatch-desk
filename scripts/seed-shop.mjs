const starterProducts = [
  { sku: 'KM-RICE', name: 'Basmati Rice (1 kg)', nameHi: 'बासमती चावल', nameMr: 'बासमती तांदूळ', unit: 'bags', category: 'Staples', pricePaise: 14900, stock: 28 },
  { sku: 'KM-ATTA', name: 'Whole Wheat Atta (1 kg)', nameHi: 'गेहूँ का आटा', nameMr: 'गव्हाचे पीठ', unit: 'bags', category: 'Staples', pricePaise: 6800, stock: 35 },
  { sku: 'KM-DAL', name: 'Toor Dal (500 g)', nameHi: 'अरहर दाल', nameMr: 'तूर डाळ', unit: 'packets', category: 'Staples', pricePaise: 8900, stock: 22 },
  { sku: 'KM-SUGAR', name: 'Sugar (1 kg)', nameHi: 'चीनी', nameMr: 'साखर', unit: 'bags', category: 'Staples', pricePaise: 5200, stock: 24 },
  { sku: 'KM-OIL', name: 'Sunflower Oil (1 L)', nameHi: 'सूरजमुखी का तेल', nameMr: 'सूर्यफूल तेल', unit: 'bottles', category: 'Cooking', pricePaise: 15900, stock: 16 },
  { sku: 'KM-CHAI', name: 'Masala Chai (250 g)', nameHi: 'मसाला चाय', nameMr: 'मसाला चहा', unit: 'packets', category: 'Drinks', pricePaise: 13500, stock: 18 },
  { sku: 'KM-CHIPS', name: 'Masala Banana Chips (100 g)', nameHi: 'केले के चिप्स', nameMr: 'केळीचे वेफर्स', unit: 'packets', category: 'Snacks', pricePaise: 4900, stock: 30 },
  { sku: 'KM-SOAP', name: 'Sandalwood Bar Soap (100 g)', nameHi: 'चंदन साबुन', nameMr: 'चंदन साबण', unit: 'pieces', category: 'Household', pricePaise: 6500, stock: 12 },
];

const port = process.argv[2] ?? '3000';
if (!/^\d{1,5}$/u.test(port) || Number(port) < 1 || Number(port) > 65535) {
  throw new Error('Specify a valid local port.');
}
const origin = `http://127.0.0.1:${port}`;

async function catalogRequest(method, payload) {
  const response = await fetch(`${origin}/api/catalog`, {
    method,
    headers: { origin, 'content-type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? result.message ?? `Catalog returned ${response.status}.`);
  return result;
}

const { products } = await catalogRequest('GET');
const existing = new Map(products.map(product => [product.sku, product]));
for (const { stock, ...product } of starterProducts) {
  const current = existing.get(product.sku);
  if (!current) await catalogRequest('PUT', product);
  if (!current || (current.name === product.name && current.unit === product.unit && current.stock === 0)) {
    await catalogRequest('PATCH', { sku: product.sku, quantity: stock, requestId: `kirana-starter-v1-${product.sku}` });
  }
}
console.log(`Starter catalog ready at ${origin}/shop.`);
