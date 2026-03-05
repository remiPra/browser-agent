// ── Phantom Agent Server v2 ──────────────────────────────────────────
// Serveur Express + WebSocket
// v2 : Support du mode Extension Chrome (3ème mode de connexion)

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import { PhantomAgent } from './core/agent.js';
import { BrowserController } from './core/browser-controller.js';
import { ChromeController } from './core/chrome-controller.js';
import { ExtensionController } from './core/extension-controller.js';
import { CONFIG } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Servir les fichiers statiques
app.use(express.static(join(__dirname, '..', 'public')));

// ══════════════════════════════════════════════════════════════════════
// 🔌 GESTION DES EXTENSIONS CONNECTÉES
// ══════════════════════════════════════════════════════════════════════
let connectedExtension = null; // WebSocket de l'extension Chrome
let extensionController = null; // Le controller associé
let waitingForExtension = []; // Agents qui attendent une extension

function onExtensionConnected(ws, info) {
  console.log('');
  console.log('══════════════════════════════════════════');
  console.log('🧩 Extension Chrome connectée !');
  console.log(`   Agent: ${info.agent} v${info.version}`);
  console.log('══════════════════════════════════════════');
  console.log('');

  connectedExtension = ws;

  // Si un controller attend l'extension → le brancher
  if (extensionController) {
    extensionController.attachExtension(ws);
  }

  // Résoudre les agents en attente
  for (const resolve of waitingForExtension) {
    resolve(ws);
  }
  waitingForExtension = [];

  ws.on('close', () => {
    console.log('🧩 Extension Chrome déconnectée');
    connectedExtension = null;
  });
}

// Attendre qu'une extension se connecte (avec timeout)
function waitForExtensionConnection(timeoutMs = 60000) {
  if (connectedExtension && connectedExtension.readyState === 1) {
    return Promise.resolve(connectedExtension);
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const idx = waitingForExtension.indexOf(resolve);
      if (idx !== -1) waitingForExtension.splice(idx, 1);
      reject(new Error('Timeout : l\'extension Chrome ne s\'est pas connectée (60s). Vérifiez que l\'extension est installée et activée.'));
    }, timeoutMs);

    waitingForExtension.push((ws) => {
      clearTimeout(timeout);
      resolve(ws);
    });
  });
}

// ── API : Vérifier si l'extension est connectée ──
app.get('/api/check-extension', (_req, res) => {
  if (connectedExtension && connectedExtension.readyState === 1) {
    res.json({ ok: true, message: 'Extension connectée' });
  } else {
    res.json({ ok: false });
  }
});

// ── Détection automatique du chemin Chrome (cross-platform) ─────────
function findChromePath() {
  if (CONFIG.CHROME_PATH) return CONFIG.CHROME_PATH;

  const platform = process.platform;
  let candidates = [];

  if (platform === 'win32') {
    candidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
  } else if (platform === 'darwin') {
    candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      join(process.env.HOME || '', 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
    ];
  } else {
    candidates = [
      '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium', '/usr/bin/chromium-browser',
      '/snap/bin/chromium', '/usr/local/bin/google-chrome',
    ];
  }

  for (const p of candidates.filter(Boolean)) {
    if (fs.existsSync(p)) {
      console.log(`🔍 Chrome trouvé : ${p}`);
      return p;
    }
  }

  if (platform !== 'win32') {
    for (const cmd of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
      try {
        const result = execSync(`which ${cmd}`, { encoding: 'utf-8', timeout: 3000 }).trim();
        if (result && fs.existsSync(result)) return result;
      } catch { /* pas trouvé */ }
    }
  }

  return null;
}

async function checkCDP() {
  try {
    const resp = await fetch(`http://${CONFIG.CDP_HOST}:${CONFIG.CDP_PORT}/json/version`);
    if (resp.ok) return await resp.json();
  } catch { /* pas dispo */ }
  return null;
}

function killAllChrome() {
  const platform = process.platform;
  console.log(`🔪 Fermeture de toutes les instances Chrome (${platform})...`);
  try {
    if (platform === 'win32') {
      execSync('taskkill /F /IM chrome.exe /T', { encoding: 'utf-8', timeout: 10000 });
    } else if (platform === 'darwin') {
      execSync('pkill -f "Google Chrome"', { encoding: 'utf-8', timeout: 5000 });
    } else {
      try { execSync('pkill -f chrome', { encoding: 'utf-8', timeout: 5000 }); } catch { /* ok */ }
      try { execSync('pkill -f chromium', { encoding: 'utf-8', timeout: 5000 }); } catch { /* ok */ }
    }
    console.log('✅ Processus Chrome fermés');
    return { success: true };
  } catch (err) {
    if (err.message && (err.message.includes('not found') || err.message.includes('introuvable') || err.message.includes('No matching'))) {
      console.log('ℹ️  Aucun processus Chrome trouvé');
      return { success: true };
    }
    if (err.status === 128 || err.status === 1) {
      console.log('ℹ️  Aucun processus Chrome en cours');
      return { success: true };
    }
    return { success: true };
  }
}

async function waitForChromeKilled(maxWaitMs = 5000) {
  const interval = 300;
  let elapsed = 0;
  while (elapsed < maxWaitMs) {
    await new Promise(r => setTimeout(r, interval));
    elapsed += interval;
    try {
      if (process.platform === 'win32') {
        const result = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', { encoding: 'utf-8', timeout: 3000 });
        if (!result.includes('chrome.exe')) return true;
      } else {
        execSync('pgrep -f chrome', { encoding: 'utf-8', timeout: 3000 });
      }
    } catch { return true; }
  }
  return false;
}

// ── API CDP ──
app.get('/api/check-cdp', async (_req, res) => {
  const data = await checkCDP();
  if (data) res.json({ ok: true, browser: data.Browser || 'Chrome' });
  else res.json({ ok: false });
});

app.post('/api/launch-chrome', async (_req, res) => {
  const existing = await checkCDP();
  if (existing) return res.json({ ok: true, message: 'Chrome CDP deja disponible', browser: existing.Browser });

  const chromePath = findChromePath();
  if (!chromePath) {
    return res.json({ ok: false, error: `Chrome introuvable. Définissez CHROME_PATH dans .env` });
  }

  killAllChrome();
  await waitForChromeKilled(5000);
  await new Promise(r => setTimeout(r, 1500));

  try {
    const child = spawn(chromePath, [
      `--remote-debugging-port=${CONFIG.CDP_PORT}`,
      '--no-first-run', '--no-default-browser-check', '--restore-last-session',
    ], { detached: true, stdio: 'ignore' });
    child.unref();
    child.on('error', (err) => console.error(`❌ Erreur spawn Chrome: ${err.message}`));
  } catch (err) {
    return res.json({ ok: false, error: `Impossible de lancer Chrome: ${err.message}` });
  }

  const maxWait = 15000, interval = 500;
  let elapsed = 0;
  while (elapsed < maxWait) {
    await new Promise(r => setTimeout(r, interval));
    elapsed += interval;
    const data = await checkCDP();
    if (data) return res.json({ ok: true, message: 'Chrome relancé avec CDP', browser: data.Browser });
  }

  res.json({ ok: false, error: 'Chrome lancé mais CDP ne répond pas après 15s. Réessayez.' });
});

// ══════════════════════════════════════════════════════════════════════
// 🔌 WEBSOCKET HANDLER
// ══════════════════════════════════════════════════════════════════════

wss.on('connection', (ws) => {
  console.log('🔌 Nouvelle connexion WebSocket');

  let agent = null;
  let isExtensionWs = false;

  const send = (type, data) => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type, data }));
  };

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      // ── Détection : c'est l'extension Chrome ? ──
      if (msg.type === 'extension_connect') {
        isExtensionWs = true;
        onExtensionConnected(ws, msg);
        return;
      }

      // ── Résultat de commande extension (routé par le background) ──
      if (msg.type === 'cmd_result' || msg.type === 'pong') {
        // Géré directement par le ExtensionController.attachExtension()
        return;
      }

      // ── Messages du client web ──
      switch (msg.type) {
        case 'init': {
          const mode = msg.mode || 'builtin';
          console.log(`🎛️  Mode sélectionné : ${mode}`);

          let controller;

          if (mode === 'extension') {
            // Mode Extension Chrome
            controller = new ExtensionController();
            extensionController = controller;

            send('status', { status: 'ready', message: '⏳ En attente de l\'extension Chrome...' });

            // Vérifier si l'extension est déjà connectée
            if (connectedExtension && connectedExtension.readyState === 1) {
              controller.attachExtension(connectedExtension);
              send('status', { status: 'ready', message: '🧩 Extension Chrome connectée !' });
            } else {
              send('status', { status: 'running', message: '⏳ Ouvrez Chrome et activez l\'extension Phantom Agent...' });
              try {
                const extWs = await waitForExtensionConnection(60000);
                controller.attachExtension(extWs);
                send('status', { status: 'ready', message: '🧩 Extension Chrome connectée !' });
              } catch (err) {
                send('error', { message: err.message });
                return;
              }
            }

            agent = new PhantomAgent(controller, send);
            // Pas besoin de agent.init() car launch() ne fait rien en mode extension
            agent.browser = controller;
            // Remplacer l'observer par un compatible extension
            const { DOMObserverUniversal } = await import('./core/dom-observer-universal.js');
            agent.observer = new DOMObserverUniversal(controller);

          } else if (mode === 'chrome') {
            controller = new ChromeController();
            agent = new PhantomAgent(controller, send);
            try {
              await agent.init();
            } catch (err) {
              send('error', { message: `Erreur initialisation Chrome CDP: ${err.message}` });
            }
          } else {
            // Mode Playwright intégré (builtin)
            controller = new BrowserController();
            agent = new PhantomAgent(controller, send);
            try {
              await agent.init();
            } catch (err) {
              send('error', { message: `Erreur initialisation Playwright: ${err.message}` });
            }
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
    if (isExtensionWs) {
      console.log('🧩 Extension WebSocket fermé');
      return;
    }
    console.log('🔌 Client déconnecté');
    if (agent) await agent.shutdown();
  });
});

// ── Lancement ────────────────────────────────────────────────────────
server.listen(CONFIG.PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║         🤖 PHANTOM AGENT v0.2.0             ║');
  console.log('║     AI-Powered Browser Automation Agent      ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  🌐 Interface : http://localhost:${CONFIG.PORT}         ║`);
  console.log(`║  👁️  Headless  : ${CONFIG.HEADLESS ? 'Oui' : 'Non (navigateur visible)'}       ║`);
  console.log(`║  🧠 Modèle    : ${CONFIG.ZAI_MODEL.slice(0, 24).padEnd(24)}  ║`);
  console.log(`║  💻 Plateforme: ${process.platform.padEnd(24)}  ║`);
  console.log('╠══════════════════════════════════════════════╣');
  console.log('║  Modes :                                     ║');
  console.log('║  🌐 Chromium Playwright (intégré)             ║');
  console.log('║  🟡 Chrome CDP (DevTools Protocol)            ║');
  console.log('║  🧩 Extension Chrome (NOUVEAU !)              ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
});
