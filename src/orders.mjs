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
const numberRegex = new RegExp(boundary(`[+-]?\\d+(?:,\\d{3})+(?:\\.\\d+)?|[+-]?\\d+(?:\\.\\d+)?|${numberPattern}`), 'gu');

const reads = phrases(['status', 'track', 'show', 'list', 'where is', 'where are', 'what is', 'how many', 'has shipped', 'already shipped', 'कितना', 'कितनी', 'कितने', 'कहाँ', 'कहां', 'स्टेटस', 'स्थिति', 'दिखाओ', 'पहुंचा', 'किती', 'कुठे', 'काय आहे', 'दाखवा', 'आली का', 'आले का', 'आला का', 'निघाली का', 'निघाले का', 'पाठवला का', 'तपासा', 'चेक करो', 'पाठवलं आहे', 'भेजा गया है', 'जानकारी', 'माहिती']);
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
const weights = phrases(['kg', 'kilo', 'kilos', 'kilogram', 'kilograms', 'litre', 'litres', 'liter', 'liters', 'किलो', 'किलोग्राम', 'लिटर', 'लीटर']);
const bags = phrases(['bag', 'bags', 'sack', 'sacks', 'पिशवी', 'पिशव्या', 'बोरी', 'बोरियाँ']);
const cases = phrases(['case', 'cases', 'box', 'boxes', 'खोका', 'खोके', 'बॉक्स', 'केस', 'डिब्बा', 'डिब्बे']);
const doNotChange = /^(?:please )?(?:don['’]t|do not|नको|मत)\s|(?:काढू नका|रद्द करू नका|बदलू नका|करू नका|मत करो|मत करना|मत हटाओ|मत हटाना|मत निकालो)(?:\s|$)/u;
const wholeOrderCancel = /\b(?:cancel|delete)\s+(?:the\s+|my\s+|this\s+|whole\s+|entire\s+)*order\b|(?:ऑर्डर\s*(?:को\s*)?|सगळं\s+|सब\s+)(?:रद्द|कैंसल|कॅन्सल|काढा)/u;

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
  const values = matches.map((match) => numberWords.get(match[0].replaceAll('-', ' ')) ?? Number(match[0].replaceAll(',', '')));
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
  if (bags.test(unit)) return 'bags';
  if (cases.test(unit)) return 'cases';
  if (/^(?:kg|kilos?|kilograms?|किलो|किलोग्राम)$/u.test(unit)) return 'kg';
  if (/^(?:l|litres?|liters?|लिटर|लीटर)$/u.test(unit)) return 'litre';
  return unit;
}

function describeAmount(item, quantity, locale) {
  if (locale === 'en') return `${quantities.en[quantity] ?? quantity} ${item.unit}`;
  const number = quantities[locale][quantity] ?? quantity;
  const unit = {
    bags: { hi: ['बोरी', 'बोरियाँ'], mr: ['पिशवी', 'पिशव्या'] },
    cases: { hi: ['डिब्बा', 'डिब्बे'], mr: ['खोका', 'खोके'] },
    kg: { hi: ['किलो', 'किलो'], mr: ['किलो', 'किलो'] },
    litre: { hi: ['लीटर', 'लीटर'], mr: ['लिटर', 'लिटर'] },
  }[unitFamily(normalize(item.unit))]?.[locale]?.[quantity === 1 ? 0 : 1] ?? item.unit;
  return `${number} ${unit}`;
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

export function handleTurn(session, { text = '', language } = {}) {
  const input = typeof text === 'string' ? normalize(text) : '';
  const locale = localeFor(input, language, session.messages.at(-1)?.language);
  const key = localeKeys[locale];
  const t = (en, hi, mr) => ({ en, hi, mr }[key]);
  const speak = (reply) => {
    session.messages.push({ role: 'agent', text: reply, language: locale });
    if (session.messages.length > 81) session.messages.splice(0, session.messages.length - 81);
    return { reply, language: locale };
  };
  if (!input) return speak(t('I missed that. Could you try again?', 'मुझे सुनाई नहीं दिया। फिर से कहेंगे?', 'मला ऐकू आलं नाही. पुन्हा सांगाल का?'));
  session.messages.push({ role: 'caller', text: text.trim(), language: locale });

  const getItem = (id) => session.order.items.find((item) => item.id === id);
  const matcher = itemMatcher(session.order.items);
  const mentionIds = matcher.ids;
  const noChange = () => speak(t('There’s no change waiting for confirmation. What would you like to update?', 'अभी कोई बदलाव पुष्टि के लिए बाकी नहीं है। क्या बदलना है?', 'सध्या पुष्टीसाठी कोणताही बदल बाकी नाही. काय बदलायचं आहे?'));
  const blocked = (item) => {
    const name = productName(item, key);
    return t(`${name} has already shipped, so I can’t change it.`, `${name} की खेप पहले ही निकल चुकी है। उसमें अब बदलाव नहीं हो सकता।`, `${name} याची खेप आधीच रवाना झाली आहे. आता बदल करता येणार नाही.`);
  };
  const clearDraft = () => { session.pending = null; session.focus = null; };
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
    item.quantity = pending.to;
    session.history.unshift({ ...pending, at: new Date().toISOString() });
    const name = productName(item, key);
    const amount = describeAmount(item, item.quantity, key);
    if (item.quantity === 0) return speak(t(`Done. I removed the ${name} from the order.`, `हो गया। ${name} ऑर्डर से हटा दिया है।`, `झालं. ऑर्डरमधून ${name} काढला आहे.`));
    return speak(t(`Done. The order now has ${amount} of ${name}.`, `हो गया। ऑर्डर में अब ${hindiItemAmount(item, item.quantity)} हैं।`, `झालं. ऑर्डरमध्ये आता ${marathiItemAmount(item, item.quantity)} आहेत.`));
  }

  const reference = orderReference(input, session.order.id);
  if (reference.wrong) {
    clearDraft();
    return speak(t('That reference differs from the open order. Open the correct order first.', 'यह खुले ऑर्डर का नंबर नहीं है। पहले सही ऑर्डर खोलें।', 'हा उघड्या ऑर्डरचा क्रमांक नाही. आधी योग्य ऑर्डर उघडा.'));
  }
  const command = reference.rest;
  const itemIds = mentionIds(command);
  const isRead = reads.test(command);
  if (wholeOrderCancel.test(input)) {
    clearDraft();
    return speak(t('I can remove an item that hasn’t shipped. A full order cancellation needs the dispatch team.', 'जो सामान भेजा नहीं गया है, उसे हटा सकता हूँ। पूरा ऑर्डर रद्द करने के लिए डिस्पैच टीम से बात करनी होगी।', 'अजून न पाठवलेली वस्तू काढता येईल. पूर्ण ऑर्डर रद्द करण्यासाठी डिस्पॅच टीमशी बोलावं लागेल.'));
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
    const wantsRead = reads.test(clause) && !hasAction;
    if (wantsRead) {
      readItems.push(...ids);
      continue;
    }
    if (doNotChange.test(clause)) continue;
    if (ids.length && !hasAction && !hasQuantity) {
      readItems.push(...ids);
      pairedScope = true;
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
    const incompatibleUnit = (bags.test(remainder) && unit !== 'bags') || (cases.test(remainder) && unit !== 'cases') ||
      (weights.test(remainder) && (/(?:litres?|liters?|लिटर|लीटर)/u.test(remainder) ? unit !== 'litre' : unit !== 'kg'));
    const limit = item.limit ?? maxQuantity;
    if (!Number.isInteger(target) || target < 0 || target > limit || incompatibleUnit) {
      invalid.set(item, limit);
      continue;
    }
    plans.push({ itemId: item.id, name: item.name, from: item.quantity, to: target });
  }

  const blockedText = [...unavailable].map(blocked).join(' ');
  if (pairedScope && (plans.length || unavailable.size || unclear.size) && itemIds.length > 1) {
    clearDraft();
    return speak([blockedText, basicQuestion[key]].filter(Boolean).join(' '));
  }
  if (invalid.size) {
    clearDraft();
    const [[item, limit]] = invalid;
    session.focus = invalid.size === 1 && plans.length === 0 ? item.id : null;
    const name = productName(item, key);
    const max = describeAmount(item, limit, key);
    const response = t(`What whole quantity should I use for ${name}? The maximum is ${max}.`, `${name} की पूरी संख्या बताइए। ज़्यादा से ज़्यादा ${max} रख सकते हैं।`, `${name} किती ठेवायचा, पूर्ण संख्या सांगा. जास्तीत जास्त ${max} ठेवता येतील.`);
    return speak([blockedText, response].filter(Boolean).join(' '));
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
    return speak([blockedText, response].filter(Boolean).join(' '));
  }
  if (plans.length === 1) {
    const [proposal] = plans;
    const item = getItem(proposal.itemId);
    session.focus = null;
    const name = productName(item, key);
    const amount = describeAmount(item, proposal.to, key);
    let response;
    if (proposal.from === proposal.to) {
      session.pending = null;
      response = t(`The order already has ${amount} of ${name}.`, `ऑर्डर में ${hindiItemAmount(item, proposal.to)} पहले से हैं।`, `ऑर्डरमध्ये ${marathiItemAmount(item, proposal.to)} आधीपासूनच आहेत.`);
    } else {
      session.pending = proposal;
      response = proposal.to === 0
        ? t(`I can remove the ${name}. Shall I go ahead?`, `${name} हटा सकता हूँ। कर दूँ?`, `${name} काढता येईल. काढू का?`)
        : t(`I can set ${name} to ${amount}. Shall I make that change?`, `${hindiItemAmount(item, proposal.to)} कर सकता हूँ। यह बदलाव कर दूँ?`, `${marathiItemAmount(item, proposal.to)} करता येतील. हा बदल करू का?`);
    }
    return speak([blockedText, response].filter(Boolean).join(' '));
  }
  if (unavailable.size) {
    clearDraft();
    return speak(blockedText);
  }
  if (isRead || readItems.length || reference.found) {
    if (!readItems.length) readItems = itemIds;
    const items = readItems.length ? [...new Set(readItems)].map(getItem) : session.order.items;
    const pendingReminder = session.pending ? t(' Your proposed change is still waiting for confirmation.', ' आपका बदलाव अभी पुष्टि के लिए बाकी है।', ' तुम्ही सांगितलेल्या बदलाला अजून पुष्टी हवी आहे.') : '';
    return speak(`${describeOrder(items, key)}.${pendingReminder}`);
  }
  if (doNotChange.test(command)) {
    clearDraft();
    return speak(t('Okay, I’ve left the order as it was.', 'ठीक है, ऑर्डर वैसा ही रहेगा।', 'ठीक आहे, ऑर्डर जशी होती तशीच ठेवली आहे.'));
  }

  if (session.pending || session.focus) {
    const draftItem = getItem(session.pending?.itemId ?? session.focus);
    clearDraft();
    session.focus = draftItem?.id ?? null;
    return speak(t('I didn’t get the latest change. Could you say the item and final quantity again?', 'आख़िरी बदलाव समझ नहीं आया। सामान और कुल मात्रा फिर से बताएँगे?', 'शेवटचा बदल कळला नाही. वस्तू आणि एकूण प्रमाण पुन्हा सांगाल का?'));
  }
  return speak(basicQuestion[key]);
}
