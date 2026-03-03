// ── Phantom Agent Server ─────────────────────────────────────────────
// Serveur Express + WebSocket pour l'interface web temps réel

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
import { CONFIG } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Servir les fichiers statiques
app.use(express.static(join(__dirname, '..', 'public')));

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
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
      '/usr/local/bin/google-chrome',
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

// ── Helper : vérifier si le port CDP est déjà écouté ────────────────
async function checkCDP() {
  try {
    const resp = await fetch(`http://${CONFIG.CDP_HOST}:${CONFIG.CDP_PORT}/json/version`);
    if (resp.ok) return await resp.json();
  } catch { /* pas dispo */ }
  return null;
}

// ══════════════════════════════════════════════════════════════════════
// 🔪 KILL CHROME — Ferme toutes les instances Chrome proprement
// ══════════════════════════════════════════════════════════════════════
function killAllChrome() {
  const platform = process.platform;
  console.log(`🔪 Fermeture de toutes les instances Chrome (${platform})...`);

  try {
    if (platform === 'win32') {
      // /F = force, /IM = image name, /T = arbre de processus
      execSync('taskkill /F /IM chrome.exe /T', { encoding: 'utf-8', timeout: 10000 });
    } else if (platform === 'darwin') {
      execSync('pkill -f "Google Chrome"', { encoding: 'utf-8', timeout: 5000 });
    } else {
      // Linux : essayer chrome puis chromium
      try { execSync('pkill -f chrome', { encoding: 'utf-8', timeout: 5000 }); } catch { /* ok */ }
      try { execSync('pkill -f chromium', { encoding: 'utf-8', timeout: 5000 }); } catch { /* ok */ }
    }
    console.log('✅ Processus Chrome fermés');
    return { success: true };
  } catch (err) {
    // taskkill retourne une erreur si aucun processus trouvé — c'est OK
    if (err.message && (err.message.includes('not found') || err.message.includes('introuvable') || err.message.includes('No matching'))) {
      console.log('ℹ️  Aucun processus Chrome trouvé (déjà fermé)');
      return { success: true };
    }
    // Sur Windows, code de retour 128 = processus introuvable = OK
    if (err.status === 128 || err.status === 1) {
      console.log('ℹ️  Aucun processus Chrome en cours');
      return { success: true };
    }
    console.log(`⚠️  Kill Chrome: ${err.message} (on continue quand même)`);
    return { success: true }; // On continue même en cas d'erreur
  }
}

// ── Vérifier que Chrome est bien fermé ──────────────────────────────
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
        // Si pgrep réussit → chrome tourne encore
      }
    } catch {
      // pgrep échoue = aucun processus = c'est bon !
      return true;
    }
  }

  return false; // Timeout — on tente quand même
}

// ── API : vérifier si CDP est disponible ────────────────────────────
app.get('/api/check-cdp', async (_req, res) => {
  const data = await checkCDP();
  if (data) {
    res.json({ ok: true, browser: data.Browser || 'Chrome' });
  } else {
    res.json({ ok: false });
  }
});

// ══════════════════════════════════════════════════════════════════════
// 🚀 API : lancer Chrome avec CDP (auto-kill + relaunch)
// ══════════════════════════════════════════════════════════════════════
app.post('/api/launch-chrome', async (_req, res) => {
  // 1. Vérifier si CDP est déjà dispo
  const existing = await checkCDP();
  if (existing) {
    return res.json({ ok: true, message: 'Chrome CDP deja disponible', browser: existing.Browser });
  }

  // 2. Trouver Chrome
  const chromePath = findChromePath();
  if (!chromePath) {
    const hint = process.platform === 'win32'
      ? 'Definissez CHROME_PATH dans .env'
      : 'Installez Chrome ou Chromium, ou definissez CHROME_PATH dans .env';
    return res.json({
      ok: false,
      error: `Chrome introuvable (${process.platform}). ${hint}`,
    });
  }

  // 3. ⚡ KILL — Fermer TOUTES les instances Chrome existantes
  console.log('');
  console.log('═══ Relancement Chrome avec CDP ═══');
  killAllChrome();

  // 4. Attendre que Chrome soit bien fermé
  console.log('⏳ Attente fermeture complète...');
  await waitForChromeKilled(5000);

  // Petite pause de sécurité (Windows libère les locks de fichier lentement)
  await new Promise(r => setTimeout(r, 1500));

  // 5. Relancer Chrome avec le flag CDP
  console.log(`🚀 Lancement : ${chromePath} --remote-debugging-port=${CONFIG.CDP_PORT}`);
  try {
    const args = [
      `--remote-debugging-port=${CONFIG.CDP_PORT}`,
      '--no-first-run',
      '--no-default-browser-check',
      // Restaurer les onglets de la session précédente
      '--restore-last-session',
    ];

    const child = spawn(chromePath, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    child.on('error', (err) => {
      console.error(`❌ Erreur spawn Chrome: ${err.message}`);
    });
  } catch (err) {
    return res.json({ ok: false, error: `Impossible de lancer Chrome: ${err.message}` });
  }

  // 6. Attendre que CDP soit prêt (poll pendant 15s max)
  const maxWait = 15000;
  const interval = 500;
  let elapsed = 0;
  while (elapsed < maxWait) {
    await new Promise(r => setTimeout(r, interval));
    elapsed += interval;
    const data = await checkCDP();
    if (data) {
      console.log(`✅ Chrome CDP prêt ! (${elapsed}ms)`);
      console.log('═══════════════════════════════════');
      return res.json({ ok: true, message: 'Chrome relance avec CDP', browser: data.Browser });
    }
  }

  res.json({
    ok: false,
    error: 'Chrome lance mais CDP ne repond pas apres 15s. Reessayez.',
  });
});

// ── WebSocket Handler ────────────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('🔌 Client connecté');

  let agent = null;

  const send = (type, data) => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type, data }));
    }
  };

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      switch (msg.type) {
        case 'init': {
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
  console.log(`║  💻 Plateforme: ${process.platform.padEnd(24)}  ║`);
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');

  const chromePath = findChromePath();
  if (chromePath) {
    console.log(`🔍 Chrome détecté : ${chromePath}`);
    console.log(`   Le mode "Mon Chrome" va auto-kill + relancer Chrome avec CDP`);
  } else {
    console.log('⚠️  Chrome non détecté. Définissez CHROME_PATH dans .env');
  }
  console.log('');
});
