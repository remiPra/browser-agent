// ── DOM Observer v4 — Extension Compatible ───────────────────────────
// Version qui fonctionne avec TOUS les controllers (Playwright ET Extension)
// Si le controller a tagAndExtract/extractStructuredContent → les utilise
// Sinon → fallback sur page.evaluate (Playwright classique)

import { CONFIG } from '../config.js';

export class DOMObserverUniversal {
  constructor(browserController) {
    this.browser = browserController;
  }

  async observe() {
    // Si c'est un ExtensionController → utiliser ses méthodes directes
    const isExtension = typeof this.browser.tagAndExtract === 'function' 
                     && typeof this.browser.extractStructuredContent === 'function';

    let interactiveElements, structuredContent, screenshot, pageInfo;

    if (isExtension) {
      // Mode Extension : tout passe par WebSocket → content script
      [interactiveElements, structuredContent, screenshot, pageInfo] = await Promise.all([
        this.browser.tagAndExtract(CONFIG.DOM_MAX_ELEMENTS),
        this.browser.extractStructuredContent(CONFIG.CONTENT_MAX_CHARS || 8000),
        this.browser.screenshot(),
        this.browser.getPageInfo(),
      ]);
    } else {
      // Mode Playwright classique : page.evaluate
      const page = this.browser.page;
      if (!page) return null;

      interactiveElements = await this._tagAndExtractPlaywright(page);
      [pageInfo, structuredContent, screenshot] = await Promise.all([
        this.browser.getPageInfo(),
        this._extractContentPlaywright(page),
        this.browser.screenshot(),
      ]);
    }

    return {
      url: pageInfo?.url || 'about:blank',
      title: pageInfo?.title || '',
      elements: interactiveElements || [],
      content: structuredContent || {},
      screenshot,
      timestamp: new Date().toISOString(),
    };
  }

  // ── Playwright fallback (code existant du dom-observer.js original) ──
  async _tagAndExtractPlaywright(page) {
    try {
      return await page.evaluate((maxElements) => {
        document.querySelectorAll('[data-phantom-id]').forEach(el => el.removeAttribute('data-phantom-id'));

        const INTERACTIVE_SELECTORS = [
          'a[href]', 'button', 'input', 'textarea', 'select',
          '[role="button"]', '[role="link"]', '[role="tab"]',
          '[role="menuitem"]', '[role="checkbox"]', '[role="radio"]',
          '[role="combobox"]', '[onclick]',
          '[tabindex]:not([tabindex="-1"])',
          'summary', '[contenteditable="true"]',
        ];

        const seen = new Set();
        const results = [];
        const allElements = document.querySelectorAll(INTERACTIVE_SELECTORS.join(', '));

        for (const el of allElements) {
          if (results.length >= maxElements) break;
          const rect = el.getBoundingClientRect();
          if (rect.width < 5 || rect.height < 5) continue;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) < 0.1) continue;
          if (rect.top > window.innerHeight + 200 || rect.bottom < -200) continue;

          const key = `${el.tagName}-${Math.round(rect.x)}-${Math.round(rect.y)}-${(el.textContent || '').slice(0, 20)}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const index = results.length;
          el.setAttribute('data-phantom-id', index.toString());

          const tag = el.tagName.toLowerCase();
          const isInput = ['input', 'textarea', 'select'].includes(tag) ||
                          el.getAttribute('contenteditable') === 'true' ||
                          ['combobox', 'textbox', 'searchbox'].includes(el.getAttribute('role'));

          const info = {
            index, tag,
            type: el.type || null,
            role: el.getAttribute('role') || null,
            inputType: isInput ? 'field' : 'action',
            text: (el.textContent || '').trim().slice(0, 80),
            placeholder: el.placeholder || null,
            value: (el.value || '').slice(0, 50) || null,
            href: el.href ? el.href.slice(0, 100) : null,
            ariaLabel: el.getAttribute('aria-label') || null,
            name: el.name || null, id: el.id || null,
            disabled: el.disabled || false,
          };

          Object.keys(info).forEach(k => {
            if (info[k] === null || info[k] === undefined || info[k] === '' || info[k] === false) {
              if (k !== 'index' && k !== 'inputType') delete info[k];
            }
          });
          results.push(info);
        }
        return results;
      }, CONFIG.DOM_MAX_ELEMENTS);
    } catch (err) {
      console.error('❌ Erreur extraction DOM:', err.message);
      return [];
    }
  }

  async _extractContentPlaywright(page) {
    // Identique à l'original — on peut importer depuis dom-observer.js si besoin
    // Pour simplifier, on délègue au DOMObserver original importé
    try {
      const { DOMObserver } = await import('./dom-observer.js');
      const obs = new DOMObserver(this.browser);
      return await obs.extractStructuredContent(page);
    } catch {
      return { headings: [], paragraphs: [], lists: [], searchResults: [], mainContent: '', metadata: {} };
    }
  }

  // ── Formater pour l'IA (identique à l'original) ──
  formatForAI(observation) {
    if (!observation) return 'Aucune observation disponible.';

    const content = observation.content || {};
    const meta = content.metadata || {};

    let output = `📍 URL: ${observation.url}\n📄 Titre: ${observation.title}\n`;

    if (meta.pageType && meta.pageType !== 'other') {
      const typeLabels = {
        search_results: 'Résultats de recherche',
        article: 'Article / Page de contenu',
        login: 'Page de connexion',
        form: 'Formulaire',
        listing: 'Liste / Catalogue',
        homepage: "Page d'accueil",
      };
      output += `📊 Type: ${typeLabels[meta.pageType] || meta.pageType}\n`;
    }

    const flags = [];
    if (meta.hasSearch) flags.push('recherche');
    if (meta.hasForm) flags.push('formulaire');
    if (meta.hasLogin) flags.push('connexion');
    if (flags.length > 0) output += `🔎 Détecté: ${flags.join(', ')}\n`;

    output += '\n';

    let hasContent = false;

    if (content.searchResults && content.searchResults.length > 0) {
      hasContent = true;
      output += `── Résultats de recherche (${content.searchResults.length}) ──\n`;
      for (let i = 0; i < content.searchResults.length; i++) {
        const sr = content.searchResults[i];
        output += `  ${i + 1}. ${sr.title}\n`;
        if (sr.snippet) output += `     ${sr.snippet}\n`;
        if (sr.url) output += `     🔗 ${sr.url}\n`;
      }
      output += '\n';
    }

    if (content.headings && content.headings.length > 0) {
      hasContent = true;
      output += `── Titres de la page ──\n`;
      for (const h of content.headings) {
        const prefix = '  '.repeat(h.level - 1);
        output += `${prefix}${'#'.repeat(h.level)} ${h.text}\n`;
      }
      output += '\n';
    }

    if (content.paragraphs && content.paragraphs.length > 0) {
      hasContent = true;
      output += `── Contenu principal ──\n`;
      for (const p of content.paragraphs) {
        output += `  ${p}\n`;
      }
      output += '\n';
    }

    if (content.lists && content.lists.length > 0) {
      hasContent = true;
      for (const list of content.lists) {
        output += `── Liste ──\n`;
        for (const item of list.items) {
          output += `  • ${item}\n`;
        }
        output += '\n';
      }
    }

    if (!hasContent && content.mainContent) {
      output += `── Texte de la page ──\n${content.mainContent.slice(0, 3000)}\n\n`;
    }

    const fields = (observation.elements || []).filter(e => e.inputType === 'field');
    const actions = (observation.elements || []).filter(e => e.inputType !== 'field');

    if (fields.length > 0) {
      output += `── Champs de saisie (${fields.length}) ──\n`;
      for (const el of fields) {
        let desc = `[${el.index}] <${el.tag}>`;
        if (el.type) desc += ` type="${el.type}"`;
        if (el.role) desc += ` role="${el.role}"`;
        if (el.placeholder) desc += ` placeholder="${el.placeholder}"`;
        if (el.value) desc += ` value="${el.value}"`;
        if (el.ariaLabel) desc += ` aria="${el.ariaLabel}"`;
        if (el.name) desc += ` name="${el.name}"`;
        if (el.disabled) desc += ' [DÉSACTIVÉ]';
        output += desc + '\n';
      }
      output += '\n';
    }

    if (actions.length > 0) {
      output += `── Boutons & liens (${actions.length}) ──\n`;
      for (const el of actions) {
        let desc = `[${el.index}] <${el.tag}>`;
        if (el.role) desc += ` role="${el.role}"`;
        if (el.text) desc += ` "${el.text}"`;
        if (el.href) desc += ` → ${el.href.slice(0, 60)}`;
        if (el.ariaLabel) desc += ` aria="${el.ariaLabel}"`;
        if (el.disabled) desc += ' [DÉSACTIVÉ]';
        output += desc + '\n';
      }
    }

    return output;
  }
}
