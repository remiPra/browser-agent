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

    // 2) Screenshot + infos + contenu structuré
    const [pageInfo, structuredContent, screenshot] = await Promise.all([
      this.browser.getPageInfo(),
      this.extractStructuredContent(page),
      this.browser.screenshot(),
    ]);

    return {
      url: pageInfo.url,
      title: pageInfo.title,
      elements: interactiveElements,
      content: structuredContent,
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

  // ── Extraction de contenu structuré ──────────────────────────────
  // Extrait le contenu de la page de façon organisée pour que l'IA
  // puisse LIRE et COMPRENDRE la page, pas juste voir les boutons
  async extractStructuredContent(page) {
    const maxChars = CONFIG.CONTENT_MAX_CHARS || 8000;

    try {
      return await page.evaluate((max) => {
        const result = {
          headings: [],
          paragraphs: [],
          lists: [],
          searchResults: [],
          mainContent: '',
          metadata: {
            hasForm: false,
            hasLogin: false,
            hasSearch: false,
            pageType: 'other',
          },
        };

        // ── Helper : élément visible ? ──
        function isVisible(el) {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) >= 0.1;
        }

        // ── Helper : nettoyer le texte ──
        function clean(text) {
          return (text || '').replace(/\s+/g, ' ').trim();
        }

        // ── 1) Metadata de la page ──
        const forms = document.querySelectorAll('form');
        result.metadata.hasForm = forms.length > 0;
        result.metadata.hasSearch = !!document.querySelector(
          'input[type="search"], input[name*="search"], input[name*="query"], input[name="q"], input[placeholder*="earch"], input[placeholder*="herch"], [role="search"]'
        );
        result.metadata.hasLogin = !!document.querySelector(
          'input[type="password"], form[action*="login"], form[action*="signin"], form[action*="auth"], [id*="login"], [class*="login"]'
        );

        // ── 2) Détecter le type de page ──
        const url = window.location.href.toLowerCase();
        const title = document.title.toLowerCase();

        if (url.includes('google.com/search') || url.includes('duckduckgo.com') || url.includes('bing.com/search') || url.includes('search?')) {
          result.metadata.pageType = 'search_results';
        } else if (document.querySelector('article') || document.querySelector('[role="article"]') || document.querySelector('.post-content, .article-content, .entry-content')) {
          result.metadata.pageType = 'article';
        } else if (result.metadata.hasLogin) {
          result.metadata.pageType = 'login';
        } else if (result.metadata.hasForm && !result.metadata.hasSearch) {
          result.metadata.pageType = 'form';
        } else if (document.querySelectorAll('.product, [class*="product"], [class*="listing"], [class*="card"]').length > 3) {
          result.metadata.pageType = 'listing';
        } else if (url.endsWith('/') || url.endsWith('.com') || url.endsWith('.fr') || url.endsWith('.org')) {
          result.metadata.pageType = 'homepage';
        }

        // ── 3) Headings ──
        let charCount = 0;
        for (const h of document.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
          if (!isVisible(h)) continue;
          const text = clean(h.textContent);
          if (text.length < 2 || text.length > 200) continue;
          const level = parseInt(h.tagName[1]);
          result.headings.push({ level, text });
          charCount += text.length;
          if (charCount > max * 0.15) break; // Max 15% pour les headings
        }

        // ── 4) Résultats de recherche (heuristique) ──
        if (result.metadata.pageType === 'search_results') {
          // Google
          const googleResults = document.querySelectorAll('#search .g, #rso .g');
          // DuckDuckGo
          const ddgResults = document.querySelectorAll('[data-result], .result, .results .result__body, article[data-testid="result"]');
          // Bing
          const bingResults = document.querySelectorAll('#b_results .b_algo');

          const resultEls = googleResults.length > 0 ? googleResults :
                            ddgResults.length > 0 ? ddgResults :
                            bingResults.length > 0 ? bingResults : [];

          for (const el of resultEls) {
            if (result.searchResults.length >= 10) break;
            const link = el.querySelector('a[href]');
            const titleEl = el.querySelector('h2, h3, a h3, a h2') || link;
            const snippetEl = el.querySelector('.VwiC3b, .result__snippet, .b_caption p, [data-content-feature="1"], span:not(a span)');

            const srTitle = clean(titleEl?.textContent || '');
            const snippet = clean(snippetEl?.textContent || '');
            const href = link?.href || '';

            if (srTitle && srTitle.length > 2) {
              result.searchResults.push({
                title: srTitle.slice(0, 120),
                snippet: snippet.slice(0, 200),
                url: href.slice(0, 150),
              });
              charCount += srTitle.length + snippet.length;
            }
          }
        }

        // ── 5) Paragraphes / contenu principal ──
        // Chercher le contenu principal : <main>, <article>, ou le plus gros bloc
        const mainEl = document.querySelector('main, article, [role="main"], .content, #content, .post-content, .article-content, .entry-content');
        const contentRoot = mainEl || document.body;

        const paragraphs = contentRoot.querySelectorAll('p, li, blockquote, figcaption, td, .text, [class*="description"]');
        for (const p of paragraphs) {
          if (charCount > max) break;
          if (!isVisible(p)) continue;
          const text = clean(p.textContent);
          if (text.length < 10 || text.length > 1000) continue;
          // Éviter les doublons avec les search results
          if (result.searchResults.some(sr => text.includes(sr.title))) continue;
          result.paragraphs.push(text.slice(0, 500));
          charCount += text.length;
        }

        // ── 6) Listes (résumé) ──
        for (const list of contentRoot.querySelectorAll('ul, ol')) {
          if (charCount > max) break;
          if (!isVisible(list)) continue;
          // Ignorer les listes de navigation (menus)
          const parent = list.closest('nav, header, footer, [role="navigation"]');
          if (parent) continue;

          const items = [];
          for (const li of list.querySelectorAll(':scope > li')) {
            const text = clean(li.textContent);
            if (text.length >= 3 && text.length <= 300) {
              items.push(text.slice(0, 200));
              charCount += text.length;
            }
            if (items.length >= 8) break; // Max 8 items par liste
          }
          if (items.length >= 2) {
            result.lists.push({ items });
          }
        }

        // ── 7) Contenu brut en fallback ──
        // Si on n'a presque rien extrait, fallback vers le texte brut
        if (charCount < 200) {
          const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            {
              acceptNode(node) {
                const p = node.parentElement;
                if (!p) return NodeFilter.FILTER_REJECT;
                const tag = p.tagName.toLowerCase();
                if (['script', 'style', 'noscript', 'svg', 'path'].includes(tag)) return NodeFilter.FILTER_REJECT;
                if (!isVisible(p)) return NodeFilter.FILTER_REJECT;
                if (node.textContent.trim().length < 2) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
              }
            }
          );

          const texts = [];
          let fallbackTotal = 0;
          let node;
          while ((node = walker.nextNode()) && fallbackTotal < max) {
            const t = node.textContent.trim();
            if (t) { texts.push(t); fallbackTotal += t.length; }
          }
          result.mainContent = texts.join(' ').slice(0, max);
        }

        return result;
      }, maxChars);
    } catch (err) {
      console.error('❌ Erreur extraction contenu:', err.message);
      return {
        headings: [],
        paragraphs: [],
        lists: [],
        searchResults: [],
        mainContent: '',
        metadata: { hasForm: false, hasLogin: false, hasSearch: false, pageType: 'other' },
      };
    }
  }

  // ── Formater pour l'IA ───────────────────────────────────────────
  // Ordre : Contexte page → Contenu (ce que l'IA doit comprendre) → Contrôles (ce qu'elle peut faire)
  formatForAI(observation) {
    if (!observation) return 'Aucune observation disponible.';

    const content = observation.content || {};
    const meta = content.metadata || {};

    // ── En-tête de page ──
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

    // ── Contenu structuré de la page ──
    let hasContent = false;

    // Résultats de recherche (priorité haute)
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

    // Titres (headings)
    if (content.headings && content.headings.length > 0) {
      hasContent = true;
      output += `── Titres de la page ──\n`;
      for (const h of content.headings) {
        const prefix = '  '.repeat(h.level - 1);
        output += `${prefix}${'#'.repeat(h.level)} ${h.text}\n`;
      }
      output += '\n';
    }

    // Paragraphes
    if (content.paragraphs && content.paragraphs.length > 0) {
      hasContent = true;
      output += `── Contenu principal ──\n`;
      for (const p of content.paragraphs) {
        output += `  ${p}\n`;
      }
      output += '\n';
    }

    // Listes
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

    // Fallback texte brut
    if (!hasContent && content.mainContent) {
      output += `── Texte de la page ──\n${content.mainContent.slice(0, 3000)}\n\n`;
    }

    // ── Éléments interactifs ──
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

    return output;
  }
}
