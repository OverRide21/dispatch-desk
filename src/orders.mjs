import { randomUUID } from 'node:crypto';
import { productLanguage, quantities, quantityAliases } from './order-data.mjs';

const localeKeys = { 'en-IN': 'en', 'hi-IN': 'hi', 'mr-IN': 'mr' };
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const boundary = (pattern) => `(?<![\\p{L}\\p{M}\\p{N}])(?:${pattern})(?![\\p{L}\\p{M}\\p{N}])`;
const phrases = (values) => new RegExp(boundary(values.map(escapeRegex).join('|')), 'u');
const maxQuantity = 1_000_000;

const numberWords = new Map(Object.entries(quantityAliases));
for (const language of Object.values(quantities)) {
  language.forEach((word, value) => numberWords.set(word.normalize('NFC'), value));
}
const numberPattern = [...numberWords.keys()].sort((a, b) => b.length - a.length)
  .map((word) => escapeRegex(word).replaceAll(' ', '[ -]')).join('|');
const spokenMinus = '(?:minus|negative|उणे|ऋण|माइनस|मायनस) ';
const negativeAmount = new RegExp(`^${spokenMinus}`, 'u');
const numberRegex = new RegExp(boundary(`(?:${spokenMinus})?(?:[+-]?\\d+(?:,\\d{3})+(?:\\.\\d+)?|[+-]?\\d+(?:\\.\\d+)?|${numberPattern})`), 'gu');

const reads = phrases(['status', 'track', 'show', 'list', 'where is', 'where are', 'what is', 'how many', 'has shipped', 'already shipped', 'कितना', 'कितनी', 'कितने', 'कहाँ', 'कहां', 'स्टेटस', 'स्थिति', 'दिखाओ', 'पहुंचा', 'किती', 'कुठे', 'काय आहे', 'दाखवा', 'आली का', 'आले का', 'आला का', 'निघाली का', 'निघाले का', 'पाठवला का', 'तपासा', 'चेक करो', 'पाठवलं आहे', 'भेजा गया है', 'जानकारी', 'माहिती']);
const orderScope = phrases(['order', 'orders', 'shipment', 'dispatch', 'ऑर्डर', 'ऑर्डरची', 'ऑर्डरचा', 'ऑर्डरचे', 'ऑर्डरमध्ये', 'ऑर्डरमधून', 'खेप']);
const shippingStatus = phrases(['shipped', 'dispatched', 'was sent', 'has been sent', 'रवाना', 'पाठवला', 'पाठवली', 'पाठवले', 'पाठवलं', 'निघाली', 'निघाले', 'भेजा', 'भेजी', 'भेज दी']);
const itemStatus = phrases(['status', 'track', 'how many', 'quantity', 'किती', 'कितना', 'कितनी', 'कितने', 'स्टेटस', 'स्थिति', 'माहिती', 'जानकारी']);
const editScope = phrases(['change', 'update', 'modify', 'adjust', 'quantity', 'बदल', 'बदलायचं', 'बदलायचे', 'बदलायची', 'बदलना', 'बदलाव', 'प्रमाण', 'मात्रा', 'संख्या']);
const generalQuestion = phrases(['how do i', 'how can i', 'what is', 'what are', 'why', 'कसा', 'कशी', 'कसे', 'कैसे', 'क्यों']);
const quickStatus = /^(?:status|track|show items|list items|what has shipped|what was shipped|what was dispatched|काय पाठवलं आहे|क्या भेजा गया है|स्टेटस|स्थिति)[.!?।]*$/u;
const changes = phrases(['change', 'modify', 'update', 'set', 'make', 'reduce', 'increase', 'decrease', 'add', 'edit', 'instead', 'बदल', 'बदलो', 'बदलना', 'बदलून', 'बदला', 'कर', 'करा', 'करू', 'कीजिए', 'कीजिये', 'करना', 'कर दें', 'कर दीजिए', 'ठेवा', 'करायचं', 'ऐवजी', 'एवजी', 'जगह', 'बजाय', 'वाढवा', 'घटवा', 'टाका', 'जोड़ो', 'बढ़ाओ', 'घटा दो']);
const removes = phrases(['cancel', 'remove', 'delete', 'drop', 'काढा', 'काढून', 'हटा', 'हटाओ', 'निकाल', 'निकालो', 'रद्द', 'कैंसल', 'कॅन्सल', 'कॅन्सल करा', 'कॅसल']);
const addBy = phrases(['add', 'increase by', 'more', 'और डालो', 'और जोड़ो', 'आणखी', 'अजून', 'ने वाढवा', 'और बढ़ाओ', 'जोड़ो', 'टाका']);
const subtractBy = phrases(['reduce by', 'decrease by', 'less', 'fewer', 'कमी', 'कम', 'घटाकर', 'ने घटवा', 'ने कमी करा']);
const finalQuantity = phrases(['to', 'instead', 'ऐवजी', 'एवजी', 'जगह', 'बजाय', 'वरून', 'कर दो', 'कर दीजिए', 'करा', 'ठेवा']);
const alternate = phrases(['or', 'either', 'या', 'किंवा', 'नाहीतर', 'अथवा', 'नही तो']);
const negative = phrases(['not', 'no', 'नाही', 'नहीं', 'नही', 'नको', 'मत']);
const correction = phrases(['instead', 'rather', 'actually', 'sorry', 'i mean', 'ऐवजी', 'एवजी', 'वरून', 'बजाय', 'की जगह', 'की बजाय', 'मतलब', 'म्हणजे']);
const fromTo = /\bfrom\b.*\bto\b/u;
const largeAmount = phrases(['hundred', 'thousand', 'million', 'lakh', 'crore', 'हजार', 'हज़ार', 'लाख', 'करोड़', 'कोटी']);
const doNotChange = /^(?:please )?(?:don['’]t|do not|नको|मत)\s|(?:काढू नका|रद्द करू नका|बदलू नका|करू नका|मत करो|मत करना|मत हटाओ|मत हटाना|मत निकालो)(?:\s|$)/u;
const wholeOrderCancel = /\b(?:cancel|delete)\s+(?:the\s+|my\s+|this\s+|whole\s+|entire\s+)*order\b|(?:ऑर्डर\s*(?:को\s*)?|सगळं\s+|सब\s+)(?:रद्द|कैंसल|कॅन्सल|काढा)/u;
const addStart = /^(?:please\s+)?add\s+/u;
const addEnd = /\s+(?:जोड़ दो|जोड़ दीजिए|जोड़ें|जोड़ो|डाल दो|डाल दीजिए|डालो|जोडा|टाका|घाला|समाविष्ट करा)$/u;
const unitWords = {
  bags: ['bag', 'bags', 'sack', 'sacks', 'बोरियाँ', 'बोरियां', 'बोरी', 'पिशव्या', 'पिशवी'],
  boxes: ['box', 'boxes', 'case', 'cases', 'बॉक्स', 'केस', 'खोके', 'खोका', 'डिब्बे', 'डिब्बा'],
  kg: ['kg', 'kilo', 'kilos', 'kilogram', 'kilograms', 'किलो', 'किलोग्राम'],
  litres: ['litre', 'litres', 'liter', 'liters', 'लिटर', 'लीटर'],
  pieces: ['piece', 'pieces', 'unit', 'units', 'पीस', 'नग'],
  bottles: ['bottle', 'bottles', 'बोतलें', 'बोतल', 'बाटल्या', 'बाटली'],
  packets: ['packet', 'packets', 'पैकेट', 'पॅकेट'],
};
const unitMentions = Object.entries(unitWords).map(([unit, words]) => [unit, phrases(words)]);
const itemUnits = new Map(unitMentions.map(([unit, pattern]) => [unit, new RegExp(`^${pattern.source}(?=\\s|$)`, 'u')]));

function spokenAddition(text) {
  if (!addStart.test(text) && !addEnd.test(text.replace(/[।.!?]+$/u, ''))) return null;
  const content = text.replace(/[।.!?]+$/u, '').replace(addStart, '').replace(addEnd, '')
    .replace(/^(?:ऑर्डर\s+(?:में|मध्ये|मधे)\s+)|(?:\s+to (?:the |my )?order|\s+ऑर्डर(?:मध्ये|मधे| में))$/u, '').trim();
  if (/[,;!?।]|(?:^|\s)(?:and|but|और|लेकिन|आणि|पण|या|किंवा|नको|नाही|नहीं|मत|not|or|instead|ऐवजी|बजाय)(?=\s|$)/u.test(content)) return null;
  for (const number of content.matchAll(numberRegex)) {
    const quantity = extractQuantity(number[0]).value;
    const after = content.slice(number.index + number[0].length).trimStart();
    const unit = [...itemUnits].find(([, pattern]) => pattern.test(after));
    if (!unit) continue;
    const before = content.slice(0, number.index).trim().replace(/(?:\s+|^)(?:के|की|का|चे|च्या)$/u, '').trim();
    const following = after.replace(unit[1], '').trim().replace(/^(?:of\s+|के\s+|की\s+|का\s+)/u, '');
    if (before && following) return null;
    return { type: 'add', name: before || following, quantity, unit: unit[0] };
  }
  return null;
}

const confirmation = new Set([
  'yes', 'yep', 'yeah', 'confirm', 'confirmed', 'yes confirm', 'go ahead', 'yes go ahead', 'please go ahead', 'go ahead please', 'do it', 'yes do it', 'apply it', 'please apply it', 'apply the change', 'confirm the change', 'yes please', 'yes change it', 'confirm it', 'save it', 'save the change',
  'हो', 'होय', 'हां', 'हाँ', 'हा', 'करा', 'हो करा', 'होय करा', 'बदल करा', 'हो बदल करा', 'हो चालेल', 'होय चालेल', 'हो ठेवा', 'करून टाका', 'हो करून टाका', 'नक्की करा', 'ठीक आहे करा', 'कन्फर्म करा', 'कन्फर्म', 'हो कन्फर्म करा', 'जमा करा', 'कर दो', 'कर दीजिए', 'कर दीजिये', 'हाँ कर दो', 'हां कर दो', 'हाँ कर दीजिए', 'हां कर दीजिए', 'हाँ बदल दो', 'हां बदल दो', 'हाँ बदलाव कर दो', 'हां बदलाव कर दो', 'बदलाव कर दो', 'ठीक है कर दो', 'ठीक है कर दीजिए', 'कन्फर्म कर दो', 'कन्फर्म कर दीजिए', 'कन्फर्म करो', 'बदल दीजिए', 'बदल दीजिये', 'पक्का कर दो', 'हाँ पक्का', 'हाँ पक्का कर दो', 'हाँ कन्फर्म कर दो',
]);
const draftCancellation = new Set([
  'no', 'no thanks', 'cancel', 'cancel it', 'cancel that', 'cancel the change', 'cancel change', 'cancel that change', 'discard', 'discard change', 'discard the change', 'never mind', 'nevermind', 'leave it', 'leave it as is', 'keep it as is', "don't", 'do not', "don't do it", "don't change it", 'do not change it', 'no do not change it', "no don't do it", 'stop', 'forget it',
  'नको', 'नाही', 'नाही नको', 'नको करा', 'नका करू', 'राहू द्या', 'राहूद्या', 'तसंच राहू द्या', 'तसेच ठेवा', 'जसे आहे तसे ठेवा', 'बदल करू नका', 'करू नका', 'नको बदल', 'बदल नको', 'बदल रद्द करा', 'बदल रद्द', 'नको राहू द्या', 'नहीं', 'नही', 'मत करो', 'मत करना', 'मत बदलो', 'नहीं मत करो', 'बदल मत करो', 'बदलाव मत करो', 'नहीं बदलना', 'रहने दो', 'रहने दीजिए', 'वैसा ही रहने दो', 'जैसा है वैसा रहने दो', 'नहीं रहने दो', 'नहीं चाहिए', 'बदलाव रद्द करो', 'बदलाव कैंसल कर दो',
]);

function normalize(text) {
  return text.normalize('NFC').toLowerCase().replace(/[०-९]/gu, (digit) => String(digit.charCodeAt(0) - 0x0966))
    .replace(/[’‘]/gu, "'").replace(/\s+/gu, ' ').trim();
}

function localeFor(text, requested, previous) {
  if (Object.hasOwn(localeKeys, requested)) return requested;
  if (!/[\u0900-\u097f]/u.test(text)) return 'en-IN';
  if (/तांद|आहे|पिशव|आणि|नको|ऐवजी|किती|कुठे|काढा|मराठी|करा|साखर|ठेवा/u.test(text)) return 'mr-IN';
  if (/चावल|बोरि|नहीं|हां|हाँ|कितना|कितनी|कर दो|कर दीजिए|शक्कर|चीनी|कहाँ|है/u.test(text)) return 'hi-IN';
  return previous === 'mr-IN' ? 'mr-IN' : 'hi-IN';
}

function isQuantityWord(text, word, index) {
  // In Hindi “कर दो” and “हटा दो”, “दो” is a verb rather than the number two.
  return word !== 'दो' || !/(?:कर|हटा|बदल|रख|बढ़ा|घटा|निकाल|दे|लगा|दिखा|बता|जोड़)\s+$/u.test(text.slice(0, index));
}

function extractQuantity(text) {
  if (largeAmount.test(text)) return { value: Infinity };
  const matches = [...text.matchAll(numberRegex)].filter((match) => isQuantityWord(text, match[0], match.index));
  const values = matches.map(([raw]) => {
    const amount = raw.replace(negativeAmount, '');
    const value = numberWords.get(amount.replaceAll('-', ' ')) ?? Number(amount.replaceAll(',', ''));
    return amount === raw ? value : -Math.abs(value);
  });
  if (!values.length) return {};
  if (values.length === 1) {
    const [number] = matches;
    const before = text.slice(0, number.index);
    const after = text.slice(number.index + number[0].length);
    const negatesNumber = /(?:\bnot|मत)\s*$/u.test(before)
      || /^\s*(?:bags?\s+|cases?\s+|पिशव्या\s+|बोरियाँ\s+)?(?:नको|नाही|नहीं|नही|मत|\bnot\b)(?=\s|[,.!?।]|$)/u.test(after);
    return negatesNumber ? { ambiguous: true } : { value: values[0] };
  }
  if (values.length !== 2 || alternate.test(text)) return { ambiguous: true };

  const [first, second] = matches;
  const before = text.slice(0, first.index);
  const between = text.slice(first.index + first[0].length, second.index);
  const after = text.slice(second.index + second[0].length);
  if (/\b(?:instead of|rather than|not)\b/u.test(between) || negative.test(after)) return { value: values[0] };
  if (correction.test(between) || /(?:ऐवजी|एवजी|वरून|\b(?:down|up) to\b)/u.test(between) || fromTo.test(text) || negative.test(before) || negative.test(between)) {
    return { value: values[1] };
  }
  if (values[0] === values[1]) return { value: values[0] };
  return { ambiguous: true };
}

function languageInfo(item) {
  const name = normalize(item.name);
  return Object.values(productLanguage).find((product) => product.aliases.includes(name));
}

function matchesItemName(item, name) {
  return [item.name, item.sku, item.nameHi, item.nameMr, ...(item.aliases ?? []), ...(languageInfo(item)?.aliases ?? [])]
    .some(alias => alias && normalize(alias) === name);
}

function itemMatcher(items) {
  const idsByAlias = new Map();
  for (const item of items) {
    const names = [item.id, item.sku, item.name, item.nameHi, item.nameMr, ...(item.aliases ?? []), ...(languageInfo(item)?.aliases ?? [])];
    for (const value of names) {
      if (typeof value !== 'string' || !value.trim()) continue;
      const alias = normalize(value);
      if (!idsByAlias.has(alias)) idsByAlias.set(alias, new Set());
      idsByAlias.get(alias).add(item.id);
    }
  }
  const aliases = [...idsByAlias.keys()].sort((a, b) => b.length - a.length);
  const match = aliases.length ? new RegExp(boundary(aliases.map(escapeRegex).join('|')), 'gu') : null;
  return {
    ids(text) {
      if (!match) return [];
      return [...new Set([...text.matchAll(match)].flatMap(([alias]) => [...idsByAlias.get(alias)]))];
    },
    withoutItems(text) {
      return match ? text.replace(match, ' ') : text;
    },
  };
}

function unitFamily(unit) {
  if (unit === 'l') return 'litres';
  return unitMentions.find(([, pattern]) => pattern.test(unit))?.[0] ?? unit;
}

function unitLabel(item, quantity, locale) {
  if (locale === 'en') return item.unit;
  return {
    bags: { hi: ['बोरी', 'बोरियाँ'], mr: ['पिशवी', 'पिशव्या'] },
    boxes: { hi: ['डिब्बा', 'डिब्बे'], mr: ['खोका', 'खोके'] },
    kg: { hi: ['किलो', 'किलो'], mr: ['किलो', 'किलो'] },
    litres: { hi: ['लीटर', 'लीटर'], mr: ['लिटर', 'लिटर'] },
    pieces: { hi: ['पीस', 'पीस'], mr: ['नग', 'नग'] },
    bottles: { hi: ['बोतल', 'बोतलें'], mr: ['बाटली', 'बाटल्या'] },
    packets: { hi: ['पैकेट', 'पैकेट'], mr: ['पॅकेट', 'पॅकेट'] },
  }[unitFamily(normalize(item.unit))]?.[locale]?.[quantity === 1 ? 0 : 1] ?? item.unit;
}

function describeAmount(item, quantity, locale) {
  return `${quantities[locale][quantity] ?? quantity} ${unitLabel(item, quantity, locale)}`;
}

function productName(item, locale) {
  return (locale === 'hi' ? item.nameHi : locale === 'mr' ? item.nameMr : '') || languageInfo(item)?.[locale]?.[0] || item.name;
}

function marathiItemAmount(item, quantity) {
  const name = productName(item, 'mr');
  const product = { तांदूळ: 'तांदळाच्या', साखर: 'साखरेच्या', तेल: 'तेलाचे' }[name];
  return product ? `${product} ${describeAmount(item, quantity, 'mr')}` : `${name} — ${describeAmount(item, quantity, 'mr')}`;
}

function hindiItemAmount(item, quantity) {
  const name = productName(item, 'hi');
  const product = { चावल: 'चावल की', चीनी: 'चीनी की', तेल: 'तेल के' }[name];
  return product ? `${product} ${describeAmount(item, quantity, 'hi')}` : `${name} — ${describeAmount(item, quantity, 'hi')}`;
}

function describeOrder(items, locale) {
  return items.map((item) => {
    const name = productName(item, locale);
    const quantity = describeAmount(item, item.quantity, locale);
    const status = item.status === 'shipped';
    return {
      en: `${name}, ${quantity}, ${status ? 'already shipped' : 'awaiting dispatch'}`,
      hi: `${name}, ${quantity}. ${status ? 'खेप भेज दी गई है' : 'खेप अभी गोदाम में है'}`,
      mr: `${marathiItemAmount(item, item.quantity)}. ${status ? 'माल रवाना झाला आहे' : 'माल अजून गोदामात आहे'}`,
    }[locale];
  }).join('. ');
}

function orderReference(text, id) {
  const reference = normalize(id);
  const explicit = /(?:\border|ऑर्डर)\s+(?:id|number|no\.?|नंबर|क्रमांक)\s*[:#]?\s*([a-z\d_.-]+)|#([a-z]*[-_]?\d[\w-]*)/gu;
  const refs = [...text.matchAll(explicit)].map(([, named, tagged]) => (named ?? tagged).replace(/\.+$/u, ''));
  const exact = new RegExp(boundary(escapeRegex(reference)), 'u');
  const canStrip = /[a-z]/u.test(reference) && /[\d]/u.test(reference);
  const command = text.replace(explicit, ' ');
  return { wrong: refs.some(value => value !== reference), rest: (canStrip ? command.replace(exact, ' ') : command).trim(), found: refs.length > 0 || (canStrip && exact.test(command)) };
}

function clausesFor(text, mentionIds) {
  const chunks = text.split(/([;।!?]+|\.(?!\d)|,(?=\s)|\s+(?:and|but|और|लेकिन|आणि|पण|तसेच)\s+)/u);
  const clauses = [];
  for (let index = 0; index < chunks.length; index += 2) {
    const clause = chunks[index].trim();
    if (!clause) continue;
    if (clauses.length && !mentionIds(clause).length) clauses[clauses.length - 1] += `${chunks[index - 1]} ${clause}`.replace(/\s+/gu, ' ');
    else clauses.push(clause);
  }
  return clauses;
}

const basicQuestion = {
  en: 'Which item would you like to change, and what should the new quantity be?',
  hi: 'आप किस सामान की मात्रा बदलना चाहते हैं, और कितनी कर दूँ?',
  mr: 'कोणत्या वस्तूचे प्रमाण बदलायचे आहे, आणि किती करू?',
};

const spokenWording = {
  clarify: {
    en: [basicQuestion.en, 'Could you say the item and the new total together? For example, “set rice to two bags.”', 'Tell me the item name and how many you want in total.'],
    hi: [basicQuestion.hi, 'सामान का नाम और नई मात्रा एक साथ बताएँगे? जैसे, “चावल की दो बोरियाँ कर दीजिए।”', 'सामान का नाम बताइए, और बताइए कि कुल कितना चाहिए।'],
    mr: [basicQuestion.mr, 'वस्तूचं नाव आणि नवीन प्रमाण एकत्र सांगाल का? उदा. “तांदळाच्या दोन पिशव्या करा.”', 'वस्तूचं नाव सांगा. तिचं एकूण प्रमाण किती ठेवायचं तेही सांगा.'],
  },
  outOfScope: {
    en: ['I can only help with the order you have open. Would you like to check what’s shipped or change an item that’s still pending?', 'That’s outside what I can help with here. I can check your order or help you update an item that hasn’t shipped. What would you like to do?'],
    hi: ['मैं यहाँ सिर्फ़ आपके खुले ऑर्डर में मदद कर सकता हूँ। क्या आप देखना चाहेंगे कि क्या भेजा जा चुका है, या बाकी सामान में कोई बदलाव करना है?', 'उस सवाल में मैं मदद नहीं कर पाऊँगा। अगर आपको ऑर्डर की स्थिति देखनी है या भेजे जाने से पहले कोई सामान बदलना है, तो बताइए।'],
    mr: ['इथे मी फक्त तुमच्या उघड्या ऑर्डरबद्दल मदत करू शकतो. कोणता माल रवाना झाला ते पाहायचं आहे, की अजून न पाठवलेल्या वस्तूत बदल करायचा आहे?', 'त्या प्रश्नात मला मदत करता येणार नाही. पण ऑर्डरची स्थिती तपासायची असेल किंवा अजून न पाठवलेल्या वस्तूत बदल करायचा असेल, तर सांगा.'],
  },
  proposeAddition: {
    en: ['Shall I add {amount} to your order?', 'Should I go ahead and add {amount}?'],
    hi: ['क्या मैं {amount} जोड़ दूँ?', 'ठीक है, {amount} ऑर्डर में जोड़ दूँ?'],
    mr: ['{amount} ऑर्डरमध्ये टाकू का?', 'ठीक आहे, {amount} घालू का?'],
  },
  propose: {
    en: ['Shall I change it to {amount}?', 'Should I go ahead with {amount}?'],
    hi: ['क्या मैं {amount} कर दूँ?', 'ठीक है, {amount} कर दूँ?'],
    mr: ['{amount} करू का?', 'ठीक आहे, {amount} ठेवू का?'],
  },
  saved: {
    en: ['All set. The order now has {amount}.', 'I saved the change. The order now has {amount}.'],
    hi: ['हो गया। ऑर्डर में अब {amount} हैं।', 'बदलाव हो गया। अब आपके ऑर्डर में {amount} हैं।'],
    mr: ['झालं. आता ऑर्डरमध्ये {amount} आहेत.', 'बदल केला आहे. आता ऑर्डरमध्ये {amount} आहेत.'],
  },
  proposeRemoval: {
    en: ['Shall I remove {amount} from the order?', 'Should I go ahead and remove {amount}?'],
    hi: ['क्या मैं {amount} ऑर्डर से हटा दूँ?', 'ठीक है, {amount} हटा दूँ?'],
    mr: ['ऑर्डरमधून {amount} काढू का?', 'ठीक आहे, {amount} काढू का?'],
  },
  removed: {
    en: ['Done. I removed {amount} from the order.', '{amount} has been removed from the order.'],
    hi: ['हो गया। {amount} ऑर्डर से हटा दिया है।', 'आपके ऑर्डर से {amount} हटा दिया है।'],
    mr: ['झालं. ऑर्डरमधून {amount} काढला आहे.', 'तुमच्या ऑर्डरमधून {amount} काढला आहे.'],
  },
};

export function createSession(order, language = 'en-IN') {
  const { history = [], ...record } = order;
  const greetings = {
    'en-IN': `I have order ${record.id} open. What would you like to change?`,
    'hi-IN': `ऑर्डर ${record.id} मेरे सामने है। आप क्या बदलना चाहते हैं?`,
    'mr-IN': `ऑर्डर ${record.id} माझ्यासमोर आहे. तुम्हाला काय बदलायचं आहे?`,
  };
  return {
    order: structuredClone(record),
    pending: null,
    focus: null,
    history: structuredClone(history),
    messages: [{ role: 'agent', text: greetings[language], language }],
  };
}

export function snapshot({ order, pending, history, messages }) {
  return structuredClone({ order, pending, history, messages });
}

export function handleTurn(session, { text = '', language, itemAction } = {}) {
  const input = typeof text === 'string' ? normalize(text) : '';
  const locale = localeFor(input, language, session.messages.at(-1)?.language);
  const key = localeKeys[locale];
  const t = (en, hi, mr) => ({ en, hi, mr }[key]);
  const previousReply = session.messages.at(-1)?.text;
  const speak = (reply, choices, change) => {
    session.messages.push({ role: 'agent', text: reply, language: locale });
    if (session.messages.length > 81) session.messages.splice(0, session.messages.length - 81);
    return { reply, language: locale, choices, change };
  };
  const rejectChange = reply => ({ ...speak(reply), rejectedChange: true });
  const ask = (kind, prefix) => {
    const options = spokenWording[kind][key];
    const reply = options.find(option => !previousReply?.endsWith(option));
    return speak([prefix, reply].filter(Boolean).join(' '), { options, amount: '', prefix });
  };
  const clarifyChange = () => ask('clarify');
  if (!input) return speak(t('I missed that. Could you try again?', 'मुझे सुनाई नहीं दिया। फिर से कहेंगे?', 'मला ऐकू आलं नाही. पुन्हा सांगाल का?'));
  session.messages.push({ role: 'caller', text: text.trim(), language: locale });

  const draftItem = session.pending?.newItem;
  const orderItems = session.order.items;
  const knownItems = draftItem ? [...orderItems, draftItem] : orderItems;
  const getItem = (id) => knownItems.find((item) => item.id === id);
  const matcher = itemMatcher(knownItems);
  const mentionIds = matcher.ids;
  const noChange = () => speak(t('There’s no change waiting for confirmation. What would you like to update?', 'अभी कोई बदलाव पुष्टि के लिए बाकी नहीं है। क्या बदलना है?', 'सध्या पुष्टीसाठी कोणताही बदल बाकी नाही. काय बदलायचं आहे?'));
  const blocked = (item) => {
    const name = productName(item, key);
    return t(`${name} has already shipped, so I can’t change it or remove it from the order.`, `${name} की खेप पहले ही भेज दी गई है। अब बदलाव नहीं हो सकता और इसे ऑर्डर से हटाया भी नहीं जा सकता।`, `${name} असलेली खेप आधीच रवाना झाली आहे. आता बदल करता येणार नाही आणि ती वस्तू ऑर्डरमधून काढताही येणार नाही.`);
  };
  const clearDraft = () => { session.pending = null; session.focus = null; };
  function proposeAddition(action) {
    clearDraft();
    const name = typeof action.name === 'string' ? action.name.trim().normalize('NFC') : '';
    const quantity = action.quantity;
    const unit = action.unit;
    if (!name || name.length > 180 || !/\p{L}/u.test(name) || /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(name) || !itemUnits.has(unit)) {
      return rejectChange(t('Tell me the item name and its unit, such as bags or bottles.', 'सामान का नाम और उसकी इकाई बताइए, जैसे बोरी या बोतल।', 'वस्तूचं नाव आणि एकक सांगा, उदा. पिशव्या किंवा बाटल्या.'));
    }
    const normalizedName = normalize(name);
    const existing = orderItems.find(item => matchesItemName(item, normalizedName));
    if (existing?.status === 'shipped') return rejectChange(blocked(existing));
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > maxQuantity) {
      return rejectChange(t(`To add ${name}, enter a whole quantity between 1 and ${maxQuantity}.`, `${name} जोड़ने के लिए मात्रा 1 से ${maxQuantity} के बीच की पूर्ण संख्या में बताइए।`, `${name} जोडण्यासाठी 1 ते ${maxQuantity} यांमधली पूर्ण संख्या सांगा.`));
    }
    if (existing?.quantity) {
      session.focus = existing.id;
      return speak(t(`${existing.name} is already on the order. What should its total quantity be?`, `${productName(existing, key)} ऑर्डर में पहले से है। इसकी कुल मात्रा कितनी रखूँ?`, `${productName(existing, key)} ऑर्डरमध्ये आधीच आहे. एकूण किती ठेवू?`));
    }
    if (existing && unitFamily(existing.unit) !== unitFamily(unit)) {
      return speak(t(`Use ${existing.unit} for ${existing.name}.`, `${productName(existing, key)} के लिए ${existing.unit} में मात्रा बताइए।`, `${productName(existing, key)} याचं प्रमाण ${existing.unit} मध्ये सांगा.`));
    }
    const item = existing ?? { id: randomUUID(), name, unit, quantity: 0, status: 'pending' };
    session.pending = { itemId: item.id, name: item.name, from: 0, to: quantity, ...(existing ? {} : { newItem: item }) };
    const amount = describeAmount(item, quantity, key);
    const detail = t(`${amount} of ${item.name}`, hindiItemAmount(item, quantity), marathiItemAmount(item, quantity));
    const options = spokenWording.proposeAddition[key];
    return speak(options[0].replace('{amount}', () => detail), { options, amount: detail });
  }
  if (itemAction?.type === 'add') return proposeAddition(itemAction);
  if (itemAction?.type === 'remove') {
    clearDraft();
    const item = orderItems.find(line => line.id === itemAction.itemId);
    if (!item || (!item.quantity && item.status !== 'shipped')) return speak(t('That item is no longer on the order.', 'यह सामान अब ऑर्डर में नहीं है।', 'ही वस्तू आता ऑर्डरमध्ये नाही.'));
    if (item.status === 'shipped') return rejectChange(blocked(item));
    const name = productName(item, key);
    session.pending = { itemId: item.id, name: item.name, from: item.quantity, to: 0 };
    return speak(t(`Shall I remove ${name} from the order?`, `क्या मैं ${name} ऑर्डर से हटा दूँ?`, `ऑर्डरमधून ${name} काढू का?`), { options: spokenWording.proposeRemoval[key], amount: name });
  }
  const normalizedAnswer = input.replace(/[,.!।;]+/gu, ' ').replace(/\s+/gu, ' ').trim();

  if (draftCancellation.has(normalizedAnswer)) {
    if (!session.pending && !session.focus) return noChange();
    clearDraft();
    return speak(t('Okay, I’ve left the order as it was.', 'ठीक है, ऑर्डर वैसा ही रहेगा।', 'ठीक आहे, ऑर्डर जशी होती तशीच ठेवली आहे.'));
  }
  if (confirmation.has(normalizedAnswer)) {
    const pending = session.pending;
    if (!pending) return noChange();
    const item = getItem(pending.itemId);
    clearDraft();
    if (!item || item.status !== 'pending' || item.quantity !== pending.from) {
      return speak(t('The order changed while we were talking. Let’s check it again.', 'बात करते समय ऑर्डर बदल गया। चलिए फिर से देखते हैं।', 'आपण बोलत असताना ऑर्डर बदलली. पुन्हा तपासूया.'));
    }
    if (pending.newItem) orderItems.push(item);
    item.quantity = pending.to;
    const { newItem, ...entry } = pending;
    session.history.unshift({ ...entry, at: new Date().toISOString() });
    const name = productName(item, key);
    const amount = describeAmount(item, item.quantity, key);
    if (item.quantity === 0) return speak(t(`Done. I removed the ${name} from the order.`, `हो गया। ${name} ऑर्डर से हटा दिया है।`, `झालं. ऑर्डरमधून ${name} काढला आहे.`), { options: spokenWording.removed[key], amount: name }, pending);
    const detail = t(`${amount} of ${name}`, hindiItemAmount(item, item.quantity), marathiItemAmount(item, item.quantity));
    return speak(t(`Done. The order now has ${detail}.`, `हो गया। ऑर्डर में अब ${detail} हैं।`, `झालं. ऑर्डरमध्ये आता ${detail} आहेत.`), { options: spokenWording.saved[key], amount: detail }, pending);
  }

  const reference = orderReference(input, session.order.id);
  if (reference.wrong) {
    clearDraft();
    return speak(t('That reference differs from the open order. Open the correct order first.', 'यह खुले ऑर्डर का नंबर नहीं है। पहले सही ऑर्डर खोलें।', 'हा उघड्या ऑर्डरचा क्रमांक नाही. आधी योग्य ऑर्डर उघडा.'));
  }
  const command = reference.rest;
  const itemIds = mentionIds(command);
  const isOrderRead = (text, ids) => quickStatus.test(text) ||
    (orderScope.test(text) && (reads.test(text) || shippingStatus.test(text))) ||
    (ids.length > 0 && (shippingStatus.test(text) || itemStatus.test(text)));
  const isGeneralQuestion = (text, ids) => generalQuestion.test(text) && !isOrderRead(text, ids) &&
    !orderScope.test(text) && !editScope.test(text);
  const addition = !doNotChange.test(command) ? spokenAddition(command) : null;
  if (addition && !knownItems.some(item => matchesItemName(item, normalize(addition.name)))) return proposeAddition(addition);
  const isRead = isOrderRead(command, itemIds);
  if (wholeOrderCancel.test(input)) {
    clearDraft();
    return rejectChange(t('I can remove an item that hasn’t shipped. A full order cancellation needs the dispatch team.', 'जो सामान भेजा नहीं गया है, उसे हटा सकता हूँ। पूरा ऑर्डर रद्द करने के लिए डिस्पैच टीम से बात करनी होगी।', 'अजून न पाठवलेली वस्तू काढता येईल. पूर्ण ऑर्डर रद्द करण्यासाठी डिस्पॅच टीमशी बोलावं लागेल.'));
  }

  const clauses = clausesFor(command, mentionIds);
  const plans = [];
  const unavailable = new Set();
  const unclear = new Set();
  const invalid = new Map();
  let readItems = [];
  let pairedScope = false;
  const contextItem = session.pending?.itemId ?? session.focus;

  for (const clause of clauses) {
    const ids = mentionIds(clause);
    const quantity = extractQuantity(matcher.withoutItems(clause));
    const hasQuantity = quantity.ambiguous || quantity.value !== undefined;
    const declinesItem = ids.length > 0 && !hasQuantity && /(?:नको|नहीं चाहिए|नही चाहिए)$/u.test(clause);
    const hasAction = changes.test(clause) || removes.test(clause) || addBy.test(clause) || subtractBy.test(clause) || declinesItem;
    const wantsRead = isOrderRead(clause, ids) && !hasAction;
    if (wantsRead) {
      readItems.push(...ids);
      continue;
    }
    if (doNotChange.test(clause)) continue;
    if (isGeneralQuestion(clause, ids)) continue;
    if (reads.test(clause) && !hasAction) continue;
    if (ids.length && !hasAction && !hasQuantity) {
      if (!matcher.withoutItems(clause).replace(/[,.!?।-]/gu, '').trim()) {
        readItems.push(...ids);
        pairedScope = true;
      }
      continue;
    }
    if (!hasAction && !hasQuantity) continue;
    // A bare quantity is a valid follow-up only after an item was established.
    if (!ids.length && contextItem && hasQuantity && !removes.test(clause)) {
      const remainder = clause.replace(numberRegex, (word, index) => isQuantityWord(clause, word, index) ? ' ' : word).trim();
      const recognizedFollowUp = /^(?:\s|[,.!?।-]|no\b|not\b|sorry\b|actually\b|i mean\b|make it\b|change it to\b|set it to\b|instead\b|bags?\b|cases?\b|please\b|नाही|नहीं|नही|नको|पण|लेकिन|हो|हाँ|हां|कर दो|कर दीजिए|कर दीजिये|करा|ठेवा|पिशव्या|पिशवी|बोरियाँ|बोरी|खोके|खोका|डिब्बे|डिब्बा|ही|त्याऐवजी|ऐवजी|उसकी जगह|की जगह|करें|कमी करा|कम करो|आणखी|और डालो|फक्त|सिर्फ)+$/u.test(remainder);
      if (!remainder || recognizedFollowUp) ids.push(contextItem);
    }
    if (ids.length !== 1) {
      if (ids.length > 1) pairedScope = true;
      continue;
    }

    const item = getItem(ids[0]);
    if (item.status === 'shipped') { unavailable.add(item); continue; }
    if (quantity.ambiguous) { unclear.add(item); continue; }
    const removalIntent = removes.test(clause) || declinesItem;
    const removing = removalIntent && !hasQuantity;
    let target = removing ? 0 : quantity.value;
    if (target === undefined) { unclear.add(item); continue; }

    const englishDelta = /\b(reduce|decrease|increase)\b.*\bby\b/u.exec(clause)?.[1];
    const delta = englishDelta
      || (subtractBy.test(clause) && !correction.test(clause) && !/\bto\b|वर|तक/u.test(clause))
      || (addBy.test(clause) && !correction.test(clause) && !/\bto\b|वर|तक/u.test(clause));
    if (removalIntent && hasQuantity && !finalQuantity.test(clause) && target >= 0) target = item.quantity - target;
    else if (delta && target >= 0) target = item.quantity + (subtractBy.test(clause) || englishDelta === 'reduce' || englishDelta === 'decrease' ? -target : target);
    const unit = unitFamily(normalize(item.unit));
    const remainder = matcher.withoutItems(clause);
    const incompatibleUnit = unitMentions.some(([family, pattern]) => family !== unit && pattern.test(remainder));
    const limit = Math.min(item.limit ?? maxQuantity, maxQuantity);
    const name = productName(item, key);
    let reason;
    if (target < 0) {
      reason = t(`${name} can’t have a negative quantity. Enter zero to remove it or give a positive quantity.`, `${name} की मात्रा शून्य से कम नहीं हो सकती। हटाने के लिए शून्य बताइए, या शून्य से बड़ी मात्रा बताइए।`, `${name} या वस्तूचं प्रमाण शून्यापेक्षा कमी ठेवता येत नाही. काढण्यासाठी शून्य सांगा किंवा त्यापेक्षा जास्त प्रमाण द्या.`);
    } else if (target > limit) {
      const max = describeAmount(item, limit, key);
      reason = t(`The maximum for ${name} is ${max}. What quantity should I use within that limit?`, `${name} के लिए अधिकतम मात्रा ${max} है। इस सीमा में कितनी मात्रा रखूँ?`, `${name}साठी जास्तीत जास्त ${max} ठेवता येतील. या मर्यादेत किती ठेवू?`);
    } else if (!Number.isInteger(target)) {
      reason = t(`${name} needs a whole number. What whole quantity should I use?`, `${name} की मात्रा पूर्ण संख्या में होनी चाहिए। कितनी रखूँ?`, `${name} या वस्तूचं प्रमाण पूर्ण संख्येत असावं लागेल. किती ठेवू?`);
    } else if (incompatibleUnit) {
      const expected = unitLabel(item, 2, key);
      reason = t(`This order measures ${name} in ${expected}. How many ${expected} should I use?`, `इस ऑर्डर में ${name} की इकाई ${expected} है। इसी इकाई में मात्रा बताइए।`, `या ऑर्डरमध्ये ${name}साठी एकक ${expected} आहे. त्याच एककात प्रमाण सांगा.`);
    }
    if (reason) {
      invalid.set(item, reason);
      continue;
    }
    plans.push({ itemId: item.id, name: item.name, from: item.quantity, to: target, ...(item === draftItem ? { newItem: item } : {}) });
  }

  const blockedText = [...unavailable].map(blocked).join(' ');
  if (invalid.size) {
    clearDraft();
    const [item] = invalid.keys();
    session.focus = invalid.size === 1 && plans.length === 0 ? item.id : null;
    return rejectChange([blockedText, ...invalid.values()].filter(Boolean).join(' '));
  }
  if (pairedScope && (plans.length || unavailable.size || unclear.size) && itemIds.length > 1) {
    clearDraft();
    return blockedText ? rejectChange(`${blockedText} ${basicQuestion[key]}`) : clarifyChange();
  }
  if (unclear.size || plans.length > 1) {
    clearDraft();
    let response = basicQuestion[key];
    if (unclear.size === 1 && !plans.length) {
      const [item] = unclear;
      session.focus = item.id;
      const name = productName(item, key);
      response = t(`What should the final quantity of ${name} be?`, `${name} की कुल मात्रा कितनी कर दूँ?`, `${name} एकूण किती ठेवायचा?`);
    }
    if (!blockedText && response === basicQuestion[key]) return clarifyChange();
    return speak([blockedText, response].filter(Boolean).join(' '));
  }
  if (plans.length === 1) {
    const [proposal] = plans;
    const item = getItem(proposal.itemId);
    session.focus = null;
    const name = productName(item, key);
    const amount = describeAmount(item, proposal.to, key);
    let response;
    let choices;
    if (proposal.from === proposal.to) {
      session.pending = null;
      response = t(`The order already has ${amount} of ${name}.`, `ऑर्डर में ${hindiItemAmount(item, proposal.to)} पहले से हैं।`, `ऑर्डरमध्ये ${marathiItemAmount(item, proposal.to)} आधीपासूनच आहेत.`);
    } else {
      session.pending = proposal;
      response = proposal.to === 0
        ? t(`I can remove the ${name}. Shall I go ahead?`, `${name} हटा सकता हूँ। कर दूँ?`, `${name} काढता येईल. काढू का?`)
        : t(`I can set ${name} to ${amount}. Shall I make that change?`, `${hindiItemAmount(item, proposal.to)} कर सकता हूँ। यह बदलाव कर दूँ?`, `${marathiItemAmount(item, proposal.to)} करता येतील. हा बदल करू का?`);
      choices = proposal.to === 0
        ? { options: spokenWording.proposeRemoval[key], amount: name, prefix: blockedText }
        : { options: spokenWording.propose[key], amount: t(`${amount} of ${name}`, hindiItemAmount(item, proposal.to), marathiItemAmount(item, proposal.to)), prefix: blockedText };
    }
    return speak([blockedText, response].filter(Boolean).join(' '), choices);
  }
  if (unavailable.size) {
    clearDraft();
    return rejectChange(blockedText);
  }
  if (isRead || readItems.length || reference.found) {
    if (!readItems.length) readItems = itemIds;
    const items = (readItems.length ? [...new Set(readItems)].map(getItem) : orderItems)
      .filter(item => item.quantity > 0 || item.status === 'shipped');
    const pendingReminder = session.pending ? t(' Your proposed change is still waiting for confirmation.', ' आपका बदलाव अभी पुष्टि के लिए बाकी है।', ' तुम्ही सांगितलेल्या बदलाला अजून पुष्टी हवी आहे.') : '';
    const details = items.length ? describeOrder(items, key) + '.' : t('There are no active items here.', 'यहाँ कोई सक्रिय सामान नहीं है।', 'इथे सध्या कोणतीही वस्तू नाही.');
    return speak(details + pendingReminder);
  }
  if (doNotChange.test(command)) {
    clearDraft();
    return speak(t('Okay, I’ve left the order as it was.', 'ठीक है, ऑर्डर वैसा ही रहेगा।', 'ठीक आहे, ऑर्डर जशी होती तशीच ठेवली आहे.'));
  }

  const quantityRemainder = command.replace(numberRegex, ' ').replace(/\s+/gu, ' ').trim();
  const bareQuantity = quantityRemainder !== command && /^(?:(?:फक्त|सिर्फ)\s+)?(?:करा|कर दो|कर दीजिए)?[.!।]?$/u.test(quantityRemainder);
  const orderRequest = orderScope.test(command) || editScope.test(command) || bareQuantity ||
    (changes.test(command) && (itemIds.length > 0 || unitMentions.some(([, pattern]) => pattern.test(command))));
  if (!orderRequest || isGeneralQuestion(command, itemIds)) {
    const pendingReminder = session.pending ? t('Your proposed change is still waiting for confirmation.', 'आपका बदलाव अभी पुष्टि के लिए बाकी है।', 'तुम्ही सांगितलेल्या बदलाला अजून पुष्टी हवी आहे.') : '';
    return ask('outOfScope', pendingReminder);
  }
  if (session.pending || session.focus) {
    const draftItem = getItem(session.pending?.itemId ?? session.focus);
    clearDraft();
    session.focus = draftItem?.id ?? null;
    return speak(t('I didn’t get the latest change. Could you say the item and final quantity again?', 'आख़िरी बदलाव समझ नहीं आया। सामान और कुल मात्रा फिर से बताएँगे?', 'शेवटचा बदल कळला नाही. वस्तू आणि एकूण प्रमाण पुन्हा सांगाल का?'));
  }
  return clarifyChange();
}
