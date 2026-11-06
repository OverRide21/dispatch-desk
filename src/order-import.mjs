import { extname } from 'node:path';
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import yauzl from 'yauzl';

export const maxOrderImportBytes = 5 * 1024 * 1024;
const maxRecords = 5_000;
const maxColumns = 40;
const maxCellLength = 1_024;
const maxSheets = 25;
const maxArchiveEntries = 750;
const maxEntryBytes = 12 * 1024 * 1024;
const maxArchiveBytes = 32 * 1024 * 1024;
const maxQuantity = 1_000_000;

const fields = {
  orderId: { title: 'Order ID', headers: ['orderId', 'orderNumber', 'orderReference', 'orderNo'] },
  customer: { title: 'Customer', headers: ['customer', 'customerName', 'customerReference', 'customerId'] },
  lineId: { title: 'Line ID', headers: ['lineId', 'orderLineId', 'itemId', 'lineNumber'] },
  name: { title: 'Item name', headers: ['name', 'itemName', 'item', 'productName', 'product', 'description'] },
  sku: { title: 'SKU', headers: ['sku', 'itemSku', 'productCode', 'itemCode'] },
  quantity: { title: 'Quantity', headers: ['quantity', 'qty', 'orderedQuantity'] },
  unit: { title: 'Unit', headers: ['unit', 'uom', 'unitOfMeasure'] },
  status: { title: 'Fulfillment status', headers: ['status', 'fulfillmentStatus', 'fulfilmentStatus', 'shippingStatus', 'dispatchStatus'] },
  aliases: { title: 'Aliases', headers: ['aliases', 'itemAliases', 'productAliases'] },
  nameHi: { title: 'Item name (Hindi)', headers: ['nameHi', 'itemNameHindi', 'hindiName', 'nameHindi'] },
  nameMr: { title: 'Item name (Marathi)', headers: ['nameMr', 'itemNameMarathi', 'marathiName', 'nameMarathi'] },
};
const required = ['orderId', 'customer', 'lineId', 'quantity', 'unit', 'status'];
const statuses = new Map([
  ['pending', 'pending'], ['open', 'pending'], ['editable', 'pending'], ['unshipped', 'pending'],
  ['notshipped', 'pending'], ['awaitingdispatch', 'pending'],
  ['shipped', 'shipped'], ['dispatched', 'shipped'], ['delivered', 'shipped'], ['fulfilled', 'shipped'],
  ['intransit', 'shipped'],
]);

class ImportError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.status = status;
  }
}

const isObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const isBlank = value => value == null || (typeof value === 'string' && !value.trim());
const normalizeKey = value => value.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, '');

function utf8(bytes, message = 'Save the file as UTF-8 and try again.') {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ImportError(message);
  }
}

function input({ filename, bytes } = {}) {
  const format = typeof filename === 'string' ? extname(filename).slice(1).toLowerCase() : '';
  if (!['csv', 'xlsx', 'json'].includes(format)) {
    throw new ImportError('Choose a CSV, Excel (.xlsx), or JSON file.', 415);
  }
  if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) {
    throw new ImportError('Choose a file to import.', 400);
  }
  const buffer = Buffer.from(bytes);
  if (buffer.length > maxOrderImportBytes) throw new ImportError('The file is larger than 5 MiB.', 413);
  if (!buffer.length) throw new ImportError('The file is empty.');
  return { format, buffer };
}

function checkCsvWidth(text) {
  let quoted = false;
  let columns = 1;
  for (let index = 0; index < text.length; index++) {
    const ch = text[index];
    if (ch === '"') {
      if (quoted && text[index + 1] === '"') index++;
      else quoted = !quoted;
    } else if (!quoted && ch === ',') {
      if (++columns > maxColumns) throw new ImportError('The file has more than 40 columns.', 413);
    } else if (!quoted && (ch === '\r' || ch === '\n')) {
      columns = 1;
    }
  }
}

function readCsv(buffer) {
  const text = utf8(buffer);
  checkCsvWidth(text);
  let rows = 0;
  let records;
  try {
    records = parse(text, {
      info: true, skip_empty_lines: true, relax_column_count: true, max_record_size: 65_536,
      on_record(record) {
        if (++rows > maxRecords + 1) throw new ImportError('A file can contain at most 5,000 order lines.', 413);
        return record;
      },
    });
  } catch (error) {
    if (error instanceof ImportError) throw error;
    const row = Number.isSafeInteger(error.lines) ? ' near line ' + error.lines : '';
    throw new ImportError('The CSV could not be read' + row + '. Check its commas and quotation marks.');
  }
  return records.map(({ record, info }) => ({ row: info.lines, values: record }));
}

function zipFromBuffer(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => {
      if (error) reject(error);
      else resolve(zip);
    });
  });
}

function nextZipEntry(zip) {
  return new Promise((resolve, reject) => {
    const onEntry = entry => { cleanup(); resolve(entry); };
    const onEnd = () => { cleanup(); resolve(null); };
    const onError = error => { cleanup(); reject(error); };
    function cleanup() {
      zip.off('entry', onEntry);
      zip.off('end', onEnd);
      zip.off('error', onError);
    }
    zip.once('entry', onEntry);
    zip.once('end', onEnd);
    zip.once('error', onError);
    try {
      zip.readEntry();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function openZipEntry(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) reject(error);
      else resolve(stream);
    });
  });
}

function checkWorksheet(xml) {
  if (/<(?:[\w.-]+:)?f(?=[\s/>])/iu.test(xml)) {
    throw new ImportError('Excel formulas are not supported. Paste their values into a new workbook before importing.');
  }
  if (/<(?:[\w.-]+:)?mergeCell(?=[\s/>])/iu.test(xml)) {
    throw new ImportError('The workbook contains merged cells. Unmerge them before importing.');
  }
  let rows = 0;
  let cells = 0;
  for (const tag of xml.matchAll(/<(?:[\w.-]+:)?(row|c|col)(?=[\s/>])[^>]*>/gu)) {
    const [, kind] = tag;
    const ref = tag[0].match(/\sr\s*=\s*["']([^"']+)["']/u)?.[1];
    if (kind === 'row' && (++rows > maxRecords + 1 || (ref && !/^\d{1,4}$/u.test(ref)) || Number(ref) > maxRecords + 1)) {
      throw new ImportError('A worksheet can contain at most 5,000 order lines below its header.', 413);
    }
    if (kind === 'c' && ++cells > (maxRecords + 1) * maxColumns) {
      throw new ImportError('The worksheet contains too many cells.', 413);
    }
    if (kind === 'c' && ref) {
      const address = /^([A-Z]+)(\d+)$/u.exec(ref);
      const column = address?.[1].split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
      if (!address || column > maxColumns || Number(address[2]) > maxRecords + 1) {
        throw new ImportError('A worksheet can contain at most 40 columns and 5,000 order lines.', 413);
      }
    }
    if (kind === 'col') {
      const column = tag[0].match(/\smax\s*=\s*["'](\d+)["']/u)?.[1];
      if (Number(column) > maxColumns) throw new ImportError('A worksheet can contain at most 40 columns.', 413);
    }
  }
}

async function preflightXlsx(buffer) {
  let zip;
  const names = new Set();
  let total = 0;
  let sheets = 0;
  let zipError;
  try {
    zip = await zipFromBuffer(buffer);
    // Keep asynchronous archive errors handled even while an entry stream is being inspected.
    zip.on('error', error => { zipError = error; });
    if (zip.entryCount > maxArchiveEntries) throw new ImportError('The workbook contains too many files.', 413);
    for (let entry; (entry = await nextZipEntry(zip));) {
      if (zipError) throw zipError;
      const name = entry.fileName.toLowerCase();
      if (names.has(name) || name.split('/').some(segment => ['..', '.', '__proto__', 'constructor', 'prototype'].includes(segment))) {
        throw new ImportError('The workbook contains invalid archive paths.');
      }
      names.add(name);
      if (/(?:vbaproject|macro[s-]?sheet|activex|externallink|embeddings|\.bin$)/iu.test(name)) {
        throw new ImportError('Workbooks with macros, embedded objects, or external links cannot be imported.');
      }
      if (entry.uncompressedSize > maxEntryBytes || total + entry.uncompressedSize > maxArchiveBytes) {
        throw new ImportError('The expanded workbook exceeds the import size limit.', 413);
      }
      if (name.endsWith('/')) continue;
      const stream = await openZipEntry(zip, entry);
      const xmlEntry = /\.(?:xml|rels)$/u.test(name);
      const chunks = [];
      for await (const chunk of stream) {
        total += chunk.length;
        if (total > maxArchiveBytes) throw new ImportError('The expanded workbook exceeds the import size limit.', 413);
        if (xmlEntry) chunks.push(chunk);
      }
      if (!xmlEntry) continue;
      const xml = utf8(Buffer.concat(chunks), 'The workbook contains an unreadable XML file.');
      if (/<!DOCTYPE|<!ENTITY|\u0000/iu.test(xml)) throw new ImportError('The workbook contains unsupported XML.');
      if (/targetmode\s*=\s*["']external["']|macroenabled|vbaproject/iu.test(xml) &&
          (name.endsWith('.rels') || name === '[content_types].xml')) {
        throw new ImportError('Workbooks with macros or external links cannot be imported.');
      }
      if (/^xl\/worksheets\/[^/]+\.xml$/u.test(name)) {
        if (++sheets > maxSheets) throw new ImportError('The workbook contains more than 25 worksheets.', 413);
        checkWorksheet(xml);
      }
    }
    if (zipError) throw zipError;
    if (!names.has('[content_types].xml') || !names.has('xl/workbook.xml')) throw new ImportError('This file is not an Excel workbook.');
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError('The Excel archive could not be read. Open the file in Excel and save it as .xlsx.');
  } finally {
    zip?.close();
  }
}

function excelValue(cell) {
  const value = cell.value;
  return isObject(value) && Array.isArray(value.richText) ? cell.text : value;
}

async function readXlsx(buffer, requestedSheet) {
  await preflightXlsx(buffer);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw new ImportError('The Excel workbook could not be read. Open it in Excel and save it as .xlsx.');
  }
  const visible = workbook.worksheets.filter(sheet => sheet.state === 'visible');
  if (!visible.length) throw new ImportError('The workbook has no visible worksheets.');
  const sheet = requestedSheet == null
    ? (visible.find(candidate => candidate.actualRowCount) ?? visible[0])
    : visible.find(candidate => candidate.name === requestedSheet);
  if (!sheet) throw new ImportError('Choose a worksheet from this workbook.');
  if (sheet.rowCount > maxRecords + 1 || sheet.columnCount > maxColumns) {
    throw new ImportError('A worksheet can contain at most 40 columns and 5,000 order lines.', 413);
  }
  const records = [];
  sheet.eachRow((row, index) => {
    const values = Array.from({ length: row.cellCount }, (_, column) => excelValue(row.getCell(column + 1)));
    records.push({ row: index, values });
  });
  return { records, sheets: visible.map(candidate => candidate.name), sheet: sheet.name };
}

function readJson(buffer) {
  let data;
  try {
    data = JSON.parse(utf8(buffer));
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError('The file contains invalid JSON.');
  }
  if (Array.isArray(data)) {
    if (data.length > maxRecords) throw new ImportError('A file can contain at most 5,000 order lines.', 413);
    return { kind: 'flat', data };
  }
  if (!isObject(data) || data.version !== 1 || !Array.isArray(data.orders)) {
    throw new ImportError('JSON must use version 1 with an orders array, or a flat array of order lines.');
  }
  if (data.orders.length > maxRecords || data.orders.reduce((count, order) => count + (Array.isArray(order?.items) ? order.items.length : 1), 0) > maxRecords) {
    throw new ImportError('A file can contain at most 5,000 order lines.', 413);
  }
  return { kind: 'nested', data: data.orders };
}

function requireTabularHeader(records) {
  const nonempty = records.filter(({ values }) => values.some(value => !isBlank(value)));
  if (!nonempty.length) throw new ImportError('The file has no header row.');
  const [header, ...rows] = nonempty;
  if (header.values.length > maxColumns) throw new ImportError('The file has more than 40 columns.', 413);
  const columns = header.values.map(value => {
    if (isBlank(value)) return '';
    if (typeof value !== 'string' || /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(value) || value.length > 128) {
      throw new ImportError('Column headers must be short text labels.');
    }
    return value.trim();
  });
  const names = columns.filter(Boolean);
  if (new Set(names).size !== names.length) throw new ImportError('Column headers must be unique.');
  return { columns, names, rows, headerRow: header.row };
}

function guessMapping(columns) {
  const mapping = {};
  for (const [field, { headers }] of Object.entries(fields)) {
    const matches = columns.filter(column => headers.map(normalizeKey).includes(normalizeKey(column)));
    if (matches.length === 1) mapping[field] = matches[0];
  }
  return mapping;
}

async function readTabular(format, buffer, sheet) {
  const parsed = format === 'csv' ? { records: readCsv(buffer), sheets: [], sheet: null } : await readXlsx(buffer, sheet);
  return { ...requireTabularHeader(parsed.records), sheets: parsed.sheets, sheet: parsed.sheet };
}

export async function inspectOrderImport(options) {
  const { format, buffer } = input(options);
  if (format === 'json') {
    readJson(buffer);
    return { sheets: [], sheet: null, columns: [], mapping: {} };
  }
  const { names, sheets, sheet } = await readTabular(format, buffer, options.sheet);
  return { sheets, sheet, columns: names, mapping: guessMapping(names) };
}

function mappingFor(source, supplied) {
  if (supplied != null && !isObject(supplied)) throw new ImportError('Column mapping must be an object.', 400);
  const { names, headerRow } = source;
  const mapping = supplied ?? guessMapping(names);
  const errors = [];
  const assigned = new Set();
  const usable = new Set();
  for (const [key, column] of Object.entries(mapping)) {
    if (!Object.hasOwn(fields, key)) throw new ImportError('Column mapping contains an unknown field.', 400);
    if (column == null || column === '') continue;
    if (typeof column !== 'string' || !names.includes(column)) {
      errors.push({ row: headerRow, field: key, message: 'Select a column that exists in the file.' });
    } else if (assigned.has(column)) {
      errors.push({ row: headerRow, field: key, message: 'This column is already mapped to another field.' });
    } else {
      assigned.add(column);
      usable.add(key);
    }
  }
  for (const field of required) {
    if (!usable.has(field) && !errors.some(error => error.field === field)) {
      errors.push({ row: headerRow, field, message: 'Map a column for ' + fields[field].title + '.' });
    }
  }
  if (!usable.has('name') && !usable.has('sku') && !errors.some(error => ['name', 'sku'].includes(error.field))) {
    errors.push({ row: headerRow, field: 'name', message: 'Map an item name or SKU column.' });
  }
  return { mapping: Object.fromEntries([...usable].map(key => [key, source.columns.indexOf(mapping[key])])), errors };
}

function readText(value, max, { number = false, multiline = false } = {}) {
  if (number && Number.isSafeInteger(value) && value >= 0) value = String(value);
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFC').replace(/\r\n?/gu, '\n');
  const checked = multiline ? normalized.replace(/[\t\n]/gu, '') : normalized;
  if (/[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(checked)) return null;
  const trimmed = normalized.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

function readQuantity(value) {
  if (typeof value === 'string') {
    const digits = value.trim().replace(/[०-९]/gu, digit => String(digit.charCodeAt(0) - 0x0966));
    if (/^\d+$/u.test(digits)) value = Number(digits);
    else if (/^\d{1,3}(?:,\d{3})+$/u.test(digits) || /^\d{1,3}(?:,\d{2})*,\d{3}$/u.test(digits)) {
      value = Number(digits.replaceAll(',', ''));
    } else return null;
  }
  return Number.isSafeInteger(value) && value >= 0 && value <= maxQuantity ? value : null;
}

function normalizeRow(values, row, errors) {
  const previous = errors.length;
  const addError = (field, message) => errors.push({ row, field, message });
  const orderId = readText(values.orderId, 80, { number: true });
  const customer = readText(values.customer, 160, { number: true, multiline: true });
  const id = readText(values.lineId, 80, { number: true });
  const sku = isBlank(values.sku) ? '' : readText(values.sku, 100, { number: true });
  const name = isBlank(values.name) ? sku : readText(values.name, 180, { multiline: true });
  const unit = readText(values.unit, 48);
  const quantity = readQuantity(values.quantity);
  const status = typeof values.status === 'string' ? statuses.get(normalizeKey(values.status)) : undefined;
  if (!orderId) addError('orderId', 'Enter a valid order ID (up to 80 characters).');
  if (!customer) addError('customer', 'Enter a valid customer name or reference (up to 160 characters).');
  if (!id) addError('lineId', 'Enter a valid line ID (up to 80 characters).');
  if (sku === null) addError('sku', 'Enter a valid SKU (up to 100 characters).');
  if (!name) addError('name', 'Enter an item name or SKU (up to 180 characters).');
  if (!unit) addError('unit', 'Enter a unit (up to 48 characters).');
  if (quantity === null) addError('quantity', 'Enter a whole number from 0 to 1,000,000.');
  if (!status || (typeof values.status === 'string' && /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(values.status))) {
    addError('status', 'Use pending or shipped as the fulfillment status.');
  }

  let aliases = [];
  if (!isBlank(values.aliases)) {
    const entries = typeof values.aliases === 'string' ? values.aliases.split('|').filter(value => value.trim()) : values.aliases;
    if (!Array.isArray(entries) || entries.length > 15) {
      addError('aliases', 'Use up to 15 aliases, separated by | or provided as a JSON array.');
    } else {
      aliases = [...new Set(entries.map(value => readText(value, 100)))];
      if (aliases.includes(null)) addError('aliases', 'Each alias must be text of at most 100 characters.');
    }
  }
  const localized = {};
  for (const field of ['nameHi', 'nameMr']) {
    if (isBlank(values[field])) continue;
    const name = readText(values[field], 180, { multiline: true });
    if (name === null) addError(field, 'Enter a name of at most 180 characters.');
    else localized[field] = name;
  }
  return errors.length === previous ? { orderId, customer, item: { id, name, sku, unit, quantity, status, aliases, ...localized } } : null;
}

function collect(records, errors) {
  const orders = new Map();
  for (const { row, values } of records) {
    const normalized = normalizeRow(values, row, errors);
    if (!normalized) continue;
    const { orderId, customer, item } = normalized;
    if (!orders.has(orderId)) orders.set(orderId, { id: orderId, customer, items: new Map() });
    const order = orders.get(orderId);
    if (order.customer !== customer) {
      errors.push({ row, field: 'customer', message: 'All lines of an order must use the same customer.' });
    }
    if (order.items.has(item.id)) {
      errors.push({ row, field: 'lineId', message: 'This line ID appears more than once in the same order.' });
    }
    order.items.set(item.id, item);
  }
  if (!orders.size && !errors.length) errors.push({ row: 1, field: 'file', message: 'The file contains no order lines.' });
  errors.sort((a, b) => a.row - b.row);
  return {
    orders: errors.length ? [] : [...orders.values()].map(order => ({ ...order, items: [...order.items.values()] })),
    errors,
  };
}

function jsonRecords(json, errors) {
  const records = [];
  let row = 0;
  if (json.kind === 'flat') {
    for (const value of json.data) {
      row++;
      if (!isObject(value)) {
        errors.push({ row, field: 'file', message: 'Each record must be an object.' });
        continue;
      }
      const byHeader = new Map(Object.entries(value).map(([key, value]) => [normalizeKey(key), value]));
      const values = Object.fromEntries(Object.entries(fields).map(([key, { headers }]) => [
        key, headers.map(normalizeKey).find(header => byHeader.has(header)),
      ]).map(([key, header]) => [key, byHeader.get(header)]));
      records.push({ row, values });
    }
    return records;
  }

  const orderIds = new Set();
  for (const order of json.data) {
    if (!isObject(order) || !Array.isArray(order.items) || !order.items.length) {
      errors.push({ row: ++row, field: 'items', message: 'Each order must include at least one line item.' });
      continue;
    }
    const orderId = order.id ?? order.orderId;
    const id = readText(orderId, 80, { number: true });
    if (id && orderIds.has(id)) {
      errors.push({ row: row + 1, field: 'orderId', message: 'This order ID appears more than once in the orders array.' });
    }
    if (id) orderIds.add(id);
    for (const item of order.items) {
      row++;
      if (!isObject(item)) {
        errors.push({ row, field: 'items', message: 'Each line item must be an object.' });
        continue;
      }
      records.push({ row, values: {
        orderId, customer: order.customer ?? order.customerReference, lineId: item.id ?? item.lineId,
        name: item.name ?? item.itemName, sku: item.sku, unit: item.unit, quantity: item.quantity,
        status: item.status ?? item.fulfillmentStatus, aliases: item.aliases, nameHi: item.nameHi, nameMr: item.nameMr,
      } });
    }
  }
  return records;
}

export async function parseOrderImport(options) {
  const { format, buffer } = input(options);
  if (format === 'json') {
    const errors = [];
    return collect(jsonRecords(readJson(buffer), errors), errors);
  }
  const source = await readTabular(format, buffer, options.sheet);
  const { mapping, errors } = mappingFor(source, options.mapping);
  if (errors.length) return { orders: [], errors };
  const records = [];
  for (const { row, values } of source.rows) {
    if (values.length > maxColumns || values.slice(source.columns.length).some(value => !isBlank(value))) {
      errors.push({ row, field: 'file', message: 'This row has data beyond the last column header.' });
      continue;
    }
    if (values.some(value => typeof value === 'string' && value.length > maxCellLength)) {
      errors.push({ row, field: 'file', message: 'A cell is longer than 1,024 characters.' });
      continue;
    }
    if (values.some(value => typeof value === 'string' && /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value))) {
      errors.push({ row, field: 'file', message: 'A cell contains an unsupported control character.' });
      continue;
    }
    records.push({ row, values: Object.fromEntries(Object.entries(mapping).map(([key, index]) => [key, values[index]])) });
  }
  return collect(records, errors);
}

export async function orderTemplate(format) {
  const name = 'dispatch-orders-template.' + format;
  const columns = Object.values(fields).map(({ title }) => title);
  if (format === 'csv') {
    return { filename: name, contentType: 'text/csv; charset=utf-8', bytes: Buffer.from('\uFEFF' + columns.join(',') + '\r\n') };
  }
  if (format === 'json') {
    const template = { version: 1, orders: [] };
    return {
      filename: name, contentType: 'application/json; charset=utf-8',
      bytes: Buffer.from(JSON.stringify(template, null, 2) + '\n'),
    };
  }
  if (format === 'xlsx') {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Orders', { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.addRow(columns).font = { bold: true };
    columns.forEach((_, index) => { sheet.getColumn(index + 1).width = 23; });
    for (const column of [1, 2, 3, 5]) sheet.getColumn(column).numFmt = '@';
    return {
      filename: name,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      bytes: Buffer.from(await workbook.xlsx.writeBuffer()),
    };
  }
  throw new ImportError('Choose a CSV, Excel (.xlsx), or JSON template.', 400);
}
