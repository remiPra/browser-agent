// ── Browser Controller v3 ────────────────────────────────────────────
// Couche 🔧 EXÉCUTEUR via Playwright
// v3 : Utilise data-phantom-id injectés par l'Observer pour que les
//      index soient parfaitement synchronisés

import { chromium } from 'playwright';
import { CONFIG } from '../config.js';
import fs from 'fs';
import path from 'path';

export class BrowserController {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.isReady = false;
  }

  // ── Lancement (stealth mode) ─────────────────────────────────────
  async launch() {
    console.log(`🌐 Lancement du navigateur (headless: ${CONFIG.HEADLESS})...`);

    this.browser = await chromium.launch({
      headless: CONFIG.HEADLESS,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--window-size=1280,800',
      ],
    });

    // ── Vérifier si une session existe ──
    const sessionPath = path.join(CONFIG.SESSION_DIR, CONFIG.SESSION_FILE);
    const absolutePath = path.resolve(sessionPath);
    let storageState = undefined;

    console.log(`🔍 Recherche session : ${absolutePath}`);

    if (fs.existsSync(sessionPath)) {
      storageState = sessionPath;
      console.log('🔄 Session restaurée depuis', sessionPath);
    } else {
      console.log('🆕 Nouvelle session (aucune session sauvegardée)');
    }

    this.context = await this.browser.newContext({
      viewport: CONFIG.VIEWPORT,
      userAgent: CONFIG.USER_AGENT,
      locale: 'fr-FR',
      timezoneId: 'Europe/Paris',
      // Ajouter des permissions réalistes
      permissions: ['geolocation'],
      geolocation: { latitude: 48.8566, longitude: 2.3522 },
      // Restaurer la session si elle existe
      storageState,
    });

    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(CONFIG.DEFAULT_TIMEOUT);

    // ── Stealth : masquer les traces d'automatisation ──
    await this.page.addInitScript(() => {
      // Masquer webdriver
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      
      // Simuler un vrai Chrome
      window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
      
      // Masquer les permissions Playwright
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters)
      );
      
      // Ajouter des plugins réalistes
      Object.defineProperty(navigator, 'plugins', {
        get: () => [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
          { name: 'Native Client', filename: 'internal-nacl-plugin' },
        ],
      });

      // Ajouter languages
      Object.defineProperty(navigator, 'languages', { get: () => ['fr-FR', 'fr', 'en-US', 'en'] });
    });

    this.isReady = true;
    console.log('✅ Navigateur prêt (stealth mode) !');
    return this.page;
  }

  // ── Navigation ───────────────────────────────────────────────────
  async goto(url) {
    if (!url.startsWith('http')) url = 'https://' + url;
    console.log(`📍 Navigation vers : ${url}`);
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.DEFAULT_TIMEOUT });
      await this.page.waitForTimeout(1500);
      await this.tryDismissCookiePopup();
      return { success: true, url: this.page.url(), title: await this.page.title() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // 🍪 AUTO-GESTION COOKIES / RGPD (page + iframes)
  // ══════════════════════════════════════════════════════════════════
  async tryDismissCookiePopup() {
    const acceptTexts = [
      'Tout accepter', 'Accept all', 'Accepter tout', "J'accepte",
      'I agree', 'Accepter', 'Accept', 'Agree', 'Autoriser',
      'Allow all', 'Tout autoriser', 'Consent',
    ];

    // Page principale
    if (await this._clickCookieButton(this.page, acceptTexts)) {
      console.log('🍪 Popup cookies fermée (page)');
      await this.page.waitForTimeout(1000);
      return true;
    }

    // Iframes
    try {
      for (const frame of this.page.frames()) {
        if (frame === this.page.mainFrame()) continue;
        if (await this._clickCookieButton(frame, acceptTexts)) {
          console.log('🍪 Popup cookies fermée (iframe)');
          await this.page.waitForTimeout(1000);
          return true;
        }
      }
    } catch { /* ignore */ }

    return false;
  }

  async _clickCookieButton(frame, texts) {
    for (const text of texts) {
      try {
        const loc = frame.getByRole('button', { name: text, exact: false });
        if (await loc.count() > 0 && await loc.first().isVisible({ timeout: 500 })) {
          await loc.first().click({ timeout: 2000 });
          return true;
        }
      } catch { /* next */ }
      try {
        const loc = frame.getByText(text, { exact: true });
        if (await loc.count() > 0 && await loc.first().isVisible({ timeout: 500 })) {
          await loc.first().click({ timeout: 2000 });
          return true;
        }
      } catch { /* next */ }
    }
    return false;
  }

  // ══════════════════════════════════════════════════════════════════
  // CLIC — Toujours via data-phantom-id (synchronisé avec Observer)
  // ══════════════════════════════════════════════════════════════════

  async clickByIndex(index) {
    console.log(`🖱️  Clic sur [${index}]`);
    try {
      const selector = `[data-phantom-id="${index}"]`;
      const el = await this.page.$(selector);
      if (!el) {
        return { success: false, error: `Élément [${index}] introuvable dans le DOM` };
      }
      await el.scrollIntoViewIfNeeded();
      await el.click({ force: false, timeout: 5000 });
      await this.page.waitForTimeout(800);
      return { success: true, action: 'click', index };
    } catch (err) {
      // Retry avec force: true
      try {
        const el = await this.page.$(`[data-phantom-id="${index}"]`);
        if (el) {
          await el.click({ force: true });
          await this.page.waitForTimeout(800);
          return { success: true, action: 'click', index, forced: true };
        }
      } catch { /* abandon */ }
      return { success: false, error: `Clic [${index}] échoué: ${err.message}` };
    }
  }

  async clickByText(text) {
    console.log(`🖱️  Clic sur texte : "${text}"`);
    try {
      for (const role of ['button', 'link', 'tab', 'menuitem']) {
        const loc = this.page.getByRole(role, { name: text, exact: false });
        if (await loc.count() > 0 && await loc.first().isVisible()) {
          await loc.first().click();
          await this.page.waitForTimeout(800);
          return { success: true, action: 'click_by_text', text };
        }
      }
      // Fallback par texte
      const loc = this.page.getByText(text, { exact: false });
      if (await loc.count() > 0 && await loc.first().isVisible()) {
        await loc.first().click();
        await this.page.waitForTimeout(800);
        return { success: true, action: 'click_by_text', text };
      }
      return { success: false, error: `Aucun élément avec texte "${text}"` };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async click(selector) {
    console.log(`🖱️  Clic CSS : ${selector}`);
    try {
      await this.page.waitForSelector(selector, { timeout: 5000 });
      await this.page.click(selector);
      await this.page.waitForTimeout(800);
      return { success: true, action: 'click', selector };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // SAISIE — Via data-phantom-id, placeholder, ou sélecteur CSS
  // ══════════════════════════════════════════════════════════════════

  // ── Helpers : simulation de frappe humaine ultra-réaliste ──

  // Carte des touches adjacentes sur clavier QWERTY (pour simuler erreurs)
  _keyboardNeighbors = {
    'a': ['q', 's', 'z'], 'b': ['v', 'g', 'h', 'n'], 'c': ['x', 'd', 'f', 'v'],
    'd': ['s', 'e', 'r', 'f', 'c', 'x'], 'e': ['w', 'r', 'd', 's'], 'f': ['d', 'r', 't', 'g', 'v', 'c'],
    'g': ['f', 't', 'y', 'h', 'b', 'v'], 'h': ['g', 'y', 'u', 'j', 'n', 'b'], 'i': ['u', 'o', 'k', 'j'],
    'j': ['h', 'u', 'i', 'k', 'm', 'n'], 'k': ['j', 'i', 'o', 'l', 'm'], 'l': ['k', 'o', 'p'],
    'm': ['n', 'j', 'k'], 'n': ['b', 'h', 'j', 'm'], 'o': ['i', 'p', 'l', 'k'],
    'p': ['o', 'l'], 'q': ['w', 'a'], 'r': ['e', 't', 'f', 'd'],
    's': ['a', 'w', 'e', 'd', 'x', 'z'], 't': ['r', 'y', 'g', 'f'], 'u': ['y', 'i', 'j', 'h'],
    'v': ['c', 'f', 'g', 'b'], 'w': ['q', 'e', 's', 'a'], 'x': ['z', 's', 'd', 'c'],
    'y': ['t', 'u', 'h', 'g'], 'z': ['a', 's', 'x'],
  };

  _getHumanTypingDelay() {
    const { MIN_DELAY, MAX_DELAY } = CONFIG.HUMAN_TYPING;
    return MIN_DELAY + Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY));
  }

  _getTypoFor(char) {
    const lower = char.toLowerCase();
    const neighbors = this._keyboardNeighbors[lower];
    if (!neighbors || neighbors.length === 0) return char;
    const typo = neighbors[Math.floor(Math.random() * neighbors.length)];
    return char === char.toUpperCase() ? typo.toUpperCase() : typo;
  }

  // ── Méthode principale : tape comme un humain (avec erreurs + pauses) ──
  async _typeHumanLike(element, text) {
    const { TYPO_CHANCE, PAUSE_CHANCE, PAUSE_DURATION } = CONFIG.HUMAN_TYPING;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];

      // Chance de faire une pause d'hésitation
      if (Math.random() < PAUSE_CHANCE) {
        const pauseMs = PAUSE_DURATION[0] + Math.floor(Math.random() * (PAUSE_DURATION[1] - PAUSE_DURATION[0]));
        await this.page.waitForTimeout(pauseMs);
      }

      // Chance de faire une erreur de frappe
      if (Math.random() < TYPO_CHANCE && char.match(/[a-z]/i)) {
        const typo = this._getTypoFor(char);
        await element.type(typo, { delay: this._getHumanTypingDelay() });

        // Réaction humaine : pause pour réaliser l'erreur
        await this.page.waitForTimeout(150 + Math.floor(Math.random() * 200));

        // Correction : Backspace puis bon caractère
        await this.page.keyboard.press('Backspace');
        await this.page.waitForTimeout(80 + Math.floor(Math.random() * 100));
        await element.type(char, { delay: this._getHumanTypingDelay() });
      } else {
        // Frappe normale avec délai variable
        await element.type(char, { delay: this._getHumanTypingDelay() });
      }
    }
  }

  async typeByIndex(index, text, options = {}) {
    console.log(`⌨️  Saisie [${index}] : "${text}" (mode humain)`);
    try {
      const selector = `[data-phantom-id="${index}"]`;
      const el = await this.page.$(selector);
      if (!el) {
        return { success: false, error: `Champ [${index}] introuvable` };
      }
      await el.scrollIntoViewIfNeeded();
      await el.click();
      await this.page.waitForTimeout(200 + Math.floor(Math.random() * 150)); // Pause après clic
      if (options.clear) {
        await el.fill('');
        await this.page.waitForTimeout(50); // Micro-pause après clear
      }
      // Frappe ultra-humaine avec erreurs et hésitations
      await this._typeHumanLike(el, text);
      return { success: true, action: 'type', index, text };
    } catch (err) {
      return { success: false, error: `Saisie [${index}] échouée: ${err.message}` };
    }
  }

  async typeByPlaceholder(placeholder, text, options = {}) {
    console.log(`⌨️  Saisie placeholder "${placeholder}" : "${text}" (mode humain)`);
    try {
      const loc = this.page.getByPlaceholder(placeholder, { exact: false });
      if (await loc.count() > 0 && await loc.first().isVisible()) {
        const el = await loc.first().elementHandle();
        await el.click();
        await this.page.waitForTimeout(200 + Math.floor(Math.random() * 150)); // Pause après clic
        if (options.clear) {
          await el.fill('');
          await this.page.waitForTimeout(50);
        }
        // Frappe ultra-humaine avec erreurs et hésitations
        await this._typeHumanLike(el, text);
        return { success: true, action: 'type_by_placeholder', placeholder, text };
      }
      return { success: false, error: `Aucun champ avec placeholder "${placeholder}"` };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async type(selector, text, options = {}) {
    console.log(`⌨️  Saisie CSS "${selector}" : "${text}" (mode humain)`);
    try {
      await this.page.waitForSelector(selector, { timeout: 5000 });
      const el = await this.page.$(selector);
      await el.click();
      await this.page.waitForTimeout(200 + Math.floor(Math.random() * 150)); // Pause après clic
      if (options.clear) {
        await el.fill('');
        await this.page.waitForTimeout(50);
      }
      // Frappe ultra-humaine avec erreurs et hésitations
      await this._typeHumanLike(el, text);
      return { success: true, action: 'type', selector, text };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // AUTRES ACTIONS
  // ══════════════════════════════════════════════════════════════════

  async pressKey(key) {
    console.log(`⌨️  Touche : ${key}`);
    try {
      await this.page.keyboard.press(key);
      await this.page.waitForTimeout(500);
      return { success: true, action: 'press_key', key };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async scroll(direction = 'down', amount = 500) {
    console.log(`📜 Scroll ${direction} (${amount}px)`);
    await this.page.evaluate((d) => window.scrollBy(0, d), direction === 'down' ? amount : -amount);
    await this.page.waitForTimeout(500);
    return { success: true, action: 'scroll', direction, amount };
  }

  async wait(ms = 2000) {
    console.log(`⏳ Attente ${ms}ms...`);
    await this.page.waitForTimeout(ms);
    return { success: true, action: 'wait', duration: ms };
  }

  async goBack() {
    console.log('⬅️  Retour');
    try {
      await this.page.goBack({ waitUntil: 'domcontentloaded' });
      await this.page.waitForTimeout(1000);
      return { success: true, action: 'go_back', url: this.page.url() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async select(selector, value) {
    console.log(`📋 Sélection "${value}" dans "${selector}"`);
    try {
      await this.page.selectOption(selector, value);
      return { success: true, action: 'select', selector, value };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async hover(selector) {
    console.log(`🎯 Hover : ${selector}`);
    try {
      await this.page.hover(selector);
      await this.page.waitForTimeout(500);
      return { success: true, action: 'hover', selector };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async screenshot() {
    try {
      const buffer = await this.page.screenshot({ type: 'jpeg', quality: CONFIG.SCREENSHOT_QUALITY, fullPage: false });
      return buffer.toString('base64');
    } catch (err) {
      console.error('❌ Screenshot échoué:', err.message);
      return null;
    }
  }

  async getPageInfo() {
    try {
      return { url: this.page.url(), title: await this.page.title() };
    } catch {
      return { url: 'about:blank', title: '' };
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // SESSION PERSISTENCE
  // ══════════════════════════════════════════════════════════════════

  async saveSession() {
    try {
      // Créer le dossier sessions/ s'il n'existe pas
      if (!fs.existsSync(CONFIG.SESSION_DIR)) {
        fs.mkdirSync(CONFIG.SESSION_DIR, { recursive: true });
      }

      const sessionPath = path.join(CONFIG.SESSION_DIR, CONFIG.SESSION_FILE);
      await this.context.storageState({ path: sessionPath });
      console.log('💾 Session sauvegardée dans', sessionPath);
      return { success: true, path: sessionPath };
    } catch (err) {
      console.error('❌ Erreur sauvegarde session:', err.message);
      return { success: false, error: err.message };
    }
  }

  async close() {
    if (this.browser) {
      // Sauvegarder automatiquement la session avant de fermer
      if (this.context && this.isReady) {
        try {
          await this.saveSession();
        } catch (err) {
          console.error('⚠️  Impossible de sauvegarder la session avant fermeture:', err.message);
        }
      }

      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
      this.isReady = false;
      console.log('🔒 Navigateur fermé');
    }
  }
}
