// ── Phantom Agent Server ─────────────────────────────────────────────
// Serveur Express + WebSocket pour l'interface web temps réel

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import fs from 'fs';
import { PhantomAgent } from './core/agent.js';
import { BrowserController } from './core/browser-controller.js';
import { ChromeController } from './core/chrome-controller.js';
import { CONFIG } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Servir les fichiers statiques
app.use(express.static(join(__dirname, '..', 'public')));

// ── Détection automatique du chemin Chrome ──────────────────────────
function findChromePath() {
  if (CONFIG.CHROME_PATH) return CONFIG.CHROME_PATH;
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ── API : vérifier si CDP est disponible ────────────────────────────
app.get('/api/check-cdp', async (_req, res) => {
  try {
    const resp = await fetch(`http://${CONFIG.CDP_HOST}:${CONFIG.CDP_PORT}/json/version`);
    const data = await resp.json();
    res.json({ ok: true, browser: data.Browser || 'Chrome' });
  } catch {
    res.json({ ok: false });
  }
});

// ── API : lancer Chrome avec CDP ────────────────────────────────────
app.post('/api/launch-chrome', async (_req, res) => {
  // 1. Vérifier si CDP est déjà dispo
  try {
    const resp = await fetch(`http://${CONFIG.CDP_HOST}:${CONFIG.CDP_PORT}/json/version`);
    if (resp.ok) {
      const data = await resp.json();
      return res.json({ ok: true, message: 'Chrome CDP deja disponible', browser: data.Browser });
    }
  } catch { /* pas dispo, on lance */ }

  // 2. Trouver Chrome
  const chromePath = findChromePath();
  if (!chromePath) {
    return res.json({ ok: false, error: 'Chrome introuvable. Definissez CHROME_PATH dans .env' });
  }

  // 3. Lancer Chrome avec le flag CDP
  console.log(`🚀 Lancement de Chrome : ${chromePath}`);
  try {
    const child = spawn(chromePath, [
      `--remote-debugging-port=${CONFIG.CDP_PORT}`,
    ], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (err) {
    return res.json({ ok: false, error: `Impossible de lancer Chrome: ${err.message}` });
  }

  // 4. Attendre que CDP soit prêt (poll pendant 8s max)
  const maxWait = 8000;
  const interval = 300;
  let elapsed = 0;
  while (elapsed < maxWait) {
    await new Promise(r => setTimeout(r, interval));
    elapsed += interval;
    try {
      const resp = await fetch(`http://${CONFIG.CDP_HOST}:${CONFIG.CDP_PORT}/json/version`);
      if (resp.ok) {
        const data = await resp.json();
        console.log('✅ Chrome CDP pret !');
        return res.json({ ok: true, message: 'Chrome lance avec CDP', browser: data.Browser });
      }
    } catch { /* pas encore pret */ }
  }

  res.json({ ok: false, error: 'Chrome lance mais CDP ne repond pas. Fermez toutes les instances de Chrome et reessayez.' });
});

// ── WebSocket Handler ────────────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('🔌 Client connecté');

  let agent = null;

  // Fonction utilitaire pour envoyer un message au client
  const send = (type, data) => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type, data }));
    }
  };

  // Recevoir les messages du client
  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      switch (msg.type) {
        case 'init': {
          // Créer le controller selon le mode choisi
          const mode = msg.mode || 'builtin';
          console.log(`🎛️  Mode sélectionné : ${mode}`);

          const controller = mode === 'chrome'
            ? new ChromeController()
            : new BrowserController();

          agent = new PhantomAgent(controller, send);

          try {
            await agent.init();
          } catch (err) {
            send('error', { message: `Erreur initialisation (${mode}): ${err.message}` });
          }
          break;
        }

        case 'task':
          if (!agent) { send('error', { message: 'Agent non initialisé' }); break; }
          await agent.executeTask(msg.task);
          break;

        case 'stop':
          if (agent) agent.stop();
          break;

        case 'navigate':
          if (agent && agent.browser.isReady) {
            const result = await agent.browser.goto(msg.url);
            const screenshot = await agent.browser.screenshot();
            send('screenshot', { image: screenshot, url: msg.url, title: result.title });
          }
          break;

        case 'save_session':
          if (agent && agent.browser.isReady) {
            const result = await agent.browser.saveSession();
            send('session_saved', result);
          }
          break;

        case 'screenshot_request':
          if (agent && agent.browser.isReady) {
            const screenshot = await agent.browser.screenshot();
            const pageInfo = await agent.browser.getPageInfo();
            send('screenshot', { image: screenshot, url: pageInfo.url, title: pageInfo.title });
          }
          break;

        default:
          console.log('Message inconnu:', msg.type);
      }
    } catch (err) {
      send('error', { message: err.message });
    }
  });

  ws.on('close', async () => {
    console.log('🔌 Client déconnecté');
    if (agent) await agent.shutdown();
  });
});

// ── Lancement ────────────────────────────────────────────────────────
server.listen(CONFIG.PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║         🤖 PHANTOM AGENT v0.1.0             ║');
  console.log('║     AI-Powered Browser Automation Agent      ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  🌐 Interface : http://localhost:${CONFIG.PORT}         ║`);
  console.log(`║  👁️  Headless  : ${CONFIG.HEADLESS ? 'Oui' : 'Non (navigateur visible)'}       ║`);
  console.log(`║  🧠 Modèle    : ${CONFIG.ZAI_MODEL.slice(0, 24).padEnd(24)}  ║`);
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
});
