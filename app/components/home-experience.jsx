"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import styles from "./home.module.css";
const conversations = {
  en: {
    label: "English",
    request: "Actually, make that two bags of rice.",
    reply: "Of course. Four bags to two. Shall I update your order?",
    confirm: "Confirm change",
    done: "All sorted. Two bags it is.",
  },
  hi: {
    label: "हिन्दी",
    request: "चावल के चार बैग की जगह दो कर दीजिए।",
    reply: "ज़रूर। चावल के चार बैग से दो बैग कर दूँ?",
    confirm: "बदलाव की पुष्टि करें",
    done: "हो गया। अब चावल के दो बैग हैं।",
  },
  mr: {
    label: "मराठी",
    request: "तांदळाच्या चार पिशव्यांऐवजी दोन करा.",
    reply: "नक्की. चार पिशव्यांऐवजी दोन करू का?",
    confirm: "बदल निश्चित करा",
    done: "झालं. आता तांदळाच्या दोन पिशव्या आहेत.",
  },
};
function Arrow({ diagonal = false }) {
  return (
    <svg
      aria-hidden="true"
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
    >
      <path d={diagonal ? "M5 19 19 5M5 5h14v14" : "M4 12h15m-6-6 6 6-6 6"} />
    </svg>
  );
}
const previewOrders = [
  { name: 'Basmati rice', image: 'rice', from: 4, to: 2 },
  { name: 'Sugar', image: 'sugar', from: 3, to: 1,
    en: ['Just one bag of sugar, please.', 'Sure. Three bags to one. Shall I update your order?', 'Done. One bag of sugar.'],
    hi: ['चीनी के तीन बैग की जगह एक कर दीजिए।', 'ज़रूर। चीनी के तीन बैग से एक बैग कर दूँ?', 'हो गया। अब चीनी का एक बैग है।'],
    mr: ['साखरेच्या तीन पिशव्यांऐवजी एक करा.', 'नक्की. साखरेच्या तीन पिशव्यांऐवजी एक करू का?', 'झालं. आता साखरेची एक पिशवी आहे.'] },
  { name: 'Masala chai', image: 'chai', from: 2, to: 3,
    en: ['Make that three packs of chai.', 'Absolutely. Two packs to three. Shall I confirm?', 'All set. Three packs of chai.'],
    hi: ['चाय के दो पैकेट की जगह तीन कर दीजिए।', 'ज़रूर। चाय के दो पैकेट से तीन पैकेट कर दूँ?', 'हो गया। अब चाय के तीन पैकेट हैं।'],
    mr: ['चहाच्या दोन पाकिटांऐवजी तीन करा.', 'नक्की. चहाची दोन पाकिटे बदलून तीन करू का?', 'झालं. आता चहाची तीन पाकिटे आहेत.'] },
];
export default function HomeExperience() {
  const root = useRef(null);
  const previewPauseUntil = useRef(0);
  const [scenario, setScenario] = useState(0);
  const [previewPlaying, setPreviewPlaying] = useState(true);
  const [language, setLanguage] = useState("en");
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    const stage = root.current.querySelector(`.${styles.stage}`);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let visible = false;
    let elapsed = 0;
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }, { threshold: .25 });
    observer.observe(stage);
    const timer = setInterval(() => {
      if (!previewPlaying || reduced.matches || !visible || document.hidden || Date.now() < previewPauseUntil.current) return;
      elapsed += 1;
      if (elapsed === 4) setConfirmed(true);
      if (elapsed >= 8) {
        elapsed = 0;
        setConfirmed(false);
        setScenario(value => (value + 1) % previewOrders.length);
      }
    }, 1000);
    return () => { observer.disconnect(); clearInterval(timer); };
  }, [previewPlaying, language]);
  useEffect(() => {
    const container = root.current;
    const welcome = container.querySelector(`.${styles.welcome}`);
    let frame = 0;
    const paint = () => {
      frame = 0;
      const progress = Math.max(0, Math.min(1, -container.getBoundingClientRect().top / welcome.offsetHeight));
      container.style.setProperty("--takeover", String(progress));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };
    paint();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, []);
  useEffect(() => {
    const elements = root.current.querySelectorAll(`.${styles.welcomeLogo}, .${styles.wave}`);
    const visible = new Set();
    const update = () => { elements.forEach(element => { element.dataset.moving = String(visible.has(element) && !document.hidden); }); };
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => { if (entry.isIntersecting) visible.add(entry.target); else visible.delete(entry.target); });
      update();
    });
    elements.forEach(element => observer.observe(element));
    document.addEventListener("visibilitychange", update);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, [language, scenario]);
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!window.IntersectionObserver || !Element.prototype.animate) return;
    const animations = new Set();
    let observer;
    const stop = () => {
      observer?.disconnect();
      animations.forEach((animation) => animation.cancel());
      animations.clear();
    };
    const start = () => {
      stop();
      if (preference.matches) return;
      const groups = [
        { selector: `.${styles.header} > a, .${styles.header} nav > a`, distance: -20, stagger: 70 },
        { selector: `.${styles.heroCopy} h1 > span`, distance: 45, stagger: 90, masked: true },
        { selector: `.${styles.heroCopy} > p, .${styles.actions} > a, .${styles.heroNote}`, distance: 28, stagger: 70 },
        { selector: `.${styles.stageTop} > span, .${styles.languageTabs} > button`, distance: 18, stagger: 65 },
        { selector: `.${styles.caller}`, distance: 35, horizontal: true },
        { selector: `.${styles.agent}`, distance: -30, horizontal: true },
        { selector: `.${styles.receipt}`, distance: 45, tilt: true },
        { selector: `.${styles.receiptTitle} > span`, distance: 12, stagger: 65 },
        { selector: `.${styles.receiptItem} > img, .${styles.receiptItem} > div`, distance: 20, stagger: 90 },
        { selector: `.${styles.receiptBottom} > span, .${styles.receiptBottom} > button`, distance: 15, stagger: 80 },
        { selector: `.${styles.previewNote}`, distance: 15 },
        { selector: `.${styles.ribbon} > span, .${styles.ribbon} > svg`, distance: 18, stagger: 65 },
        { selector: `.${styles.marketHeading} > h2, .${styles.marketHeading} > div`, distance: 32, stagger: 90 },
        { selector: `.${styles.product}`, distance: 46, stagger: 85, tilt: true },
        { selector: `.${styles.how} > div > h2, .${styles.how} > div > a`, distance: 32, stagger: 90 },
        { selector: `.${styles.how} li`, distance: 32, stagger: 80, horizontal: true },
        { selector: `.${styles.closing} h2, .${styles.closing} > a, .${styles.closing} > p`, distance: 28, stagger: 80 },
        { selector: `.${styles.footer} > a, .${styles.footer} > span, .${styles.footer} nav > a`, distance: 18, stagger: 50 },
      ];
      const settings = new Map();
      groups.forEach((group) => root.current.querySelectorAll(group.selector).forEach((element, index) => {
        settings.set(element, { ...group, index });
      }));
      observer = new IntersectionObserver((entries) => {
        entries.forEach(({ target, isIntersecting }) => {
          if (!isIntersecting) return;
          observer.unobserve(target);
          if (target.contains(document.activeElement)) return;
          const { distance, stagger = 0, index, tilt, horizontal, masked } = settings.get(target);
          const restingTransform = getComputedStyle(target).transform;
          const animation = target.animate([
            { opacity: 0, ...(masked ? { clipPath: "inset(0 0 100% 0)" } : {}), transform: `translate${horizontal ? "X" : "Y"}(${distance}px)${tilt ? ` rotate(${index % 2 ? 2 : -2}deg)` : ""}` },
            { opacity: 1, ...(masked ? { clipPath: "inset(0 0 0% 0)" } : {}), transform: restingTransform === "none" ? "translate(0, 0) rotate(0deg)" : restingTransform },
          ], { duration: tilt ? 750 : 650, delay: Math.min(index * stagger, 280), easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "backwards" });
          animations.add(animation);
          animation.onfinish = () => animations.delete(animation);
          animation.oncancel = () => animations.delete(animation);
        });
      }, { threshold: 0.12, rootMargin: "0px 0px -24px 0px" });
      settings.forEach((_, element) => observer.observe(element));
    };
    // Keyboard focus should never wait for a decorative entrance.
    const onFocus = () => {
      animations.forEach((animation) => {
        if (animation.effect?.target?.contains(document.activeElement)) animation.cancel();
      });
    };
    start();
    let previouslyVisible = false;
    let replayReady = false;
    const sectionObserver = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting && previouslyVisible) replayReady = true;
      if (entry.isIntersecting && replayReady) { replayReady = false; start(); }
      if (entry.isIntersecting) previouslyVisible = true;
    });
    sectionObserver.observe(root.current.querySelector(`.${styles.hero}`));
    preference.addEventListener("change", start);
    const container = root.current;
    container.addEventListener("focusin", onFocus);
    return () => {
      stop();
      sectionObserver.disconnect();
      preference.removeEventListener("change", start);
      container.removeEventListener("focusin", onFocus);
    };
  }, [language]);
  const previewOrder = previewOrders[scenario];
  const scenarioCopy = previewOrder[language];
  const copy = { ...conversations[language], ...(scenarioCopy ? { request: scenarioCopy[0], reply: scenarioCopy[1], done: scenarioCopy[2] } : {}) };
  return (
    <div className={styles.home} ref={root}>
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <section className={styles.welcome} aria-label="Welcome to Dispatch Desk">
        <div className={styles.welcomeIdentity}>
          <svg className={styles.welcomeLogo} aria-hidden="true" viewBox="0 0 88 96" fill="none" stroke="currentColor" strokeWidth="12" strokeLinecap="round">
            <path d="M10 34v28" />
            <path d="M32 12v72" />
            <path d="M54 24v48" />
            <path d="M76 36v24" />
          </svg>
          <p className={styles.welcomeName}>dispatch desk<span>.</span></p>
        </div>
        <a className={styles.scrollInvitation} href="#discover">
          <span>Scroll to discover</span>
          <svg aria-hidden="true" width="24" height="32" viewBox="0 0 24 32" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 2v25m-7-7 7 7 7-7" /></svg>
        </a>
      </section>
      <div className={styles.creamTakeover} id="discover">
      <header className={styles.header}>
        <Link href="/" className={styles.brand} aria-label="Dispatch Desk home">
          <span className={styles.brandMark} aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          dispatch desk<span className={styles.brandPeriod}>.</span>
        </Link>
        <nav aria-label="Main navigation">
          <Link href="/shop">The market</Link>
          <Link href="/workspace">Your orders</Link>
          <Link className={styles.navCta} href="/desk">
            Open the desk <Arrow diagonal />
          </Link>
        </nav>
      </header>
      <main id="main">
        <section className={styles.hero}>
          <div className={styles.heroCopy}>
            <h1>
              <span className={styles.headlineLine}>A little change.</span>
              <span className={styles.headlineLine}>A conversation.</span>
              <span className={styles.headlineLine}>All sorted.</span>
            </h1>
            <p>
              Orders change. Life happens. Shop your everyday essentials, then
              just ask to make them right. In English, Hindi or Marathi.
            </p>
            <div className={styles.actions}>
              <Link className={styles.primary} href="/shop">
                Explore the market <Arrow />
              </Link>
              <Link className={styles.textLink} href="/desk">
                Try Dispatch Desk <Arrow diagonal />
              </Link>
            </div>
            <div className={styles.heroNote}>
              <span aria-hidden="true" /> Your words. Your order. Your call.
            </div>
          </div>
          <div className={styles.stage} onPointerDown={() => { previewPauseUntil.current = Date.now() + 12000; }} onKeyDown={() => { previewPauseUntil.current = Date.now() + 12000; }}>
            <div className={styles.stageTop}>
              <span>One small conversation</span>
              <button className={styles.previewToggle} type="button" aria-pressed={!previewPlaying} onClick={() => setPreviewPlaying(value => !value)}>{previewPlaying ? 'Pause preview' : 'Play preview'}</button>
            </div>
            <div
              className={styles.languageTabs}
              role="group"
              aria-label="Preview language"
            >
              {Object.entries(conversations).map(([key, value]) => (
                <button
                  key={key}
                  type="button"
                  lang={key}
                  aria-pressed={key === language}
                  onClick={() => {
                    setLanguage(key);
                    setConfirmed(false);
                  }}
                >
                  {value.label}
                </button>
              ))}
            </div>
            <div className={styles.preview} key={language} lang={language}>
              <div className={styles.caller}>
                <span>You</span>
                <p key={scenario}>{copy.request}</p>
              </div>
              <div className={styles.agent}>
                <div className={styles.wave} aria-hidden="true">
                  {[12, 24, 38, 20, 46, 30, 18, 36, 24, 10].map((height, i) => (
                    <i
                      key={i}
                      style={{
                        "--bar-height": `${height}px`,
                        "--delay": `${i * 65}ms`,
                      }}
                    />
                  ))}
                </div>
                <p key={scenario}>{copy.reply}</p>
              </div>
              <div className={styles.receipt}>
                <div className={styles.receiptTitle}>
                  <span>YOUR ORDER, UPDATED</span>
                  <span aria-live="polite">
                  {confirmed ? "Confirmed" : "For your review"}
                  </span>
                </div>
                <div className={styles.receiptItem}>
                  <img
                    src={`/shop/products/${previewOrder.image}.webp`}
                    alt=""
                    width="60"
                    height="66"
                  />
                  <div>
                    <strong>{previewOrder.name}</strong>
                    <span>Everyday essentials</span>
                  </div>
                  <div className={styles.quantity}>
                    <s>{previewOrder.from}</s>
                    <Arrow />
                    <strong key={String(confirmed)}>
                      {confirmed ? previewOrder.to : `${previewOrder.to}?`}
                    </strong>
                  </div>
                </div>
                <div className={styles.receiptBottom} aria-live="polite">
                  {confirmed ? (
                    <>
                      <span className={styles.saved}>{copy.done}</span>
                      <button type="button" onClick={() => setConfirmed(false)}>
                        Reset preview
                      </button>
                    </>
                  ) : (
                    <>
                      <span>Nothing changes until you say so.</span>
                      <button type="button" onClick={() => setConfirmed(true)}>
                        {copy.confirm} <Arrow />
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
            <p className={styles.previewNote}>
              Interactive preview · No actual order is changed
            </p>
          </div>
        </section>
        <div className={styles.ribbon}>
          <span>Speak naturally</span>
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M12 0v24M0 12h24M3 3l18 18M3 21 21 3" />
          </svg>
          <span>Change confidently</span>
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M12 0v24M0 12h24M3 3l18 18M3 21 21 3" />
          </svg>
          <span>Carry on with your day</span>
        </div>
        <section className={styles.market} aria-labelledby="market-title">
          <div className={styles.marketHeading}>
            <h2 id="market-title">
              Your pantry.
              <br />
              With a personal touch.
            </h2>
            <div>
              <p>
                From the first cup of chai to tonight’s dinner. Fill your
                basket, place an order, and keep the conversation open.
              </p>
              <Link className={styles.textLink} href="/shop">
                Meet your everyday essentials <Arrow diagonal />
              </Link>
            </div>
          </div>
          <div className={styles.products}>
            {[
              {
                image: "rice",
                name: "The daily staple",
                detail: "Rice & grains",
                color: "#f5dba3",
              },
              {
                image: "chai",
                name: "Your morning ritual",
                detail: "Tea & beverages",
                color: "#dce4c8",
              },
              {
                image: "dal",
                name: "A little comfort",
                detail: "Pulses & pantry",
                color: "#ffd5c6",
              },
            ].map((product) => (
              <Link
                href="/shop"
                className={styles.product}
                key={product.image}
                style={{ "--product-bg": product.color }}
              >
                <div className={styles.productArt}>
                  <img
                    src={`/shop/products/${product.image}.webp`}
                    alt={product.detail}
                    width="300"
                    height="300"
                    loading="lazy"
                  />
                  <span>
                    <Arrow diagonal />
                  </span>
                </div>
                <div className={styles.productCaption}>
                  <h3>{product.name}</h3>
                  <span>{product.detail}</span>
                </div>
              </Link>
            ))}
          </div>
        </section>
        <section className={styles.how} id="how-it-works">
          <div>
            <h2>
              From “wait a second”
              <br />
              to “that’s perfect.”
            </h2>
            <Link className={styles.lightCta} href="/desk">
              Start a conversation <Arrow />
            </Link>
          </div>
          <ol>
            <li>
              <span>01</span>
              <div>
                <h3>Pick your favourites.</h3>
                <p>
                  Browse the market and place your order. Your basket becomes a
                  live order you can revisit.
                </p>
              </div>
            </li>
            <li>
              <span>02</span>
              <div>
                <h3>Say what’s changed.</h3>
                <p>
                  Speak or type in your language. Add an item, adjust a
                  quantity, or ask about your order.
                </p>
              </div>
            </li>
            <li>
              <span>03</span>
              <div>
                <h3>You have the final word.</h3>
                <p>
                  Review the proposed change and confirm it. Packed or shipped
                  items stay protected.
                </p>
              </div>
            </li>
          </ol>
        </section>
        <section className={styles.closing}>
          <h2>
            Good service starts
            <br />
            with listening.
          </h2>
          <Link href="/desk" className={styles.primary}>
            Let’s talk orders <Arrow diagonal />
          </Link>
          <p>Voice or text. English, हिन्दी, मराठी.</p>
        </section>
      </main>
      <footer className={styles.footer}>
        <Link href="/" className={styles.brand}>
          dispatch desk.
        </Link>
        <span>A little more human.</span>
        <nav aria-label="Footer">
          <Link href="/shop">Market</Link>
          <Link href="/workspace">Orders</Link>
          <Link href="/operator">Manage store</Link>
          <a href="/dispatch-desk-pitch.pdf">The idea</a>
        </nav>
      </footer>
      </div>
    </div>
  );
}
