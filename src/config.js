// ── Phantom Agent Configuration ──────────────────────────────────────
// Mets tes clés dans le fichier .env à la racine du projet

import 'dotenv/config';

export const CONFIG = {
  // ── API Z.ai (Zhipu GLM) ──
  ZAI_API_KEY: process.env.ZAI_API_KEY || 'YOUR_API_KEY_HERE',
  ZAI_MODEL: process.env.ZAI_MODEL || 'GLM-4.7',
  ZAI_VISION_MODEL: process.env.ZAI_VISION_MODEL || 'GLM-4.6V',
  ZAI_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4',

  // ── Browser ──
  HEADLESS: process.env.HEADLESS === 'true' || false,
  VIEWPORT: { width: 1280, height: 800 },
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  DEFAULT_TIMEOUT: 30_000,
  SESSION_DIR: './sessions',
  SESSION_FILE: 'default.json',
  
  // ── Chrome CDP (mode "Mon Chrome") ──
  CDP_PORT: parseInt(process.env.CDP_PORT || '9222'),
  CDP_HOST: process.env.CDP_HOST || '127.0.0.1',
  CHROME_PATH: process.env.CHROME_PATH || '',  // Auto-detecté si vide

  // ── Server ──
  PORT: parseInt(process.env.PORT || '3001'),
  
  // ── Agent ──
  MAX_STEPS: 25,              // Max d'actions par tâche
  SCREENSHOT_QUALITY: 75,     // Qualité JPEG des screenshots
  DOM_MAX_DEPTH: 8,           // Profondeur max d'extraction DOM
  DOM_MAX_ELEMENTS: 150,      // Nombre max d'éléments interactifs extraits
  CONTENT_MAX_CHARS: 8000,    // Limite texte contenu structuré
  MAX_TOKENS_DECIDER: 2048,   // Tokens max pour la réponse du décideur

  // ── Simulation humaine (anti-détection bot) ──
  HUMAN_TYPING: {
    MIN_DELAY: 80,           // Délai min entre touches (ms)
    MAX_DELAY: 180,          // Délai max entre touches (ms)
    TYPO_CHANCE: 0.05,       // 5% de chance de faire une erreur de frappe
    PAUSE_CHANCE: 0.03,      // 3% de chance de faire une pause d'hésitation
    PAUSE_DURATION: [300, 800], // Durée des pauses d'hésitation (min, max)
  },
};
