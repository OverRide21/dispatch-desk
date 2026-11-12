export const unitWords = {
  bags: ['bag', 'bags', 'sack', 'sacks', 'pishvya', 'pishvi', 'bori', 'boriyan', 'बोरियाँ', 'बोरियां', 'बोरी', 'पिशव्या', 'पिशवी'],
  boxes: ['box', 'boxes', 'case', 'cases', 'बॉक्स', 'केस', 'खोके', 'खोका', 'डिब्बे', 'डिब्बा'],
  kg: ['kg', 'kilo', 'kilos', 'kilogram', 'kilograms', 'किलो', 'किलोग्राम'],
  litres: ['litre', 'litres', 'liter', 'liters', 'लिटर', 'लीटर'],
  pieces: ['piece', 'pieces', 'unit', 'units', 'पीस', 'नग'],
  bottles: ['bottle', 'bottles', 'बोतलें', 'बोतल', 'बाटल्या', 'बाटली'],
  packets: ['packet', 'packets', 'पैकेट', 'पॅकेट'],
};

export function stockUnitFamily(unit) {
  const normalized = unit.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim();
  if (normalized === 'l') return 'litres';
  return Object.entries(unitWords).find(([, words]) => words.includes(normalized))?.[0] ?? normalized;
}

export function fulfillmentStage(item) {
  return item.status === 'shipped' ? 'shipped' : item.fulfillmentStage ?? 'pending';
}

export function editLockReason(item, now = Date.now()) {
  const stage = fulfillmentStage(item);
  if (stage === 'shipped' || stage === 'packed') return stage;
  if (item.editCutoffAt && Date.parse(item.editCutoffAt) <= now) return 'cutoff';
  return null;
}
