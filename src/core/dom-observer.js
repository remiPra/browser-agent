// ── DOM Observer v3 ──────────────────────────────────────────────────
// Couche 👁️ OBSERVER : extrait et simplifie le DOM pour l'IA
// v3 : Injecte des data-phantom-id dans la page pour que les index
//      soient IDENTIQUES entre ce que l'IA voit et ce que Playwright clique

import { CONFIG } from '../config.js';

export class DOMObserver {
  constructor(browserController) {
    this.browser = browserController;
  }

  // ── Observation complète ─────────────────────────────────────────
  async observe() {
    const page = this.browser.page;
    if (!page) return null;

    // 1) Injecter les IDs dans la page + extraire les éléments
    const interactiveElements = await this.tagAndExtract(page);

    // 2) Screenshot + infos
    const [pageInfo, visibleText, screenshot] = await Promise.all([
      this.browser.getPageInfo(),
      this.extractVisibleText(page),
      this.browser.screenshot(),
    ]);

    return {
      url: pageInfo.url,
      title: pageInfo.title,
      elements: interactiveElements,
      visibleText,
      screenshot,
      timestamp: new Date().toISOString(),
    };
  }

  // ── Tagger les éléments + extraire ───────────────────────────────
  // On injecte un attribut data-phantom-id sur chaque élément interactif
  // visible. Ainsi l'IA voit [5] et Playwright peut cliquer [data-phantom-id="5"]
  async tagAndExtract(page) {
    try {
      const elements = await page.evaluate((maxElements) => {
        // Nettoyer les anciens tags
        document.querySelectorAll('[data-phantom-id]').forEach(el => {
          el.removeAttribute('data-phantom-id');
        });

        const INTERACTIVE_SELECTORS = [
          'a[href]',
          'button',
          'input',
          'textarea',
          'select',
          '[role="button"]',
          '[role="link"]',
          '[role="tab"]',
          '[role="menuitem"]',
          '[role="checkbox"]',
          '[role="radio"]',
          '[role="combobox"]',
          '[onclick]',
          '[tabindex]:not([tabindex="-1"])',
          'summary',
          '[contenteditable="true"]',
        ];

        const seen = new Set();
        const results = [];
        const allElements = document.querySelectorAll(INTERACTIVE_SELECTORS.join(', '));

        for (const el of allElements) {
          if (results.length >= maxElements) break;

          // Vérifier visibilité
          const rect = el.getBoundingClientRect();
          if (rect.width < 5 || rect.height < 5) continue;

          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) < 0.1) continue;

          // Vérifier dans le viewport (avec marge)
          if (rect.top > window.innerHeight + 200 || rect.bottom < -200) continue;

          // Dédupliquer
          const key = `${el.tagName}-${Math.round(rect.x)}-${Math.round(rect.y)}-${(el.textContent || '').slice(0, 20)}`;
          if (seen.has(key)) continue;
          seen.add(key);

          // Assigner l'index et tagger dans le DOM
          const index = results.length;
          el.setAttribute('data-phantom-id', index.toString());

          // Déterminer le type d'élément
          const tag = el.tagName.toLowerCase();
          const isInput = ['input', 'textarea', 'select'].includes(tag) || 
                          el.getAttribute('contenteditable') === 'true' ||
                          el.getAttribute('role') === 'combobox' ||
                          el.getAttribute('role') === 'textbox' ||
                          el.getAttribute('role') === 'searchbox';

          const info = {
            index,
            tag,
            type: el.type || null,
            role: el.getAttribute('role') || null,
            inputType: isInput ? 'field' : 'action',  // ← Nouveau : distingue champs vs actions
            text: (el.textContent || '').trim().slice(0, 80),
            placeholder: el.placeholder || null,
            value: (el.value || '').slice(0, 50) || null,
            href: el.href ? el.href.slice(0, 100) : null,
            ariaLabel: el.getAttribute('aria-label') || null,
            name: el.name || null,
            id: el.id || null,
            disabled: el.disabled || false,
            checked: el.checked || undefined,
          };

          // Nettoyer les null/undefined/vides
          Object.keys(info).forEach(k => {
            if (info[k] === null || info[k] === undefined || info[k] === '' || info[k] === false) {
              if (k !== 'index' && k !== 'inputType') delete info[k];
            }
          });

          results.push(info);
        }

        return results;
      }, CONFIG.DOM_MAX_ELEMENTS);

      return elements;
    } catch (err) {
      console.error('❌ Erreur extraction DOM:', err.message);
      return [];
    }
  }

  // ── Extraction du texte visible ──────────────────────────────────
  async extractVisibleText(page) {
    try {
      return await page.evaluate(() => {
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
          {
            acceptNode(node) {
              const parent = node.parentElement;
              if (!parent) return NodeFilter.FILTER_REJECT;
              const tag = parent.tagName.toLowerCase();
              if (['script', 'style', 'noscript', 'svg', 'path'].includes(tag)) return NodeFilter.FILTER_REJECT;
              const style = window.getComputedStyle(parent);
              if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
              if (node.textContent.trim().length < 2) return NodeFilter.FILTER_REJECT;
              return NodeFilter.FILTER_ACCEPT;
            }
          }
        );

        const texts = [];
        let total = 0;
        let node;
        while ((node = walker.nextNode()) && total < 3001) {
          const t = node.textContent.trim();
          if (t) { texts.push(t); total += t.length; }
        }
        return texts.join(' ').slice(0, 3001);
      });
    } catch (err) {
      console.error('❌ Erreur extraction texte:', err.message);
      return '';
    }
  }

  // ── Formater pour l'IA ───────────────────────────────────────────
  formatForAI(observation) {
    if (!observation) return 'Aucune observation disponible.';

    let output = `📍 URL: ${observation.url}\n📄 Titre: ${observation.title}\n\n`;

    // Séparer champs de saisie et éléments d'action
    const fields = observation.elements.filter(e => e.inputType === 'field');
    const actions = observation.elements.filter(e => e.inputType !== 'field');

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

    if (observation.visibleText) {
      output += `\n── Texte visible (extrait) ──\n${observation.visibleText.slice(0, 1500)}\n`;
    }

    return output;
  }
}
