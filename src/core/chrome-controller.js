// ── Chrome Controller (CDP) ──────────────────────────────────────────
// Se connecte au Chrome existant de l'utilisateur via Chrome DevTools Protocol
// Herite de BrowserController — seuls launch() et close() changent

import { chromium } from 'playwright';
import { BrowserController } from './browser-controller.js';
import { CONFIG } from '../config.js';

export class ChromeController extends BrowserController {
  constructor() {
    super();
  }

  // ── Connexion au Chrome existant via CDP ───────────────────────────
  async connectToChrome(port = CONFIG.CDP_PORT) {
    const host = CONFIG.CDP_HOST;
    const cdpUrl = `http://${host}:${port}`;
    console.log(`🔌 Connexion au Chrome existant via CDP : ${cdpUrl}...`);

    this.browser = await chromium.connectOverCDP(cdpUrl);
    this.context = this.browser.contexts()[0];

    if (!this.context) {
      throw new Error('Aucun contexte trouve dans Chrome. Verifiez que Chrome est bien lance.');
    }

    const pages = this.context.pages();
    this.page = pages.length > 0 ? pages[0] : await this.context.newPage();
    this.page.setDefaultTimeout(CONFIG.DEFAULT_TIMEOUT);

    this.isReady = true;
    console.log('✅ Connecte au Chrome de l\'utilisateur (CDP) !');
    return this.page;
  }

  // ── Override launch() pour rediriger vers connectToChrome() ────────
  async launch() {
    return this.connectToChrome();
  }

  // ── Fermeture : deconnecter sans fermer Chrome ─────────────────────
  async close() {
    if (this.browser) {
      // Pas de sauvegarde de session (Chrome gere ses propres cookies)
      // Pas de browser.close() (on ne ferme pas le Chrome de l'utilisateur)
      try {
        this.browser.close();
      } catch {
        // Ignore les erreurs de deconnexion
      }
      this.browser = null;
      this.context = null;
      this.page = null;
      this.isReady = false;
      console.log('🔌 Deconnecte du Chrome utilisateur (CDP)');
    }
  }

  // ── Pas de persistence de session pour le mode CDP ─────────────────
  async saveSession() {
    return { success: false, error: 'Mode Chrome CDP : la session est geree par Chrome' };
  }
}
