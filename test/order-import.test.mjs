import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { inspectOrderImport, maxOrderImportBytes, orderTemplate, parseOrderImport } from '../src/order-import.mjs';

const csv = text => ({ filename: 'orders.CSV', bytes: Buffer.from(text) });
const json = data => ({ filename: 'orders.json', bytes: Buffer.from(JSON.stringify(data)) });
const csvHeader = 'Order ID,Customer,Line ID,Item name,SKU,Quantity,Unit,Fulfillment status,Aliases,Item name (Hindi),Item name (Marathi)';

test('UTF-8 CSV preserves quoted commas, multiline values, and textual identifiers', async () => {
  const source = csv('\uFEFF' + csvHeader +
    '\r\n00012,"Nashik,\r\nCentral",004,"Cotton, long",SKU-C,१२,rolls,Pending,cotton|कापूस,कपास,कापूस\r\n' +
    '00012,"Nashik,\r\nCentral",005,Steel,SKU-S,2,boxes,Dispatched,,स्टील,स्टील\r\n');
  const info = await inspectOrderImport(source);
  assert.equal(info.sheet, null);
  assert.equal(info.mapping.nameMr, 'Item name (Marathi)');
  assert.deepEqual(await parseOrderImport(source), { errors: [], orders: [{
    id: '00012', customer: 'Nashik,\nCentral', items: [
      { id: '004', name: 'Cotton, long', sku: 'SKU-C', quantity: 12, unit: 'rolls', status: 'pending',
        aliases: ['cotton', 'कापूस'], nameHi: 'कपास', nameMr: 'कापूस' },
      { id: '005', name: 'Steel', sku: 'SKU-S', quantity: 2, unit: 'boxes', status: 'shipped',
        aliases: [], nameHi: 'स्टील', nameMr: 'स्टील' },
    ],
  }] });
});

test('CSV column mapping supports SKU-only naming and rejects missing or repeated mappings', async () => {
  const source = csv('Ref,Shop,Position,Code,How many,Measure,Dispatch\nPO-27,Ashoka,01,C-1,20,boxes,open\n');
  const mapping = { orderId: 'Ref', customer: 'Shop', lineId: 'Position', sku: 'Code',
    quantity: 'How many', unit: 'Measure', status: 'Dispatch' };
  assert.equal((await parseOrderImport(source)).orders.length, 0);
  const valid = await parseOrderImport({ ...source, mapping });
  assert.deepEqual(valid.errors, []);
  assert.equal(valid.orders[0].items[0].name, 'C-1');
  const result = await parseOrderImport({ ...source, mapping: { ...mapping, customer: 'Ref' } });
  assert.equal(result.orders.length, 0);
  assert.ok(result.errors.some(({ row, field, message }) => row === 1 && field === 'customer' && /already mapped/u.test(message)));
});

test('invalid rows and conflicting duplicate IDs cannot produce a partial import', async () => {
  const source = csv(csvHeader + '\nA,One,L1,Wool,,1,rolls,pending,,,\n' +
    'A,Two,L1,Oil,,1,boxes,pending,,,\nB,Other,L2,Rice,,3.5,kg,unknown,,,\n' +
    'C,Other,L3,Milk,,1,cases,pending,bad\u0000alias,,');
  const result = await parseOrderImport(source);
  assert.deepEqual(result.orders, []);
  assert.deepEqual(result.errors.map(({ row, field }) => [row, field]),
    [[3, 'customer'], [3, 'lineId'], [4, 'quantity'], [4, 'status'], [5, 'file']]);
});

test('JSON v1 and flat rows normalize to the same order schema', async () => {
  const nested = json({ version: 1, orders: [{ id: 'A', customer: 'Market', items: [
    { id: '001', name: 'Rice', sku: 'R-1', quantity: 12, unit: 'bags', status: 'pending', aliases: ['तांदूळ'] },
  ] }] });
  const flat = json([{ 'Order ID': 'A', Customer: 'Market', 'Line ID': '001', 'Item Name': 'Rice',
    SKU: 'R-1', Quantity: 12, Unit: 'bags', 'Fulfillment Status': 'pending', Aliases: 'तांदूळ' }]);
  assert.deepEqual(await inspectOrderImport(nested), { sheets: [], sheet: null, columns: [], mapping: {} });
  const result = await parseOrderImport(nested);
  assert.deepEqual(result.errors, []);
  assert.equal(result.orders[0].items[0].id, '001');
  assert.deepEqual(result, await parseOrderImport(flat));
  await assert.rejects(parseOrderImport(json({ version: 2, orders: [] })), { status: 422 });
  const repeated = JSON.parse(nested.bytes);
  repeated.orders.push({ ...repeated.orders[0], items: [{ ...repeated.orders[0].items[0], id: 'other' }] });
  assert.match((await parseOrderImport(json(repeated))).errors[0].message, /order ID.*more than once/u);
});

async function xlsx(create) {
  const book = new ExcelJS.Workbook();
  create(book);
  return { filename: 'orders.xlsx', bytes: Buffer.from(await book.xlsx.writeBuffer()) };
}

test('Excel lets an operator select a visible worksheet and preserves text identifiers', async () => {
  const file = await xlsx(book => {
    const blank = book.addWorksheet('Notes');
    blank.addRow(['Read this first']);
    const orders = book.addWorksheet('Orders');
    orders.addRow(csvHeader.split(','));
    orders.addRow(['00012', 'नाशिक', 42, 'Cotton', '0031', 12, 'rolls', 'pending']);
    const hidden = book.addWorksheet('Hidden');
    hidden.state = 'hidden';
  });
  assert.deepEqual((await inspectOrderImport(file)).sheets, ['Notes', 'Orders']);
  const info = await inspectOrderImport({ ...file, sheet: 'Orders' });
  assert.equal(info.mapping.orderId, 'Order ID');
  const result = await parseOrderImport({ ...file, sheet: 'Orders', mapping: info.mapping });
  assert.deepEqual(result, { errors: [], orders: [{
    id: '00012', customer: 'नाशिक', items: [
      { id: '42', name: 'Cotton', sku: '0031', quantity: 12, unit: 'rolls', status: 'pending', aliases: [] },
    ],
  }] });
  await assert.rejects(inspectOrderImport({ ...file, sheet: 'Hidden' }), { status: 422 });
});

test('Excel rejects formulas, external links, and rows beyond the configured bound', async () => {
  const formula = await xlsx(book => {
    const sheet = book.addWorksheet('Orders');
    sheet.addRow(csvHeader.split(','));
    sheet.addRow(['PO-1', 'Shop', 'L1', 'Rice', '', { formula: '1+1', result: 2 }, 'bags', 'pending']);
  });
  await assert.rejects(inspectOrderImport(formula), /formulas are not supported/u);
  const link = await xlsx(book => {
    const sheet = book.addWorksheet('Orders');
    sheet.addRow(csvHeader.split(','));
    sheet.addRow(['PO-1', { text: 'Shop', hyperlink: 'https://example.invalid' }, 'L1', 'Rice', '', 2, 'bags', 'pending']);
  });
  await assert.rejects(inspectOrderImport(link), /external links/u);
  const distant = await xlsx(book => {
    const sheet = book.addWorksheet('Orders');
    sheet.addRow(csvHeader.split(','));
    sheet.getCell('A5002').value = 'PO-1';
  });
  await assert.rejects(inspectOrderImport(distant), { status: 413 });
});

test('malformed and oversized uploads fail with safe, actionable errors', async () => {
  await assert.rejects(parseOrderImport(csv('Header\n"unclosed')), /could not be read/u);
  await assert.rejects(inspectOrderImport({ filename: 'orders.csv', bytes: Buffer.from([0xff]) }), /UTF-8/u);
  await assert.rejects(inspectOrderImport({ filename: 'orders.xlsx', bytes: Buffer.from('not a ZIP file') }), { status: 422 });
  await assert.rejects(inspectOrderImport({ filename: 'orders.xlsm', bytes: Buffer.from('x') }), { status: 415 });
  await assert.rejects(inspectOrderImport({ filename: 'orders.csv', bytes: Buffer.alloc(maxOrderImportBytes + 1) }), { status: 413 });
  await assert.rejects(inspectOrderImport(csv('Header\n' + 'x\n'.repeat(5_001))), { status: 413 });
  await assert.rejects(inspectOrderImport(csv('Header' + ','.repeat(40))), { status: 413 });
});

test('templates download as real CSV, Excel and versioned JSON', async () => {
  for (const format of ['csv', 'xlsx', 'json']) {
    const template = await orderTemplate(format);
    assert.equal(template.filename, 'dispatch-orders-template.' + format);
    assert.ok(template.contentType);
    const info = await inspectOrderImport(template);
    if (format === 'json') {
      assert.deepEqual(JSON.parse(template.bytes), { version: 1, orders: [] });
    } else {
      assert.equal(info.mapping.quantity, 'Quantity');
      assert.equal(info.mapping.nameMr, 'Item name (Marathi)');
      assert.equal(info.mapping.availableQuantity, 'Available quantity');
      assert.equal(info.mapping.editCutoffAt, 'Edit cutoff at');
    }
  }
});

test('stock and fulfillment metadata normalize in CSV, JSON and Excel', async () => {
  const columns = [
    'Order ID', 'Customer', 'Line ID', 'SKU', 'Unit', 'Quantity', 'Fulfillment status',
    'Available quantity', 'Backorder allowed', 'Substitute SKU', 'Backorder quantity',
    'Fulfillment stage', 'Picked at', 'Packed at', 'Delivery ETA', 'Edit cutoff at',
  ];
  const cells = [
    'O-1', 'Warehouse', 'L-1', '0001', 'boxes', 9, 'pending', 7, 'yes', '0002', 2,
    'packed', '2026-11-10T10:00:00+05:30', '2026-11-10T11:00:00+05:30', '2026-11-11', '2026-11-10T09:00:00+05:30',
  ];
  const csv = { filename: 'orders.csv', bytes: Buffer.from(columns.join(',') + '\n' + cells.join(',')) };
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Orders');
  sheet.addRow(columns);
  const excelCells = cells.map((value, index) => index >= 12 ? new Date(value) : value);
  sheet.addRow(excelCells);
  const excel = { filename: 'orders.xlsx', bytes: Buffer.from(await workbook.xlsx.writeBuffer()) };
  const json = {
    filename: 'orders.json',
    bytes: Buffer.from(JSON.stringify({ version: 1, orders: [{ id: 'O-1', customer: 'Warehouse', items: [{
      id: 'L-1', sku: '0001', unit: 'boxes', quantity: 9, status: 'pending', availableQuantity: 7,
      backorderAllowed: true, substituteSku: '0002', backorderQuantity: 2, fulfillmentStage: 'packed',
      pickedAt: cells[12], packedAt: cells[13], deliveryEta: cells[14], editCutoffAt: cells[15],
    }] }] })),
  };
  for (const source of [csv, json, excel]) {
    const parsed = await parseOrderImport(source);
    assert.deepEqual(parsed.errors, [], source.filename);
    assert.deepEqual(parsed.orders[0].items[0], {
      id: 'L-1', sku: '0001', name: '0001', unit: 'boxes', quantity: 9, status: 'pending', aliases: [],
      availableQuantity: 7, backorderAllowed: true, substituteSku: '0002', backorderQuantity: 2, fulfillmentStage: 'packed',
      pickedAt: '2026-11-10T04:30:00.000Z', packedAt: '2026-11-10T05:30:00.000Z',
      deliveryEta: '2026-11-11T00:00:00.000Z', editCutoffAt: '2026-11-10T03:30:00.000Z',
    });
  }

  const invalid = cells.slice();
  invalid[10] = 10;
  invalid[13] = '2026-11-10T08:00:00Z';
  invalid[12] = '2026-11-10T09:00:00Z';
  invalid[15] = '2026-11-10T09:00:00';
  const rejected = await parseOrderImport({ ...csv, bytes: Buffer.from(columns.join(',') + '\n' + invalid.join(',')) });
  assert.deepEqual(rejected.orders, []);
  assert.deepEqual(new Set(rejected.errors.map(error => error.field)), new Set(['backorderQuantity', 'packedAt', 'editCutoffAt']));
});
