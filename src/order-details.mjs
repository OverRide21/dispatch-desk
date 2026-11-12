export const stages = ['pending', 'picked', 'packed', 'shipped'];
export const orderDetailFields = [
  'availableQuantity', 'backorderAllowed', 'substituteSku', 'backorderQuantity', 'fulfillmentStage',
  'pickedAt', 'packedAt', 'shippedAt', 'deliveryEta', 'editCutoffAt',
];
const milestones = ['pickedAt', 'packedAt', 'shippedAt'];
const dateFields = [...milestones, 'deliveryEta', 'editCutoffAt'];
const clearable = ['availableQuantity', 'substituteSku', 'deliveryEta', 'editCutoffAt'];
const blank = value => value == null || (typeof value === 'string' && !value.trim());

export function orderDetails(item) {
  return Object.fromEntries(orderDetailFields.filter(field => item[field] !== undefined).map(field => [field, item[field]]));
}

function readDate(value, dateOnly) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const date = /^(\d{4}-\d{2}-\d{2})(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/u.exec(text)?.[1];
  if (!date || (!dateOnly && text.length === date.length)) return null;
  const midnight = new Date(date + 'T00:00:00Z');
  if (!Number.isFinite(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== date) return null;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function normalizeOrderDetails(values, { quantity, status, readQuantity, report, inferStage = false }) {
  const details = {};
  for (const field of clearable) {
    const value = values[field];
    if (value === null || (typeof value === 'string' && value.trim().toLowerCase() === '(clear)')) details[field] = null;
  }
  const hasValue = field => !Object.hasOwn(details, field) && !blank(values[field]);
  for (const field of ['availableQuantity', 'backorderQuantity']) {
    if (!hasValue(field)) continue;
    const amount = readQuantity(values[field]);
    if (amount == null) report(field, 'Enter a whole number from 0 to 1,000,000.');
    else details[field] = amount;
  }
  if (details.backorderQuantity > quantity) {
    report('backorderQuantity', 'Backorder quantity cannot exceed the order quantity.');
  }
  if (status === 'shipped' && details.backorderQuantity > 0) {
    report('backorderQuantity', 'Clear the outstanding backorder before marking the line shipped.');
  }
  if (!blank(values.backorderAllowed)) {
    const value = String(values.backorderAllowed).trim().toLowerCase();
    if (['true', 'yes', '1'].includes(value)) details.backorderAllowed = true;
    else if (['false', 'no', '0'].includes(value)) details.backorderAllowed = false;
    else report('backorderAllowed', 'Use yes or no to indicate whether backorders are allowed.');
  }
  if (hasValue('substituteSku')) {
    const raw = values.substituteSku;
    const sku = typeof raw === 'string' || Number.isSafeInteger(raw) && raw >= 0
      ? String(raw).trim().normalize('NFC') : '';
    if (!sku || sku.length > 100 || /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(sku)) {
      report('substituteSku', 'Enter a valid substitute SKU (up to 100 characters).');
    } else details.substituteSku = sku;
  }
  for (const field of dateFields) {
    if (!hasValue(field)) continue;
    const value = readDate(values[field], field === 'deliveryEta');
    if (value === null) report(field, 'Enter an ISO date and time with a time zone, or use an Excel date cell.');
    else details[field] = value;
  }
  let lastTime;
  let lastStage = 0;
  for (const [index, field] of milestones.entries()) {
    if (!details[field]) continue;
    if (lastTime && details[field] < lastTime) report(field, 'Shipment dates must follow the order picked, packed, then shipped.');
    lastTime = details[field];
    lastStage = index + 1;
  }
  if (!blank(values.fulfillmentStage)) {
    const stage = typeof values.fulfillmentStage === 'string' ? values.fulfillmentStage.trim().toLowerCase() : '';
    const rank = stages.indexOf(stage);
    if (rank < 0) report('fulfillmentStage', 'Use pending, picked, packed, or shipped as the fulfillment stage.');
    else if (rank < lastStage) report('fulfillmentStage', 'The stage cannot be earlier than the latest shipment date.');
    else details.fulfillmentStage = stage;
  } else if (inferStage && lastStage) {
    details.fulfillmentStage = status === 'shipped' ? 'shipped' : stages[lastStage];
  }
  if ((details.fulfillmentStage && (details.fulfillmentStage === 'shipped') !== (status === 'shipped')) ||
      (details.shippedAt && status !== 'shipped')) {
    report('fulfillmentStage', 'The shipped stage and shipped status must agree.');
  }
  return details;
}
