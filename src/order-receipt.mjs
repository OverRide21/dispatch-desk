const labels = {
  en: {
    title: 'Order change receipt', order: 'Order', receipt: 'Receipt', confirmed: 'Confirmed', actor: 'Confirmed by',
    item: 'Item', before: 'Before', after: 'After', backorder: 'Backordered',
    blocked: 'Requests that could not be applied', shipped: 'Already shipped', packed: 'Already packed',
    cutoff: 'Edit cutoff passed', stock: 'Requested quantity exceeded available stock',
    print: 'Use your browser’s Print command to print or save a PDF.',
  },
  hi: {
    title: 'ऑर्डर बदलाव की रसीद', order: 'ऑर्डर', receipt: 'रसीद', confirmed: 'पुष्टि का समय', actor: 'पुष्टि करने वाले',
    item: 'सामान', before: 'पहले', after: 'बदलाव के बाद', backorder: 'बाद की आपूर्ति',
    blocked: 'जो अनुरोध लागू नहीं हुए', shipped: 'पहले ही भेज दिया गया', packed: 'पहले ही पैक हो चुका है',
    cutoff: 'बदलाव की समय-सीमा बीत गई', stock: 'माँगी गई मात्रा उपलब्ध स्टॉक से अधिक थी',
    print: 'रसीद छापने या PDF सहेजने के लिए ब्राउज़र का प्रिंट विकल्प चुनें।',
  },
  mr: {
    title: 'ऑर्डर बदलाची पावती', order: 'ऑर्डर', receipt: 'पावती', confirmed: 'पुष्टीची वेळ', actor: 'पुष्टी करणारे',
    item: 'वस्तू', before: 'आधी', after: 'बदलानंतर', backorder: 'नंतरचा पुरवठा',
    blocked: 'लागू न झालेले अनुरोध', shipped: 'आधीच रवाना झाले', packed: 'आधीच पॅक झाले',
    cutoff: 'बदलाची वेळ संपली', stock: 'मागितलेले प्रमाण उपलब्ध साठ्यापेक्षा जास्त होते',
    print: 'पावती छापण्यासाठी किंवा PDF जतन करण्यासाठी ब्राउझरमधील प्रिंट पर्याय वापरा.',
  },
};

const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => entities[character]);
const dateFormat = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });

export function renderOrderReceipt(receipt, language) {
  const locale = (language ?? receipt.language) === 'hi-IN' ? 'hi' : 'mr';
  const primary = labels.en;
  const secondary = labels[locale];
  const label = key => `${primary[key]} <span lang="${locale}">${secondary[key]}</span>`;
  const rows = receipt.changes.map(change => {
    const localName = locale === 'hi' ? change.nameHi : change.nameMr;
    return `<tr><th scope="row">${escape(change.name)}${localName && localName !== change.name
      ? `<span lang="${locale}">${escape(localName)}</span>` : ''}<small>${escape(change.unit)}</small></th>
      <td>${escape(change.from)}</td><td>${escape(change.to)}</td><td>${escape(change.backorderQuantity ?? 0)}</td></tr>`;
  }).join('');
  const blocked = (receipt.blockedRequests ?? []).map(request => {
    const reason = Object.hasOwn(primary, request.reason) ? label(request.reason) : escape(request.reason);
    const stock = request.reason === 'stock' && Number.isInteger(request.requested) && Number.isInteger(request.available)
      ? ` <small>(${escape(request.requested)} requested · ${escape(request.available)} available)</small>` : '';
    return `<li><strong>${escape(request.name)}</strong> ${reason}${stock}</li>`;
  }).join('');
  const at = new Date(receipt.at);
  const time = Number.isNaN(at.valueOf()) ? '' : `${dateFormat.format(at)} IST`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${primary.title} · ${escape(receipt.orderId)}</title>
<style>
  *{box-sizing:border-box} body{margin:0;padding:clamp(1rem,5vw,3rem);font:1rem/1.55 system-ui,sans-serif;color:#271710;background:#fff1db}
  main{max-width:54rem;margin:auto;background:#fffaf0;border:1px solid #dfc2ac;border-radius:12px;padding:clamp(1rem,4vw,2rem);overflow-wrap:anywhere}
  h1{margin:0;font:700 clamp(1.7rem,4vw,2.55rem)/1.15 Georgia,serif} h2{font-size:1.15rem;margin-top:2rem}
  span[lang],small{display:block;color:#715247;font-family:"Nirmala UI","Noto Sans Devanagari",system-ui,sans-serif} h1 span{font-size:.6em;margin-top:.3rem}
  dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:1rem;margin:1.5rem 0} dt{font-size:.8rem;font-weight:700}dd{margin:.2rem 0 0}
  table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{padding:.55rem .3rem;border-bottom:1px solid #dfc2ac;text-align:left}
  thead th:first-child{width:43%}thead th{font-size:.78rem;vertical-align:top}td{font-variant-numeric:tabular-nums} ul{padding-inline-start:1.3rem}li+li{margin-top:.5rem}
  .print-note{max-width:54rem;margin:1rem auto 0;font-size:.85rem}
  @media print{body{padding:0;background:white}main{border:0;padding:0;background:white}.print-note{display:none}tr,li{break-inside:avoid}}
</style></head>
<body><main><h1>${label('title')}</h1>
<dl><div><dt>${label('order')}</dt><dd>${escape(receipt.orderId)}</dd></div>
<div><dt>${label('receipt')}</dt><dd>${escape(receipt.id)}</dd></div>
<div><dt>${label('confirmed')}</dt><dd><time datetime="${escape(receipt.at)}">${escape(time)}</time></dd></div>
<div><dt>${label('actor')}</dt><dd>${escape(receipt.actor)}</dd></div></dl>
<table><thead><tr><th scope="col">${label('item')}</th><th scope="col">${label('before')}</th>
<th scope="col">${label('after')}</th><th scope="col">${label('backorder')}</th></tr></thead><tbody>${rows}</tbody></table>
${blocked ? `<h2>${label('blocked')}</h2><ul>${blocked}</ul>` : ''}
</main><p class="print-note">${label('print')}</p></body></html>`;
}
