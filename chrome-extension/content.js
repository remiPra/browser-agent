// ── Phantom Agent — Content Script ───────────────────────────────────
// Injecté dans chaque page pour manipuler le DOM
// Reçoit des commandes du background script et exécute les actions

(function() {
  // Éviter double injection
  if (window.__phantomAgentInjected) return;
  window.__phantomAgentInjected = true;

  console.log('👻 Phantom Agent content script injecté');

  // ══════════════════════════════════════════════════════════════════
  // 📨 ÉCOUTE DES MESSAGES DU BACKGROUND SCRIPT
  // ══════════════════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Toujours répondre pour éviter les timeouts
    handleMessage(msg).then(sendResponse).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true; // Réponse asynchrone
  });

  async function handleMessage(msg) {
    switch (msg.type) {
      case 'ping':
        return { pong: true };

      case 'tag_and_extract':
        return { elements: tagAndExtract(msg.maxElements || 150) };

      case 'extract_content':
        return { content: extractStructuredContent(msg.maxChars || 8000) };

      case 'click':
        return clickByIndex(msg.index);

      case 'click_by_text':
        return clickByText(msg.text);

      case 'type_text':
        return await typeByIndex(msg.index, msg.text, msg.clear);

      case 'type_by_placeholder':
        return await typeByPlaceholder(msg.placeholder, msg.text, msg.clear);

      case 'press_key':
        return pressKey(msg.key);

      case 'scroll':
        return scrollPage(msg.direction, msg.amount);

      case 'dismiss_cookies':
        return dismissCookies();

      default:
        return { success: false, error: `Commande inconnue: ${msg.type}` };
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // 🏷️ TAG & EXTRACT — Injecte data-phantom-id + extrait les éléments
  // ══════════════════════════════════════════════════════════════════

  function tagAndExtract(maxElements) {
    // Nettoyer les anciens tags
    document.querySelectorAll('[data-phantom-id]').forEach(el => {
      el.removeAttribute('data-phantom-id');
    });

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
                      el.getAttribute('role') === 'combobox' ||
                      el.getAttribute('role') === 'textbox' ||
                      el.getAttribute('role') === 'searchbox';

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
        name: el.name || null,
        id: el.id || null,
        disabled: el.disabled || false,
        checked: el.checked || undefined,
      };

      // Nettoyer
      Object.keys(info).forEach(k => {
        if (info[k] === null || info[k] === undefined || info[k] === '' || info[k] === false) {
          if (k !== 'index' && k !== 'inputType') delete info[k];
        }
      });

      results.push(info);
    }

    return results;
  }

  // ══════════════════════════════════════════════════════════════════
  // 📄 EXTRACT STRUCTURED CONTENT
  // ══════════════════════════════════════════════════════════════════

  function extractStructuredContent(maxChars) {
    const result = {
      headings: [], paragraphs: [], lists: [], searchResults: [],
      mainContent: '',
      metadata: { hasForm: false, hasLogin: false, hasSearch: false, pageType: 'other' },
    };

    function isVisible(el) {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) >= 0.1;
    }

    function clean(text) {
      return (text || '').replace(/\s+/g, ' ').trim();
    }

    // Metadata
    result.metadata.hasForm = document.querySelectorAll('form').length > 0;
    result.metadata.hasSearch = !!document.querySelector(
      'input[type="search"], input[name*="search"], input[name*="query"], input[name="q"], input[placeholder*="earch"], input[placeholder*="herch"], [role="search"]'
    );
    result.metadata.hasLogin = !!document.querySelector(
      'input[type="password"], form[action*="login"], form[action*="signin"]'
    );

    // Page type
    const url = window.location.href.toLowerCase();
    if (url.includes('google.com/search') || url.includes('duckduckgo.com') || url.includes('bing.com/search') || url.includes('search?')) {
      result.metadata.pageType = 'search_results';
    } else if (document.querySelector('article') || document.querySelector('[role="article"]')) {
      result.metadata.pageType = 'article';
    } else if (result.metadata.hasLogin) {
      result.metadata.pageType = 'login';
    } else if (result.metadata.hasForm && !result.metadata.hasSearch) {
      result.metadata.pageType = 'form';
    }

    let charCount = 0;

    // Headings
    for (const h of document.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      if (!isVisible(h)) continue;
      const text = clean(h.textContent);
      if (text.length < 2 || text.length > 200) continue;
      result.headings.push({ level: parseInt(h.tagName[1]), text });
      charCount += text.length;
      if (charCount > maxChars * 0.15) break;
    }

    // Search results
    if (result.metadata.pageType === 'search_results') {
      const googleResults = document.querySelectorAll('#search .g, #rso .g');
      const ddgResults = document.querySelectorAll('[data-result], .result, article[data-testid="result"]');
      const bingResults = document.querySelectorAll('#b_results .b_algo');
      const resultEls = googleResults.length > 0 ? googleResults : ddgResults.length > 0 ? ddgResults : bingResults;

      for (const el of resultEls) {
        if (result.searchResults.length >= 10) break;
        const link = el.querySelector('a[href]');
        const titleEl = el.querySelector('h2, h3, a h3') || link;
        const snippetEl = el.querySelector('.VwiC3b, .result__snippet, .b_caption p, [data-content-feature="1"]');
        const srTitle = clean(titleEl?.textContent || '');
        const snippet = clean(snippetEl?.textContent || '');
        if (srTitle && srTitle.length > 2) {
          result.searchResults.push({
            title: srTitle.slice(0, 120),
            snippet: snippet.slice(0, 200),
            url: (link?.href || '').slice(0, 150),
          });
          charCount += srTitle.length + snippet.length;
        }
      }
    }

    // Paragraphs
    const mainEl = document.querySelector('main, article, [role="main"], .content, #content');
    const contentRoot = mainEl || document.body;
    for (const p of contentRoot.querySelectorAll('p, li, blockquote, td')) {
      if (charCount > maxChars) break;
      if (!isVisible(p)) continue;
      const text = clean(p.textContent);
      if (text.length < 10 || text.length > 1000) continue;
      result.paragraphs.push(text.slice(0, 500));
      charCount += text.length;
    }

    // Fallback
    if (charCount < 200) {
      result.mainContent = clean(document.body.innerText).slice(0, maxChars);
    }

    return result;
  }

  // ══════════════════════════════════════════════════════════════════
  // 🖱️ ACTIONS — Clic, saisie, scroll, etc.
  // ══════════════════════════════════════════════════════════════════

  function clickByIndex(index) {
    const el = document.querySelector(`[data-phantom-id="${index}"]`);
    if (!el) return { success: false, error: `Élément [${index}] introuvable` };

    try {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.click();
      return { success: true, action: 'click', index };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  function clickByText(text) {
    // Chercher dans les boutons, liens, etc.
    const candidates = [
      ...document.querySelectorAll('button, a, [role="button"], [role="link"], [role="tab"], [role="menuitem"]'),
    ];

    const textLower = text.toLowerCase();

    for (const el of candidates) {
      const elText = (el.textContent || '').trim().toLowerCase();
      const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();

      if (elText.includes(textLower) || ariaLabel.includes(textLower)) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;

        try {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.click();
          return { success: true, action: 'click_by_text', text };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }
    }

    // Fallback : chercher dans tout le texte
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      if (el.children.length > 0) continue; // Seulement les feuilles
      const elText = (el.textContent || '').trim().toLowerCase();
      if (elText === textLower || elText.includes(textLower)) {
        try {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.click();
          return { success: true, action: 'click_by_text', text };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }
    }

    return { success: false, error: `Aucun élément avec texte "${text}"` };
  }

  // ── Simulation de frappe humaine ──
  async function simulateTyping(element, text) {
    for (const char of text) {
      // Créer les événements clavier
      const keyDown = new KeyboardEvent('keydown', { key: char, bubbles: true });
      const keyPress = new KeyboardEvent('keypress', { key: char, bubbles: true });
      const input = new InputEvent('input', { data: char, inputType: 'insertText', bubbles: true });
      const keyUp = new KeyboardEvent('keyup', { key: char, bubbles: true });

      element.dispatchEvent(keyDown);
      element.dispatchEvent(keyPress);

      // Modifier la valeur
      if ('value' in element) {
        element.value += char;
      } else if (element.getAttribute('contenteditable')) {
        element.textContent += char;
      }

      element.dispatchEvent(input);
      element.dispatchEvent(keyUp);

      // Délai humain entre les touches
      await new Promise(r => setTimeout(r, 50 + Math.random() * 80));
    }

    // Trigger change event
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function typeByIndex(index, text, clear) {
    const el = document.querySelector(`[data-phantom-id="${index}"]`);
    if (!el) return { success: false, error: `Champ [${index}] introuvable` };

    try {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.focus();
      el.click();

      if (clear && 'value' in el) {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }

      await simulateTyping(el, text);
      return { success: true, action: 'type', index, text };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async function typeByPlaceholder(placeholder, text, clear) {
    const placeholderLower = placeholder.toLowerCase();
    const inputs = document.querySelectorAll('input, textarea, [contenteditable="true"], [role="combobox"], [role="searchbox"]');

    for (const el of inputs) {
      const ph = (el.placeholder || el.getAttribute('aria-label') || '').toLowerCase();
      if (ph.includes(placeholderLower)) {
        try {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.focus();
          el.click();

          if (clear && 'value' in el) {
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }

          await simulateTyping(el, text);
          return { success: true, action: 'type_by_placeholder', placeholder, text };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }
    }

    return { success: false, error: `Aucun champ avec placeholder "${placeholder}"` };
  }

  function pressKey(key) {
    // Mapping des noms de touches
    const keyMap = {
      'Enter': { key: 'Enter', code: 'Enter', keyCode: 13 },
      'Tab': { key: 'Tab', code: 'Tab', keyCode: 9 },
      'Escape': { key: 'Escape', code: 'Escape', keyCode: 27 },
      'Backspace': { key: 'Backspace', code: 'Backspace', keyCode: 8 },
      'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
      'ArrowUp': { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
      'Space': { key: ' ', code: 'Space', keyCode: 32 },
    };

    const keyInfo = keyMap[key] || { key, code: key, keyCode: 0 };
    const target = document.activeElement || document.body;

    try {
      target.dispatchEvent(new KeyboardEvent('keydown', { ...keyInfo, bubbles: true }));
      target.dispatchEvent(new KeyboardEvent('keypress', { ...keyInfo, bubbles: true }));
      target.dispatchEvent(new KeyboardEvent('keyup', { ...keyInfo, bubbles: true }));

      // Si Enter sur un form, soumettre
      if (key === 'Enter') {
        const form = target.closest('form');
        if (form) {
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          // Certains formulaires nécessitent un requestSubmit
          try { form.requestSubmit(); } catch { /* ok */ }
        }
      }

      return { success: true, action: 'press_key', key };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  function scrollPage(direction, amount) {
    window.scrollBy(0, direction === 'down' ? amount : -amount);
    return { success: true, action: 'scroll', direction, amount };
  }

  // ══════════════════════════════════════════════════════════════════
  // 🍪 DISMISS COOKIE POPUPS
  // ══════════════════════════════════════════════════════════════════

  function dismissCookies() {
    const acceptTexts = [
      'Tout accepter', 'Accept all', 'Accepter tout', "J'accepte",
      'I agree', 'Accepter', 'Accept', 'Agree', 'Autoriser',
      'Allow all', 'Tout autoriser', 'Consent',
    ];

    const buttons = document.querySelectorAll('button, a, [role="button"]');
    for (const btn of buttons) {
      const text = (btn.textContent || '').trim();
      for (const accept of acceptTexts) {
        if (text.toLowerCase().includes(accept.toLowerCase())) {
          try {
            btn.click();
            return { success: true, dismissed: true };
          } catch { /* next */ }
        }
      }
    }

    return { success: true, dismissed: false };
  }

})();
