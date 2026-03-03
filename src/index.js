// ── Phantom Agent Server ─────────────────────────────────────────────
// Serveur Express + WebSocket pour l'interface web temps réel

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { PhantomAgent } from './core/agent.js';
import { CONFIG } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Servir les fichiers statiques
app.use(express.static(join(__dirname, '..', 'public')));

// ── WebSocket Handler ────────────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('🔌 Client connecté');
  
  // Créer un agent pour cette connexion
  const agent = new PhantomAgent((type, data) => {
    // Callback : envoyer les événements au client via WebSocket
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type, data }));
    }
  });

  // Initialiser l'agent
  agent.init().catch(err => {
    ws.send(JSON.stringify({ type: 'error', data: { message: err.message } }));
  });

  // Recevoir les messages du client
  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      switch (msg.type) {
        case 'task':
          // Lancer une nouvelle tâche
          await agent.executeTask(msg.task);
          break;

        case 'stop':
          // Arrêter la tâche en cours
          agent.stop();
          break;

        case 'navigate':
          // Navigation directe
          if (agent.browser.isReady) {
            const result = await agent.browser.goto(msg.url);
            const screenshot = await agent.browser.screenshot();
            ws.send(JSON.stringify({
              type: 'screenshot',
              data: { image: screenshot, url: msg.url, title: result.title }
            }));
          }
          break;

        case 'save_session':
          // Sauvegarder la session
          if (agent.browser.isReady) {
            const result = await agent.browser.saveSession();
            ws.send(JSON.stringify({
              type: 'session_saved',
              data: result
            }));
          }
          break;

        case 'screenshot_request':
          // Prendre un screenshot (pour le mode manuel)
          if (agent.browser.isReady) {
            const screenshot = await agent.browser.screenshot();
            const pageInfo = await agent.browser.getPageInfo();
            ws.send(JSON.stringify({
              type: 'screenshot',
              data: { image: screenshot, url: pageInfo.url, title: pageInfo.title }
            }));
          }
          break;

        default:
          console.log('Message inconnu:', msg.type);
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', data: { message: err.message } }));
    }
  });

  ws.on('close', async () => {
    console.log('🔌 Client déconnecté');
    await agent.shutdown();
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
  console.log(`║  🧠 Modèle    : ${CONFIG.CLAUDE_MODEL.slice(0, 24).padEnd(24)}  ║`);
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
});
