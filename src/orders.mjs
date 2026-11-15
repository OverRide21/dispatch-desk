import { randomUUID } from 'node:crypto';
import { productLanguage, quantities, quantityAliases } from './order-data.mjs';
import { editLockReason, fulfillmentStage, stockUnitFamily, unitWords } from './order-policies.mjs';

const localeKeys = { 'en-IN': 'en', 'hi-IN': 'hi', 'mr-IN': 'mr' };
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const boundary = (pattern) => `(?<![\\p{L}\\p{M}\\p{N}])(?:${pattern})(?![\\p{L}\\p{M}\\p{N}])`;
const phrases = (values) => new RegExp(boundary(values.map(escapeRegex).join('|')), 'u');
const maxQuantity = 1_000_000;
const packSize = /\s+\(\d+(?:\.\d+)?\s*(?:g|kg|ml|l)\)$/iu;

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
const deliveryTopics = phrases(['eta', 'delivery estimate', 'delivery date', 'estimated delivery', 'अंदाजे वितरण', 'डिलीवरी की तारीख', 'डिलिव्हरीची अपेक्षित तारीख']);
const deliveryQuestions = phrases(['when will it arrive', 'when will it be delivered', 'arrive', 'कधी येईल', 'कधी पोहोचेल', 'कब आएगा', 'कब आएगी', 'कब पहुँचेगा', 'कब पहुँचेगी']);
const stockQuestion = phrases(['in stock', 'available', 'availability', 'उपलब्ध', 'स्टॉक', 'मौजूद']);
const stockChoice = new Map([
  ['take available stock', 'partial'], ['available stock only', 'partial'], ['take available', 'partial'],
  ['take the available stock', 'partial'], ["i'll take the available stock", 'partial'],
  ['उपलब्ध माल घ्या', 'partial'], ['जेवढं उपलब्ध आहे तेवढंच घ्या', 'partial'], ['उपलब्ध माल ले लो', 'partial'],
  ['जितना उपलब्ध है उतना रखो', 'partial'], ['backorder the rest', 'backorder'], ['backorder', 'backorder'],
  ['उरलेला माल नंतर पाठवा', 'backorder'], ['बाकी माल बाद में भेजो', 'backorder'],
  ['use the substitute', 'substitute'], ['substitute', 'substitute'], ['पर्यायी वस्तू घ्या', 'substitute'],
  ['पर्याय घ्या', 'substitute'], ['विकल्प ले लो', 'substitute'], ['विकल्प चुनें', 'substitute'],
]);
const itemStatus = phrases(['status', 'track', 'how many', 'quantity', 'किती', 'कितना', 'कितनी', 'कितने', 'स्टेटस', 'स्थिति', 'माहिती', 'जानकारी']);
const editScope = phrases(['change', 'update', 'modify', 'adjust', 'quantity', 'बदल', 'बदलायचं', 'बदलायचे', 'बदलायची', 'बदलना', 'बदलाव', 'प्रमाण', 'मात्रा', 'संख्या']);
const generalQuestion = phrases(['how do i', 'how can i', 'what is', 'what are', 'why', 'कसा', 'कशी', 'कसे', 'कैसे', 'क्यों']);
const quickStatus = /^(?:status|track|show items|list items|what has shipped|what was shipped|what was dispatched|काय पाठवलं आहे|क्या भेजा गया है|स्टेटस|स्थिति)[.!?।]*$/u;
const lookupQuestion = phrases(['is', 'are', 'has', 'have', 'when', 'what', 'tell me', 'check', 'क्या', 'कब', 'बताइए', 'बताओ', 'बता दीजिए',
  'देख सकते हैं', 'का', 'कधी', 'किती', 'कळवा', 'सांगाल', 'सांगता', 'सांगा']);
const lookupStock = phrases(['stock', 'out of stock', 'उपलब्धता', 'साठा', 'साठ्यात', 'खत्म हो गया', 'संपली']);
const lookupShipment = phrases(['shipped', 'dispatched', 'shipment status', 'tracking', 'status', 'स्टेटस', 'स्थिति', 'रवाना',
  'निकल गया', 'निघाला', 'निघाली', 'पाठवलं', 'भेज दिया', 'डिस्पैच हुआ']);
const lookupDelivery = phrases(['delivery date', 'delivery estimate', 'estimated delivery', 'डिलीवरी डेट', 'अनुमानित दिन',
  'अनुमानित समय', 'कोणत्या दिवशी येईल', 'कधी येणार', 'कधी येईल']);
const lookupEtaQuestion = /\bwhen\b.*\b(?:arrive|arrives|deliver|delivered|get)\b|(?:कब|किस तारीख).*?(?:मिलेगा|मिलेगी|पहुँचेगा|पहुंचेगा|आएगा|आएगी)|पोहोचायला.*?किती दिवस|कधी.*?(?:येईल|येणार|पोहोचेल)/u;
const lookupGoods = phrases(['package', 'shipment', 'delivery', 'सामान', 'माल', 'शिपमेंट', 'डिलीवरी', 'डिलिव्हरी']);
const readOnlyTail = /[,।.!;]\s*(?:कोई बदलाव मत कीजिए|कोई बदलाव मत करना|कोणताही बदल करू नका|do not change anything)[.।!]*$/u;
const lookupEdit = phrases(['change', 'update', 'edit', 'modify', 'set', 'replace', 'remove', 'cancel', 'add', 'increase', 'reduce',
  'बदल', 'बदलो', 'बदलाव', 'बदलना', 'बदला', 'हटा', 'हटाओ', 'काढा', 'रद्द', 'घटवा', 'वाढवा', 'टाका', 'जोडा', 'जोड़ो', 'जोड़िए', 'जोड़ें']);
const changes = phrases(['change', 'modify', 'update', 'set', 'make', 'reduce', 'increase', 'decrease', 'add', 'edit', 'instead',
  'keep', 'only need', 'only want', 'would like', 'rather have', 'बदल', 'बदलो', 'बदलना', 'बदलून', 'बदला', 'कर', 'करा', 'करू',
  'कीजिए', 'कीजिये', 'करना', 'कर दें', 'कर दीजिए', 'ठेवा', 'रख दो', 'करायचं', 'ऐवजी', 'एवजी', 'जगह', 'बजाय', 'वाढवा', 'घटवा', 'टाका', 'जोड़ो', 'बढ़ाओ', 'घटा दो']);
const removes = phrases(['cancel', 'remove', 'delete', 'drop', 'काढा', 'काढून', 'हटा', 'हटाओ', 'निकाल', 'निकालो', 'रद्द', 'कैंसल', 'कॅन्सल', 'कॅन्सल करा', 'कॅसल']);
const addBy = phrases(['add', 'increase by', 'more', 'और डालो', 'और जोड़ो', 'आणखी', 'अजून', 'ने वाढवा', 'और बढ़ाओ', 'जोड़ो', 'टाका']);
const increaseCue = phrases(['add', 'more', 'another', 'extra', 'अतिरिक्त', 'और डालो', 'और डालिए', 'और बढ़ाओ', 'और बढ़ा दीजिए',
  'जोड़ो', 'जोड़िए', 'जोड़ें', 'जोड़ दें', 'जोड़ दीजिए', 'जोड़ दीजिये', 'बढ़ाइए', 'इज़ाफ़ा',
  'आणखी', 'अजून', 'जादा', 'जास्त करा', 'वाढवा', 'जोडा', 'टाका']);
const increaseBy = /\b(?:increase|raise)\b.*\bby\b/u;
const increaseFollowUp = /^(?:add(?: more)?|more|another|extra|और जोड़िए|और जोड़ो|और बढ़ाओ|अतिरिक्त|आणखी(?: वाढवा)?|अजून(?: वाढवा)?|जादा)\s*[.!?।]*$/u;
const totalCue = phrases(['set', 'total', 'instead', 'कुल', 'की जगह', 'के बदले', 'तक', 'एकूण', 'ऐवजी', 'एवजी', 'वरून', 'पर्यंत']);
const rangeCue = phrases(['at least', 'at most', 'more than', 'less than', 'up to', 'कम से कम', 'ज़्यादा से ज़्यादा', 'किमान', 'जास्तीत जास्त', 'पेक्षा']);
const subtractBy = phrases(['reduce by', 'decrease by', 'less', 'fewer', 'कमी', 'कम', 'घटाकर', 'ने घटवा', 'ने कमी करा']);
const finalQuantity = phrases(['to', 'instead', 'ऐवजी', 'एवजी', 'जगह', 'बजाय', 'वरून', 'कर दो', 'कर दीजिए', 'करा', 'ठेवा']);
const alternate = phrases(['or', 'either', 'या', 'किंवा', 'नाहीतर', 'अथवा', 'नही तो']);
const negative = phrases(['not', 'no', 'नाही', 'नहीं', 'नही', 'नको', 'मत']);
const correction = phrases(['instead', 'rather', 'actually', 'sorry', 'i mean', 'ऐवजी', 'एवजी', 'वरून', 'बजाय', 'की जगह', 'के बदले', 'की बजाय', 'मतलब', 'म्हणजे']);
const fromTo = /\bfrom\b.*\bto\b/u;
const largeAmount = phrases(['hundred', 'thousand', 'million', 'lakh', 'crore', 'हजार', 'हज़ार', 'लाख', 'करोड़', 'कोटी']);
const doNotChange = /^(?:please )?(?:don['’]t|do not|नको|मत)\s|(?:काढू नका|रद्द करू नका|बदलू नका|करू नका|मत करो|मत करना|मत हटाओ|मत हटाना|मत निकालो)(?:\s|$)/u;
const wholeOrderCancel = /\b(?:cancel|delete)\s+(?:the\s+|my\s+|this\s+|whole\s+|entire\s+)*order\b|(?:ऑर्डर\s*(?:को\s*)?|सगळं\s+|सब\s+)(?:रद्द|कैंसल|कॅन्सल|काढा)/u;
const addStart = /^(?:please\s+)?add\s+/u;
const addEnd = /\s+(?:जोड़ दो|जोड़ दीजिए|जोड़ें|जोड़ो|डाल दो|डाल दीजिए|डालो|जोडा|टाका|घाला|समाविष्ट करा)$/u;
const unitMentions = Object.entries(unitWords).map(([unit, words]) => [unit, phrases(words)]);
const itemUnits = new Map(unitMentions.map(([unit, pattern]) => [unit, new RegExp(`^${pattern.source}(?=\\s|$)`, 'u')]));
const joinedUnit = new RegExp(`(?<=\\d)(?=(?:${Object.values(unitWords).flat().map(escapeRegex).join('|')})(?![\\p{L}\\p{M}\\p{N}]))`, 'gu');
const romanWords = {
  'ke badle': 'की जगह', 'kar do': 'कर दो', 'kam karo': 'कम करो',
  aivaji: 'ऐवजी', aivji: 'ऐवजी', kara: 'करा', badla: 'बदला', ghatva: 'घटवा',
  vaadhva: 'वाढवा', kadha: 'काढा',
};
const romanCommands = new RegExp(boundary(Object.keys(romanWords).join('|')), 'gu');
const quantitySpacing = text => text.replace(joinedUnit, ' ').replace(/\s*(?:→|⇒|->)\s*/gu, ' to ');

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

function answerKey(text) {
  return text.replace(/[,.!।;]+/gu, ' ').replace(/\s+/gu, ' ').trim();
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

function numericAnswer(text) {
  return text.replace(numberRegex, (word, index) => {
    if (!isQuantityWord(text, word, index)) return word;
    return numberWords.get(word.replaceAll('-', ' ')) ?? word;
  });
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
  if (/\bto\s*$/u.test(before) && /^\s*to\s*$/u.test(between)) return { ambiguous: true };
  if (/\b(?:instead of|rather than)\s*$/u.test(before)) return { value: values[1] };
  if (/\b(?:instead of|rather than|not)\b/u.test(between) || negative.test(after)) return { value: values[0] };
  if (correction.test(between) || /(?:ऐवजी|एवजी|वरून|\bto\b)/u.test(between) || fromTo.test(text) || negative.test(before) || negative.test(between)) {
    return { value: values[1] };
  }
  if (values[0] === values[1]) return { value: values[0] };
  return { ambiguous: true };
}

function languageInfo(item) {
  const name = normalize(item.name.replace(packSize, ''));
  return Object.values(productLanguage).find((product) => product.aliases.includes(name));
}

function itemNames(item) {
  const shortName = item.name.replace(packSize, '');
  return [item.name, shortName, item.sku, item.nameHi, item.nameMr, ...(item.aliases ?? []), ...(languageInfo(item)?.aliases ?? [])];
}

export function transcriptionKeyterms(items, language) {
  const active = items.filter(item => item.quantity > 0 || fulfillmentStage(item) === 'shipped');
  const locale = localeKeys[language];
  const primary = active.map(item => productName(item, locale));
  const alternatives = active.flatMap(item => [item.name.replace(packSize, ''), productName(item, 'hi'), productName(item, 'mr'),
    ...(item.aliases ?? []), item.sku]);
  const terms = new Map();
  for (const value of [...primary, ...alternatives]) {
    if (typeof value !== 'string') continue;
    const term = value.normalize('NFC').replace(/\s+/gu, ' ').trim();
    if (!term || [...term].length > 64) continue;
    const canonical = term.toLowerCase();
    if (!terms.has(canonical)) terms.set(canonical, term);
    if (terms.size === 50) break;
  }
  return [...terms.values()];
}

export function interpretationItemNames(item, text) {
  const request = normalize(text);
  const names = itemNames(item).filter(name => typeof name === 'string' && request.includes(normalize(name)));
  return [...new Set([item.name, productName(item, 'hi'), productName(item, 'mr'), ...names])].slice(0, 8);
}

export function explicitReplacementQuantity(text, items) {
  if (!/(?:ऐवजी|एवजी|वरून|की जगह|के बदले|की बजाय|→|⇒|->|\b(?:instead of|rather than)\b)/u.test(text)) return;
  const remainder = quantitySpacing(itemMatcher(items).withoutItems(normalize(text)));
  if ([...remainder.matchAll(numberRegex)].length === 2) return extractQuantity(remainder).value;
}

function matchesItemName(item, name) {
  return itemNames(item).some(alias => alias && normalize(alias) === name);
}

function itemMatcher(items, matchPossessives = false) {
  const idsByAlias = new Map();
  for (const item of items) {
    const names = [item.id, ...itemNames(item)];
    for (const value of names) {
      if (typeof value !== 'string' || !value.trim()) continue;
      const alias = normalize(value);
      if (!idsByAlias.has(alias)) idsByAlias.set(alias, new Set());
      idsByAlias.get(alias).add(item.id);
    }
  }
  const aliases = [...idsByAlias.keys()].sort((a, b) => b.length - a.length);
  const aliasPattern = `(${aliases.map(escapeRegex).join('|')})`;
  const possessive = matchPossessives ? '(?:(?<=[\\p{Script=Devanagari}\\p{M}])ा?(?:च्या|चा|ची|चे|चं))?' : '';
  const match = aliases.length ? new RegExp(boundary(aliasPattern + possessive), 'gu') : null;
  return {
    ids(text) {
      if (!match) return [];
      return [...new Set([...text.matchAll(match)].flatMap(([, alias]) => [...idsByAlias.get(alias)]))];
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

function deliveryDate(value, locale) {
  const date = value && new Date(value);
  return date && Number.isFinite(date.valueOf())
    ? new Intl.DateTimeFormat({ en: 'en-IN', hi: 'hi-IN', mr: 'mr-IN' }[locale], {
      dateStyle: 'medium', timeZone: 'Asia/Kolkata',
    }).format(date)
    : null;
}

function deliveryDetail(item, locale) {
  const eta = deliveryDate(item.deliveryEta, locale);
  if (!eta) return '';
  return { en: `Estimated delivery: ${eta}`, hi: `डिलीवरी की अनुमानित तारीख ${eta} है`, mr: `अंदाजे वितरण ${eta} रोजी होईल` }[locale];
}

function describeOrder(items, locale) {
  const stages = {
    pending: { en: 'awaiting dispatch', hi: 'खेप अभी गोदाम में है', mr: 'माल अजून गोदामात आहे' },
    picked: { en: 'picked for packing', hi: 'सामान पैकिंग के लिए निकाल लिया गया है', mr: 'माल पॅकिंगसाठी गोदामातून काढला आहे' },
    packed: { en: 'packed and waiting for dispatch', hi: 'सामान पैक हो चुका है', mr: 'माल पॅक झाला आहे' },
    shipped: { en: 'already shipped', hi: 'खेप भेज दी गई है', mr: 'माल रवाना झाला आहे' },
  };
  return items.map((item) => {
    const name = productName(item, locale);
    const quantity = describeAmount(item, item.quantity, locale);
    const status = stages[fulfillmentStage(item)]?.[locale] ?? stages.pending[locale];
    const amount = { en: `${name}, ${quantity}, `, hi: `${name}, ${quantity}. `, mr: `${marathiItemAmount(item, item.quantity)}. ` }[locale];
    const backorder = item.backorderQuantity
      ? { en: `${describeAmount(item, item.backorderQuantity, locale)} on backorder`, hi: `${describeAmount(item, item.backorderQuantity, locale)} बाद में भेजे जाएँगे`, mr: `${describeAmount(item, item.backorderQuantity, locale)} नंतर पाठवले जातील` }[locale]
      : '';
    return [amount + status, backorder, deliveryDetail(item, locale)].filter(Boolean).join('. ');
  }).join('. ');
}

function availableStock(item) {
  return Number.isInteger(item.availableQuantity) && item.availableQuantity >= 0 ? item.availableQuantity : null;
}

function planQuantity(item, to, backorderQuantity = 0) {
  return {
    itemId: item.id, name: item.name, from: item.quantity, to,
    ...(backorderQuantity || item.backorderQuantity ? { backorderQuantity } : {}),
  };
}

function stockAlternatives(item, requested, items, now) {
  const available = availableStock(item);
  if (available === null || requested <= available) return null;
  const shortfall = requested - available;
  const partial = planQuantity(item, available);
  const options = {};
  if (available > 0) options.partial = { plan: partial };
  if (item.backorderAllowed) options.backorder = { plan: planQuantity(item, requested, shortfall), shortfall };
  const skuKey = value => value?.normalize('NFC').trim().toLowerCase();
  const sku = skuKey(item.substituteSku);
  const matches = sku ? items.filter(line => line.id !== item.id && skuKey(line.sku) === sku) : [];
  const [substitute] = matches;
  if (matches.length === 1 && !editLockReason(substitute, now) && !substitute.backorderQuantity &&
      stockUnitFamily(item.unit) === stockUnitFamily(substitute.unit) && availableStock(substitute) !== null) {
    const substituteTotal = substitute.quantity + shortfall;
    if (substituteTotal <= Math.min(availableStock(substitute), substitute.limit ?? maxQuantity, maxQuantity)) {
      options.substitute = {
        plan: { ...partial, updates: [partial, planQuantity(substitute, substituteTotal)] },
        substitute,
        shortfall,
      };
    }
  }
  return { available, options };
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
    stockOffer: null,
    blockedRequests: [],
    focus: null,
    history: structuredClone(history),
    messages: [{ role: 'agent', text: greetings[language], language }],
  };
}

export function snapshot({ order, pending, stockOffer = null, blockedRequests = [], history, messages }) {
  return structuredClone({ order, pending, stockOffer, blockedRequests, history, messages });
}

export function shouldInterpretTurn(session, { text, itemAction, stockAction }) {
  if (itemAction || stockAction) return false;
  const input = normalize(text);
  const key = answerKey(input);
  if (confirmation.has(key) || draftCancellation.has(key) || doNotChange.test(input) ||
      wholeOrderCancel.test(input) || orderReference(input, session.order.id).wrong) return false;
  if (!session.stockOffer) return true;
  return !stockChoice.has(key) && !session.stockOffer.options.some(option =>
    numericAnswer(answerKey(normalize(option.label))) === numericAnswer(key));
}

export function routeOrderLookup(order, text) {
  const reference = orderReference(normalize(text), order.id);
  const command = reference.rest.replace(readOnlyTail, '').trim();
  const matcher = itemMatcher(order.items, true);
  const ids = matcher.ids(command);
  const remainder = quantitySpacing(matcher.withoutItems(command));
  if (reference.wrong || ids.length > 1 || lookupEdit.test(remainder) || removes.test(remainder) ||
    subtractBy.test(remainder) ||
    [...remainder.matchAll(numberRegex)].some(match => isQuantityWord(remainder, match[0], match.index))) return null;

  const itemId = ids[0];
  const scoped = Boolean(itemId || orderScope.test(command) || reference.found);
  const deliveryScope = scoped || lookupGoods.test(command);
  const question = command.includes('?') || lookupQuestion.test(remainder);
  const stock = Boolean(itemId && question && (stockQuestion.test(remainder) || lookupStock.test(remainder)));
  const delivery = deliveryTopics.test(remainder) || deliveryScope && (lookupDelivery.test(remainder) || lookupEtaQuestion.test(remainder)) ||
    /^(?:when will it arrive|when will it be delivered)[.!?]*$/u.test(command);
  const status = quickStatus.test(command) || scoped && question && (lookupShipment.test(remainder) || shippingStatus.test(remainder));
  if (Number(stock) + Number(delivery) + Number(status) !== 1) return null;
  return { type: stock ? 'stock' : delivery ? 'delivery' : 'status', itemId };
}

export function routeQuantityChange(order, text) {
  const matcher = itemMatcher(order.items, true);
  const command = normalize(text).replace(/[.!।]+$/u, '').trim();
  const [itemId, secondItem] = matcher.ids(command);
  if (!itemId || secondItem) return null;
  const item = order.items.find(row => row.id === itemId);
  const unit = unitFamily(normalize(item.unit));
  const unitPattern = unitMentions.find(([family]) => family === unit)?.[1];
  if (!unitPattern) return null;
  const remainder = quantitySpacing(matcher.withoutItems(command));
  const signature = remainder
    .replace(numberRegex, (number, index) => isQuantityWord(remainder, number, index) ? '#' : number)
    .replace(unitPattern, '@').replace(/\s+/gu, ' ').trim();
  if (!/^(?:(?:please )?(?:set|change) to # @|(?:please )?make (?:it )?# @(?: of)?|(?:की |को )?# @ (?:कर दो|कर दीजिए|कर दीजिये|करें)|# @ (?:करा|ठेवा))$/u.test(signature)) return null;
  const { value: quantity } = extractQuantity(remainder);
  return Number.isSafeInteger(quantity) && quantity >= 0 ? { type: 'set', itemId, quantity, unit } : null;
}

export function handleTurn(session, { text = '', language, itemAction, stockAction, interpretation, now = Date.now() } = {}) {
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
  const rememberBlock = (item, reason, detail) => {
    const entry = { itemId: item.id, name: item.name, reason, ...detail };
    session.blockedRequests = [
      ...(session.blockedRequests ?? []).filter(previous => previous.itemId !== item.id || previous.reason !== reason),
      entry,
    ].slice(-20);
  };
  const blocked = (item) => {
    const name = productName(item, key);
    const reason = editLockReason(item, now);
    rememberBlock(item, reason);
    if (reason === 'packed') {
      return t(`${name} is already packed. I can’t change or remove it.`, `${name} पैक हो चुका है। इसमें बदलाव नहीं हो सकता और इसे हटा भी नहीं सकते।`, `${name} असलेली खेप पॅक झाली आहे. आता ती वस्तू बदलता किंवा काढता येणार नाही.`);
    }
    if (reason === 'cutoff') {
      return t(`The edit cutoff for ${name} has passed. I can’t change or remove it.`, `${name} में बदलाव करने की समय-सीमा बीत गई है। अब इसे बदल या हटा नहीं सकते।`, `${name} बदलण्याची मुदत संपली आहे. आता ती वस्तू बदलता किंवा काढता येणार नाही.`);
    }
    return t(`${name} has already shipped, so I can’t change it or remove it from the order.`, `${name} की खेप पहले ही भेज दी गई है। अब बदलाव नहीं हो सकता और इसे ऑर्डर से हटाया भी नहीं जा सकता।`, `${name} असलेली खेप आधीच रवाना झाली आहे. आता बदल करता येणार नाही आणि ती वस्तू ऑर्डरमधून काढताही येणार नाही.`);
  };
  const clearDraft = () => { session.pending = null; session.focus = null; session.stockOffer = null; };
  const describeLine = (item, quantity) => `${productName(item, key)} — ${describeAmount(item, quantity, key)}`;
  const askStockChoice = () => rejectChange(t(
    'Choose a stock option first. I’ll read it back before you confirm.',
    'पहले स्टॉक का एक विकल्प चुनिए। पुष्टि से पहले मैं उसे दोहराऊँगा।',
    'आधी उपलब्ध मालाचा पर्याय निवडा. पुष्टी घेण्यापूर्वी मी तो पुन्हा सांगेन.',
  ));
  const offerStock = (item, requested, offer, prefix = '') => {
    clearDraft();
    const { available, options } = offer;
    const name = productName(item, key);
    const amount = describeAmount(item, available, key);
    rememberBlock(item, 'stock', { requested, available });
    session.focus = item.id;
    const labels = {
      partial: t(`Take ${amount} in stock`, `उपलब्ध ${amount} लें`, `उपलब्ध ${amount} घ्या`),
      backorder: t('Backorder the rest', 'बाकी माल बाद में भेजें', 'उरलेला माल नंतर पाठवा'),
      substitute: options.substitute && t(
        `Use ${describeLine(options.substitute.substitute, options.substitute.shortfall)} for the rest`,
        `बाकी के लिए ${describeLine(options.substitute.substitute, options.substitute.shortfall)} लें`,
        `उरलेल्या प्रमाणासाठी ${describeLine(options.substitute.substitute, options.substitute.shortfall)} घ्या`,
      ),
    };
    const offeredOptions = Object.keys(options).map(type => ({ type, label: labels[type] }));
    if (offeredOptions.length) {
      session.stockOffer = { itemId: item.id, name, unit: item.unit, requested, available, options: offeredOptions };
    }
    const shortage = t(`I only have ${amount} of ${name} available.`, `${name} की केवल ${amount} उपलब्ध हैं।`, `${name} — सध्या फक्त ${amount} उपलब्ध आहेत.`);
    const next = offeredOptions.length
      ? offeredOptions.map(option => option.label).join('. ') + t('. Which option would you like?', '। कौन सा विकल्प ठीक है?', '. कोणता पर्याय घ्यायचा?')
      : t('I can help with another item.', 'किसी और सामान में मदद चाहिए?', 'दुसऱ्या वस्तूबद्दल मदत हवी आहे का?');
    return rejectChange([prefix, shortage, next].filter(Boolean).join(' '));
  };
  const selectStock = (type) => {
    const item = getItem(session.stockOffer?.itemId);
    if (!item) return rejectChange(t('There is no stock option waiting to be selected.', 'अभी स्टॉक का कोई विकल्प चुनने के लिए बाकी नहीं है।', 'सध्या उपलब्ध मालाचा कोणताही पर्याय निवडण्यासाठी बाकी नाही.'));
    if (editLockReason(item, now)) {
      clearDraft();
      return rejectChange(blocked(item));
    }
    const offer = stockAlternatives(item, session.stockOffer.requested, orderItems, now);
    const option = offer?.options[type];
    if (!option || !Object.hasOwn(offer.options, type)) return askStockChoice();
    const { plan, shortfall, substitute } = option;
    clearDraft();
    if (!substitute && plan.from === plan.to && (item.backorderQuantity ?? 0) === (plan.backorderQuantity ?? 0)) {
      return speak(t(`The order already has ${describeLine(item, plan.to)}.`, `ऑर्डर में ${describeLine(item, plan.to)} पहले से हैं।`, `ऑर्डरमध्ये ${describeLine(item, plan.to)} आधीपासूनच आहेत.`));
    }
    session.pending = plan;
    const details = substitute
      ? t(`Set ${describeLine(item, plan.to)} and add ${describeLine(substitute, shortfall)}.`, `${describeLine(item, plan.to)} रखें और ${describeLine(substitute, shortfall)} जोड़ें।`, `${describeLine(item, plan.to)} ठेवा आणि ${describeLine(substitute, shortfall)} जोडा.`)
      : type === 'backorder'
        ? t(`Set ${describeLine(item, plan.to)} in total, with ${describeAmount(item, shortfall, key)} on backorder.`, `${describeLine(item, plan.to)} कुल रखें। इनमें से ${describeAmount(item, shortfall, key)} बाद में भेजे जाएँगे।`, `${describeLine(item, plan.to)} एकूण ठेवा. त्यापैकी ${describeAmount(item, shortfall, key)} नंतर पाठवले जातील.`)
        : t(`Set ${describeLine(item, plan.to)}.`, `${describeLine(item, plan.to)} रखें।`, `${describeLine(item, plan.to)} ठेवा.`);
    return speak(details + t(' Shall I save this change?', ' यह बदलाव कर दूँ?', ' हा बदल जतन करू का?'));
  };
  function proposeAddition(action) {
    clearDraft();
    const name = typeof action.name === 'string' ? action.name.trim().normalize('NFC') : '';
    const quantity = action.quantity;
    const unit = action.unit;
    if (!name || name.length > 180 || !/\p{L}/u.test(name) || /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(name) || !itemUnits.has(unit)) {
      return rejectChange(t('Tell me the item name and its unit, such as bags or bottles.', 'सामान का नाम और उसकी इकाई बताइए, जैसे बोरी या बोतल।', 'वस्तूचं नाव आणि एकक सांगा, उदा. पिशव्या किंवा बाटल्या.'));
    }
    const normalizedName = normalize(name);
    const matches = orderItems.filter(item => matchesItemName(item, normalizedName));
    if (matches.length > 1) {
      return speak(t('Which pack size or SKU do you mean?', 'आप किस पैक साइज़ या SKU की बात कर रहे हैं?', 'कोणता पॅक आकार किंवा SKU हवा आहे?'));
    }
    const [existing] = matches;
    if (existing && editLockReason(existing, now)) return rejectChange(blocked(existing));
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
    const offer = stockAlternatives(item, quantity, orderItems, now);
    if (offer) return offerStock(item, quantity, offer);
    session.pending = { ...planQuantity(item, quantity), ...(existing ? {} : { newItem: item }) };
    const amount = describeAmount(item, quantity, key);
    const detail = t(`${amount} of ${item.name}`, hindiItemAmount(item, quantity), marathiItemAmount(item, quantity));
    const options = spokenWording.proposeAddition[key];
    return speak(options[0].replace('{amount}', () => detail), { options, amount: detail });
  }
  if (itemAction?.type === 'add') return proposeAddition(itemAction);
  if (itemAction?.type === 'remove') {
    clearDraft();
    const item = orderItems.find(line => line.id === itemAction.itemId);
    if (!item) return speak(t('That item is no longer on the order.', 'यह सामान अब ऑर्डर में नहीं है।', 'ही वस्तू आता ऑर्डरमध्ये नाही.'));
    if (editLockReason(item, now)) return rejectChange(blocked(item));
    if (!item.quantity) return speak(t('That item is no longer on the order.', 'यह सामान अब ऑर्डर में नहीं है।', 'ही वस्तू आता ऑर्डरमध्ये नाही.'));
    const name = productName(item, key);
    session.pending = planQuantity(item, 0);
    return speak(t(`Shall I remove ${name} from the order?`, `क्या मैं ${name} ऑर्डर से हटा दूँ?`, `ऑर्डरमधून ${name} काढू का?`), { options: spokenWording.proposeRemoval[key], amount: name });
  }
  const normalizedAnswer = answerKey(input);
  if (stockAction) return selectStock(stockAction.type);
  const spokenOption = session.stockOffer?.options.find(option => numericAnswer(answerKey(normalize(option.label))) === numericAnswer(normalizedAnswer));
  const chosen = spokenOption?.type ?? stockChoice.get(normalizedAnswer);
  if (chosen && session.stockOffer) return selectStock(chosen);
  if (session.stockOffer?.options.some(option => option.type === 'substitute')) {
    const namedChoice = /^(?:use|take|choose) (?:the )?(.+?)(?: for the rest| instead)?$/u.exec(normalizedAnswer)?.[1]
      ?? /^(?:बाकी के लिए )?(.+?) (?:लें|ले लो|रखो)$/u.exec(normalizedAnswer)?.[1]
      ?? /^(?:उरलेल्या प्रमाणासाठी )?(.+?) (?:घ्या|ठेवा)$/u.exec(normalizedAnswer)?.[1];
    if (namedChoice) {
      const item = getItem(session.stockOffer.itemId);
      const substitute = item && stockAlternatives(item, session.stockOffer.requested, orderItems, now)?.options.substitute?.substitute;
      if (substitute && matchesItemName(substitute, namedChoice)) return selectStock('substitute');
    }
  }

  if (draftCancellation.has(normalizedAnswer)) {
    if (!session.pending && !session.focus && !session.stockOffer) return noChange();
    clearDraft();
    return speak(t('Okay, I’ve left the order as it was.', 'ठीक है, ऑर्डर वैसा ही रहेगा।', 'ठीक आहे, ऑर्डर जशी होती तशीच ठेवली आहे.'));
  }
  if (confirmation.has(normalizedAnswer)) {
    const pending = session.pending;
    if (!pending) return session.stockOffer ? askStockChoice() : noChange();
    const item = getItem(pending.itemId);
    const updates = pending.updates ?? [pending];
    const lines = updates.map(update => getItem(update.itemId));
    clearDraft();
    if (lines.some((line, index) => !line || line.quantity !== updates[index].from)) {
      return speak(t('The order changed while we were talking. Let’s check it again.', 'बात करते समय ऑर्डर बदल गया। चलिए फिर से देखते हैं।', 'आपण बोलत असताना ऑर्डर बदलली. पुन्हा तपासूया.'));
    }
    const lockedItem = lines.find(line => editLockReason(line, now));
    if (lockedItem) return rejectChange(blocked(lockedItem));
    const shortageIndex = lines.findIndex((line, index) => {
      const { to, backorderQuantity = 0 } = updates[index];
      const available = availableStock(line);
      return (backorderQuantity > 0 && !line.backorderAllowed) || (available !== null && to - backorderQuantity > available);
    });
    if (shortageIndex >= 0) {
      const line = lines[shortageIndex];
      const available = availableStock(line);
      rememberBlock(line, 'stock', { requested: updates[shortageIndex].to, ...(available === null ? {} : { available }) });
      return rejectChange(t('Stock changed before confirmation. Please ask for the change again.', 'पुष्टि से पहले स्टॉक बदल गया। कृपया बदलाव फिर से बताइए।', 'पुष्टीपूर्वी उपलब्ध माल बदलला. कृपया बदल पुन्हा सांगा.'));
    }
    if (pending.newItem) orderItems.push(item);
    const at = new Date(now).toISOString();
    const entries = [];
    for (const [index, update] of updates.entries()) {
      const line = lines[index];
      const changed = line.quantity !== update.to || (line.backorderQuantity ?? 0) !== (update.backorderQuantity ?? 0);
      line.quantity = update.to;
      if (update.backorderQuantity !== undefined) line.backorderQuantity = update.backorderQuantity;
      if (changed) {
        const { itemId, name, from, to, backorderQuantity } = update;
        entries.push({ itemId, name, from, to, ...(backorderQuantity === undefined ? {} : { backorderQuantity }), at });
      }
    }
    session.history.unshift(...entries);
    if (pending.updates) {
      const amounts = lines.map(line => describeLine(line, line.quantity)).join(', ');
      return speak(t(`Saved. The order now has ${amounts}.`, `बदलाव हो गया। अब ऑर्डर में ${amounts} हैं।`, `बदल झाला. आता ऑर्डरमध्ये ${amounts} आहेत.`), undefined, pending);
    }
    if (pending.backorderQuantity) {
      const total = describeLine(item, item.quantity);
      const later = describeAmount(item, pending.backorderQuantity, key);
      return speak(t(`Saved. ${total} in total, with ${later} on backorder.`, `बदलाव हो गया। ${total} में से ${later} बाद में भेजे जाएँगे।`, `बदल झाला. ${total} यापैकी ${later} नंतर पाठवले जातील.`), undefined, pending);
    }
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
  // Speech transcripts can omit the space between an English name and a Marathi replacement word.
  const command = reference.rest.replace(/(?<=[\p{Script=Latin}\p{N}])(?:ऐवजी|एवजी|वरून)(?![\p{L}\p{M}])/gu, ' $&')
    .replace(/(?:ऐवजी|एवजी|वरून)(?=\d)/gu, '$& ')
    .replace(romanCommands, word => romanWords[word]);
  const mentionedIds = mentionIds(command);
  const itemIds = interpretation ? [interpretation.itemId].filter(Boolean) : mentionedIds;
  const contextItem = session.pending?.itemId ?? session.stockOffer?.itemId ?? session.focus;
  const modelEdit = interpretation && ['set', 'increase', 'decrease', 'remove'].includes(interpretation.type);
  const isDeliveryRead = (text, ids) => deliveryTopics.test(text) || deliveryQuestions.test(text) &&
    (ids.length > 0 || orderScope.test(text) || /^(?:when will it arrive|when will it be delivered|कधी येईल|कधी पोहोचेल|कब आएगा|कब आएगी|कब पहुँचेगा|कब पहुँचेगी)[.!?।]*$/u.test(text));
  const isStockRead = (text, ids) => ids.length > 0 && stockQuestion.test(text);
  const isOrderRead = (text, ids) => quickStatus.test(text) || isDeliveryRead(text, ids) ||
    isStockRead(text, ids) ||
    (orderScope.test(text) && (reads.test(text) || shippingStatus.test(text))) ||
    (ids.length > 0 && (shippingStatus.test(text) || itemStatus.test(text)));
  const isGeneralQuestion = (text, ids) => generalQuestion.test(text) && !isOrderRead(text, ids) &&
    !orderScope.test(text) && !editScope.test(text);
  if (wholeOrderCancel.test(input)) {
    clearDraft();
    return rejectChange(t('I can remove an item that hasn’t shipped. A full order cancellation needs the dispatch team.', 'जो सामान भेजा नहीं गया है, उसे हटा सकता हूँ। पूरा ऑर्डर रद्द करने के लिए डिस्पैच टीम से बात करनी होगी।', 'अजून न पाठवलेली वस्तू काढता येईल. पूर्ण ऑर्डर रद्द करण्यासाठी डिस्पॅच टीमशी बोलावं लागेल.'));
  }

  // Check clear relative increases independently of the model before accepting an edit proposal.
  let checkedIncrease = false;
  const modelAddsExistingItem = interpretation?.type === 'add' &&
    (!interpretation.name || knownItems.some(item => matchesItemName(item, normalize(interpretation.name))));
  if ((modelEdit || modelAddsExistingItem) && mentionedIds.length <= 1 &&
    !doNotChange.test(command) && !negative.test(command) && !totalCue.test(command) &&
    !subtractBy.test(command) && !removes.test(command) && !rangeCue.test(command) && !alternate.test(command) &&
    !/\b(?:increase|raise)\b.*\bto\b/u.test(command)) {
    const remainder = quantitySpacing(matcher.withoutItems(command));
    const numbers = [...remainder.matchAll(numberRegex)].filter(match => isQuantityWord(remainder, match[0], match.index));
    if (numbers.length === 1 && (increaseCue.test(remainder) || increaseBy.test(remainder))) {
      const { value: delta } = extractQuantity(remainder);
      const [number] = numbers;
      const withoutAmount = remainder.slice(0, number.index) + ' ' + remainder.slice(number.index + number[0].length);
      const followUp = !mentionedIds.length && contextItem && increaseFollowUp.test(normalize(
        unitMentions.reduce((text, [, pattern]) => text.replace(pattern, ' '), withoutAmount),
      ));
      const itemId = followUp ? contextItem : mentionedIds[0];
      const item = orderItems.find(candidate => candidate.id === itemId);
      if (item && Number.isFinite(delta) && delta > 0) {
        if (editLockReason(item, now)) {
          clearDraft();
          return rejectChange(blocked(item));
        }
        if (interpretation.type !== 'increase' || interpretation.itemId !== item.id || interpretation.quantity !== delta) {
          clearDraft();
          session.focus = item.id;
          const name = productName(item, key);
          const spokenDelta = quantities[key][delta] ?? delta;
          return rejectChange(t(
            `For ${name}, should I add ${spokenDelta} to the current quantity, or make ${spokenDelta} the total?`,
            `${name} की मौजूदा मात्रा में ${spokenDelta} और जोड़ूँ, या कुल ${spokenDelta} रखूँ?`,
            `${name} — सध्याच्या प्रमाणात आणखी ${spokenDelta} वाढवू, की एकूण ${spokenDelta} ठेवू?`,
          ));
        }
        checkedIncrease = true;
      }
    }
  }

  if (interpretation?.type === 'add') return proposeAddition({ ...interpretation, unit: stockUnitFamily(interpretation.unit) });
  const addition = !interpretation && !doNotChange.test(command) ? spokenAddition(command) : null;
  if (addition && !knownItems.some(item => matchesItemName(item, normalize(addition.name)))) return proposeAddition(addition);
  const isRead = interpretation ? ['status', 'delivery', 'stock'].includes(interpretation.type) : isOrderRead(command, itemIds);
  const clauses = interpretation ? (modelEdit ? [command] : []) : clausesFor(command, mentionIds);
  const plans = [];
  const unavailable = new Set();
  const unclear = new Set();
  const invalid = new Map();
  let readItems = [];
  let pairedScope = false;
  for (const clause of clauses) {
    const ids = modelEdit ? itemIds : mentionIds(clause);
    const remainder = modelEdit ? '' : quantitySpacing(matcher.withoutItems(clause));
    const quantity = modelEdit ? { value: interpretation.quantity ?? undefined } : extractQuantity(remainder);
    const hasQuantity = quantity.ambiguous || quantity.value !== undefined;
    const declinesItem = ids.length > 0 && !hasQuantity && /(?:नको|नहीं चाहिए|नही चाहिए)$/u.test(clause);
    const hasAction = modelEdit || changes.test(clause) || removes.test(clause) || addBy.test(clause) || subtractBy.test(clause) ||
      declinesItem || hasQuantity && /(?:→|⇒|->)/u.test(clause);
    const wantsRead = isOrderRead(clause, ids) && !hasAction;
    if (wantsRead) {
      readItems.push(...ids);
      continue;
    }
    if (doNotChange.test(clause)) continue;
    if (!modelEdit && isGeneralQuestion(clause, ids)) continue;
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
    if (editLockReason(item, now)) { unavailable.add(item); continue; }
    if (quantity.ambiguous) { unclear.add(item); continue; }
    const removalIntent = modelEdit ? interpretation.type === 'remove' : removes.test(clause) || declinesItem;
    const removing = removalIntent && !hasQuantity;
    let target = removing ? 0 : quantity.value;
    if (target === undefined) { unclear.add(item); continue; }

    const englishDelta = /\b(reduce|decrease|increase)\b.*\bby\b/u.exec(clause)?.[1];
    const delta = !modelEdit && (englishDelta
      || (subtractBy.test(clause) && !correction.test(clause) && !/\bto\b|वर|तक/u.test(clause))
      || (addBy.test(clause) && !correction.test(clause) && !/\bto\b|वर|तक/u.test(clause)));
    if (modelEdit && target >= 0 && interpretation.type === 'increase') target = item.quantity + target;
    else if (modelEdit && target >= 0 && interpretation.type === 'decrease') target = item.quantity - target;
    else if (removalIntent && hasQuantity && (modelEdit || !finalQuantity.test(clause)) && target >= 0) target = item.quantity - target;
    else if (delta && target >= 0) target = item.quantity + (subtractBy.test(clause) || englishDelta === 'reduce' || englishDelta === 'decrease' ? -target : target);
    const unit = unitFamily(normalize(item.unit));
    const incompatibleUnit = modelEdit ? interpretation.unit && stockUnitFamily(interpretation.unit) !== unit
      : unitMentions.some(([family, pattern]) => family !== unit && pattern.test(remainder));
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
    plans.push({ ...planQuantity(item, target), ...(item === draftItem ? { newItem: item } : {}) });
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
    const offer = stockAlternatives(item, proposal.to, orderItems, now);
    if (offer) return offerStock(item, proposal.to, offer, blockedText);
    clearDraft();
    const name = productName(item, key);
    const amount = describeAmount(item, proposal.to, key);
    let response;
    let choices;
    if (proposal.from === proposal.to && (item.backorderQuantity ?? 0) === (proposal.backorderQuantity ?? 0)) {
      session.pending = null;
      response = t(`The order already has ${amount} of ${name}.`, `ऑर्डर में ${hindiItemAmount(item, proposal.to)} पहले से हैं।`, `ऑर्डरमध्ये ${marathiItemAmount(item, proposal.to)} आधीपासूनच आहेत.`);
    } else if (proposal.from === proposal.to) {
      session.pending = proposal;
      response = t(`There’s now enough stock for all ${amount} of ${name}. Shall I allocate the backordered stock?`,
        `${name} की पूरी मात्रा अब स्टॉक में है। क्या बाकी मात्रा भी इस ऑर्डर के लिए रख दूँ?`,
        `${name}चं पूर्ण प्रमाण आता उपलब्ध आहे. बाकीचा मालही या ऑर्डरसाठी राखून ठेवू का?`);
    } else if (checkedIncrease) {
      session.pending = proposal;
      const previous = describeAmount(item, proposal.from, key);
      response = t(`That would bring ${name} from ${previous} to ${amount}. Shall I update it?`,
        `${name} की मात्रा ${previous} से बढ़कर ${amount} हो जाएगी। यह बदलाव कर दूँ?`,
        `${name} — सध्या ${previous} आहेत. वाढवल्यावर ${amount} होतील. हा बदल करू का?`);
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
      .filter(item => item.quantity > 0 || fulfillmentStage(item) === 'shipped');
    const pendingReminder = session.pending ? t(' Your proposed change is still waiting for confirmation.', ' आपका बदलाव अभी पुष्टि के लिए बाकी है।', ' तुम्ही सांगितलेल्या बदलाला अजून पुष्टी हवी आहे.') : '';
    let details;
    if (interpretation ? interpretation.type === 'delivery' : isDeliveryRead(command, itemIds)) {
      details = items.map(item => {
        const name = productName(item, key);
        const estimate = deliveryDetail(item, key) || t('I don’t have an estimated delivery date yet', 'अभी डिलीवरी की अनुमानित तारीख उपलब्ध नहीं है', 'अंदाजे वितरण तारीख अजून उपलब्ध नाही');
        return `${name} — ${estimate}.`;
      }).join(' ') || t('I don’t have an estimated delivery date yet.', 'अभी डिलीवरी की अनुमानित तारीख उपलब्ध नहीं है।', 'अंदाजे वितरण तारीख अजून उपलब्ध नाही.');
    } else if (interpretation ? interpretation.type === 'stock' : isStockRead(command, itemIds)) {
      details = itemIds.map(getItem).map(item => {
        const name = productName(item, key);
        const available = availableStock(item);
        if (available === null) return t(`I don’t have a stock figure for ${name}.`, `${name} का उपलब्ध स्टॉक दर्ज नहीं है।`, `${name}साठी उपलब्ध प्रमाण नोंदलेलं नाही.`);
        const amount = describeAmount(item, available, key);
        return t(`${name} — I can fulfill up to ${amount} for this order.`, `${name} — इस ऑर्डर के लिए ${amount} तक उपलब्ध हैं।`, `${name} — या ऑर्डरसाठी जास्तीत जास्त ${amount} उपलब्ध आहेत.`);
      }).join(' ');
    } else {
      details = items.length ? describeOrder(items, key) + '.' : t('There are no active items here.', 'यहाँ कोई सक्रिय सामान नहीं है।', 'इथे सध्या कोणतीही वस्तू नाही.');
    }
    return speak(details + pendingReminder);
  }
  if (doNotChange.test(command)) {
    clearDraft();
    return speak(t('Okay, I’ve left the order as it was.', 'ठीक है, ऑर्डर वैसा ही रहेगा।', 'ठीक आहे, ऑर्डर जशी होती तशीच ठेवली आहे.'));
  }

  const quantityRemainder = command.replace(numberRegex, ' ').replace(/\s+/gu, ' ').trim();
  const bareQuantity = quantityRemainder !== command && /^(?:(?:फक्त|सिर्फ)\s+)?(?:करा|कर दो|कर दीजिए)?[.!।]?$/u.test(quantityRemainder);
  const orderRequest = interpretation ? interpretation.type !== 'out_of_scope' : orderScope.test(command) || editScope.test(command) || bareQuantity ||
    (changes.test(command) && (itemIds.length > 0 || unitMentions.some(([, pattern]) => pattern.test(command))));
  if (!orderRequest || !interpretation && isGeneralQuestion(command, itemIds)) {
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
