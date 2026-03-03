// ── Phantom Agent Configuration ──────────────────────────────────────
// Copie ce fichier en .env ou modifie directement les valeurs ici

export const CONFIG = {
  // ── API Claude ──
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || 'YOUR_API_KEY_HERE',
  CLAUDE_MODEL: process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20250929',

  // ── Browser ──
  HEADLESS: process.env.HEADLESS === 'true' || false,
  VIEWPORT: { width: 1280, height: 800 },
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  DEFAULT_TIMEOUT: 30_000,
  SESSION_DIR: './sessions',
  SESSION_FILE: 'default.json',
  
  // ── Server ──
  PORT: parseInt(process.env.PORT || '3001'),
  
  // ── Agent ──
  MAX_STEPS: 25,           // Max d'actions par tâche
  SCREENSHOT_QUALITY: 75,  // Qualité JPEG des screenshots
  DOM_MAX_DEPTH: 8,        // Profondeur max d'extraction DOM
  DOM_MAX_ELEMENTS: 150,   // Nombre max d'éléments interactifs extraits

  // ── Simulation humaine (anti-détection bot) ──
  HUMAN_TYPING: {
    MIN_DELAY: 80,           // Délai min entre touches (ms)
    MAX_DELAY: 180,          // Délai max entre touches (ms)
    TYPO_CHANCE: 0.05,       // 5% de chance de faire une erreur de frappe
    PAUSE_CHANCE: 0.03,      // 3% de chance de faire une pause d'hésitation
    PAUSE_DURATION: [300, 800], // Durée des pauses d'hésitation (min, max)
  },
};
