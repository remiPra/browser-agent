// ── Extension Controller ─────────────────────────────────────────────
// Contrôle le navigateur via l'extension Chrome Phantom Agent
// Communique par WebSocket — même interface que BrowserController

import { CONFIG } from '../config.js';

export class ExtensionController {
  constructor() {
    this.extensionWs = null;  // WebSocket de l'extension
    this.isReady = false;
    this.page = null; // Proxy pour compatibilité
    this._cmdId = 0;
    this._pendingCmds = new Map(); // id → { resolve, reject, timeout }
  }

  // ── Attacher le WebSocket de l'extension ────────────────────────
  attachExtension(ws) {
    this.extensionWs = ws;
    this.isReady = true;

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'cmd_result' && msg.id != null) {
          const pending = this._pendingCmds.get(msg.id);
          if (pending) {
            clearTimeout(pending.timeout);
            this._pendingCmds.delete(msg.id);
            pending.resolve(msg);
          }
        }
      } catch (err) {
        console.error('❌ ExtensionController message invalide:', err);
      }
    });

    ws.on('close', () => {
      console.log('🔌 Extension déconnectée');
      this.isReady = false;
      this.extensionWs = null;
      // Rejeter toutes les commandes en attente
      for (const [id, pending] of this._pendingCmds) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('Extension déconnectée'));
      }
      this._pendingCmds.clear();
    });

    console.log('✅ Extension Chrome connectée au controller');
  }

  // ── Envoyer une commande et attendre la réponse ─────────────────
  _sendCmd(type, data = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.extensionWs || this.extensionWs.readyState !== 1) {
        return reject(new Error('Extension non connectée'));
      }

      const id = ++this._cmdId;
      const timeout = setTimeout(() => {
        this._pendingCmds.delete(id);
        reject(new Error(`Timeout commande ${type} (${timeoutMs}ms)`));
      }, timeoutMs);

      this._pendingCmds.set(id, { resolve, reject, timeout });
      this.extensionWs.send(JSON.stringify({ type, id, ...data }));
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // INTERFACE COMPATIBLE BrowserController
  // ══════════════════════════════════════════════════════════════════

  async launch() {
    // Rien à lancer — on attend que l'extension se connecte
    console.log('⏳ ExtensionController : en attente de connexion de l\'extension Chrome...');
    // On ne bloque pas — l'extension se connectera quand elle est prête
    return null;
  }

  async goto(url) {
    if (!url.startsWith('http')) url = 'https://' + url;
    console.log(`📍 [Extension] Navigation vers : ${url}`);
    try {
      const result = await this._sendCmd('cmd_goto', { url }, 20000);
      return { success: result.success, url: result.url, title: result.title, error: result.error };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async clickByIndex(index) {
    console.log(`🖱️  [Extension] Clic sur [${index}]`);
    try {
      const result = await this._sendCmd('cmd_click', { index });
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async clickByText(text) {
    console.log(`🖱️  [Extension] Clic sur texte : "${text}"`);
    try {
      const result = await this._sendCmd('cmd_click_by_text', { text });
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async click(selector) {
    // Fallback : essayer par texte si c'est un sélecteur simple
    console.log(`🖱️  [Extension] Clic CSS (via texte) : ${selector}`);
    return await this.clickByText(selector);
  }

  async typeByIndex(index, text, options = {}) {
    console.log(`⌨️  [Extension] Saisie [${index}] : "${text}"`);
    try {
      const result = await this._sendCmd('cmd_type', { index, text, clear: options.clear || false });
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async typeByPlaceholder(placeholder, text, options = {}) {
    console.log(`⌨️  [Extension] Saisie placeholder "${placeholder}" : "${text}"`);
    try {
      const result = await this._sendCmd('cmd_type_by_placeholder', { placeholder, text, clear: options.clear || false });
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async type(selector, text, options = {}) {
    console.log(`⌨️  [Extension] Saisie CSS : "${text}"`);
    // Pas de sélecteur CSS possible via l'extension, fallback par placeholder
    return await this.typeByPlaceholder(selector, text, options);
  }

  async pressKey(key) {
    console.log(`⌨️  [Extension] Touche : ${key}`);
    try {
      const result = await this._sendCmd('cmd_press_key', { key });
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async scroll(direction = 'down', amount = 500) {
    console.log(`📜 [Extension] Scroll ${direction} (${amount}px)`);
    try {
      const result = await this._sendCmd('cmd_scroll', { direction, amount });
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async wait(ms = 2000) {
    console.log(`⏳ [Extension] Attente ${ms}ms...`);
    try {
      const result = await this._sendCmd('cmd_wait', { duration: ms }, ms + 5000);
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async goBack() {
    console.log('⬅️  [Extension] Retour');
    try {
      const result = await this._sendCmd('cmd_go_back');
      return { success: result.success, action: 'go_back', url: result.url };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async select(selector, value) {
    console.log(`📋 [Extension] Sélection "${value}"`);
    return { success: false, error: 'select() non supporté en mode extension' };
  }

  async hover(selector) {
    console.log(`🎯 [Extension] Hover`);
    return { success: false, error: 'hover() non supporté en mode extension' };
  }

  async screenshot() {
    try {
      const result = await this._sendCmd('cmd_screenshot', {}, 10000);
      if (result.success && result.image) {
        return result.image; // base64
      }
      return null;
    } catch (err) {
      console.error('❌ Screenshot échoué:', err.message);
      return null;
    }
  }

  async getPageInfo() {
    try {
      const result = await this._sendCmd('cmd_page_info', {}, 5000);
      return { url: result.url || 'about:blank', title: result.title || '' };
    } catch {
      return { url: 'about:blank', title: '' };
    }
  }

  // ── Tag & Extract (pour le DOMObserver) ──
  async tagAndExtract(maxElements) {
    try {
      const result = await this._sendCmd('cmd_tag_extract', { maxElements }, 10000);
      return result.elements || [];
    } catch (err) {
      console.error('❌ Tag & Extract échoué:', err.message);
      return [];
    }
  }

  // ── Extract structured content ──
  async extractStructuredContent(maxChars) {
    try {
      const result = await this._sendCmd('cmd_extract_content', { maxChars }, 10000);
      return result.content || {
        headings: [], paragraphs: [], lists: [], searchResults: [],
        mainContent: '', metadata: { hasForm: false, hasLogin: false, hasSearch: false, pageType: 'other' }
      };
    } catch (err) {
      console.error('❌ Extract content échoué:', err.message);
      return {
        headings: [], paragraphs: [], lists: [], searchResults: [],
        mainContent: '', metadata: { hasForm: false, hasLogin: false, hasSearch: false, pageType: 'other' }
      };
    }
  }

  // ── Cookie popup (géré par l'extension) ──
  async tryDismissCookiePopup() {
    return false;
  }

  // ── Session ──
  async saveSession() {
    return { success: false, error: 'Mode Extension : la session est gérée par Chrome' };
  }

  async close() {
    // Ne pas fermer Chrome — juste déconnecter
    if (this.extensionWs) {
      try { this.extensionWs.close(); } catch { /* ok */ }
    }
    this.extensionWs = null;
    this.isReady = false;
    console.log('🔌 ExtensionController fermé');
  }
}
