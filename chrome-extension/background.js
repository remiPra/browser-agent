// ── Phantom Agent — Extension Background Service Worker ───────────────
// Pont WebSocket entre le serveur Phantom Agent et les content scripts
// v2 : Fix screenshots — capture le bon onglet via debugger API

const PHANTOM_WS_URL = 'ws://localhost:3001';
let ws = null;
let isConnected = false;
let reconnectTimer = null;
let activeTabId = null;
let debuggerAttached = new Set(); // Tabs avec debugger attaché

// ══════════════════════════════════════════════════════════════════════
// 🔌 CONNEXION WEBSOCKET AU SERVEUR PHANTOM
// ══════════════════════════════════════════════════════════════════════

function connect() {
  if (ws && ws.readyState <= 1) return;

  console.log('🔌 Connexion au serveur Phantom...');
  
  try {
    ws = new WebSocket(PHANTOM_WS_URL);
  } catch (err) {
    console.error('❌ Impossible de créer WebSocket:', err);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('✅ Connecté au serveur Phantom !');
    isConnected = true;
    clearTimeout(reconnectTimer);

    ws.send(JSON.stringify({ 
      type: 'extension_connect',
      agent: 'phantom-chrome-extension',
      version: '2.0.0'
    }));

    updateBadge('ON', '#00e676');
    chrome.runtime.sendMessage({ type: 'status', connected: true }).catch(() => {});
  };

  ws.onclose = () => {
    console.log('❌ Déconnecté du serveur Phantom');
    isConnected = false;
    updateBadge('OFF', '#ff5252');
    chrome.runtime.sendMessage({ type: 'status', connected: false }).catch(() => {});
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error('❌ Erreur WebSocket:', err);
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleServerCommand(msg);
    } catch (err) {
      console.error('❌ Message invalide:', err);
    }
  };
}

function disconnect() {
  clearTimeout(reconnectTimer);
  if (ws) { ws.close(); ws = null; }
  isConnected = false;
  updateBadge('OFF', '#ff5252');
  // Détacher tous les debuggers
  for (const tabId of debuggerAttached) {
    try { chrome.debugger.detach({ tabId }); } catch {}
  }
  debuggerAttached.clear();
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (!isConnected) connect();
  }, 3000);
}

function sendToServer(msg) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
  }
}

function updateBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

// ══════════════════════════════════════════════════════════════════════
// 📸 SCREENSHOT — Capture d'un onglet spécifique
// ══════════════════════════════════════════════════════════════════════

// Méthode 1 : Via chrome.debugger (capture n'importe quel onglet, même en arrière-plan)
async function captureTabViaDebugger(tabId) {
  // Attacher le debugger si pas déjà fait
  if (!debuggerAttached.has(tabId)) {
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
      debuggerAttached.add(tabId);
    } catch (err) {
      // Si le debugger est déjà attaché par un autre, continuer
      if (!err.message.includes('Already attached')) {
        throw err;
      }
      debuggerAttached.add(tabId);
    }
  }

  // Capturer via CDP
  const result = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
    format: 'jpeg',
    quality: 75,
  });

  return result.data; // base64
}

// Méthode 2 : Fallback via captureVisibleTab (si debugger échoue)
async function captureTabFallback(tabId) {
  const tab = await chrome.tabs.get(tabId);
  
  // S'assurer que l'onglet est actif dans sa fenêtre
  const [currentActive] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  const needSwitch = currentActive && currentActive.id !== tabId;
  
  if (needSwitch) {
    await chrome.tabs.update(tabId, { active: true });
    await sleep(150); // Laisser le temps au rendu
  }

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 75 });
  
  // Restaurer l'onglet précédent si on a switché
  if (needSwitch && currentActive) {
    await chrome.tabs.update(currentActive.id, { active: true });
  }

  return dataUrl.replace(/^data:image\/\w+;base64,/, '');
}

// Capture intelligente : essaie debugger d'abord, puis fallback
async function captureTab(tabId) {
  try {
    return await captureTabViaDebugger(tabId);
  } catch (err) {
    console.warn('⚠️ Debugger capture failed, using fallback:', err.message);
    try {
      return await captureTabFallback(tabId);
    } catch (err2) {
      console.error('❌ Both capture methods failed:', err2.message);
      return null;
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
// 📨 TRAITEMENT DES COMMANDES DU SERVEUR PHANTOM
// ══════════════════════════════════════════════════════════════════════

async function handleServerCommand(msg) {
  console.log('📨 Commande serveur:', msg.type);

  switch (msg.type) {
    // ── Navigation ──
    case 'cmd_goto': {
      try {
        let url = msg.url;
        if (!url.startsWith('http')) url = 'https://' + url;
        
        const tabId = await getActiveTabId();
        
        // Détacher debugger avant navigation (Chrome le require)
        if (debuggerAttached.has(tabId)) {
          try { await chrome.debugger.detach({ tabId }); } catch {}
          debuggerAttached.delete(tabId);
        }
        
        await chrome.tabs.update(tabId, { url });
        await waitForTabLoad(tabId, 15000);
        await sleep(1500);
        
        await sendToContentScript(tabId, { type: 'dismiss_cookies' });
        await sleep(500);

        const tab = await chrome.tabs.get(tabId);
        sendToServer({ type: 'cmd_result', id: msg.id, success: true, url: tab.url, title: tab.title });
      } catch (err) {
        sendToServer({ type: 'cmd_result', id: msg.id, success: false, error: err.message });
      }
      break;
    }

    // ── Screenshot (capture le bon onglet !) ──
    case 'cmd_screenshot': {
      try {
        const tabId = await getActiveTabId();
        const base64 = await captureTab(tabId);
        if (base64) {
          sendToServer({ type: 'cmd_result', id: msg.id, success: true, image: base64 });
        } else {
          sendToServer({ type: 'cmd_result', id: msg.id, success: false, error: 'Capture échouée' });
        }
      } catch (err) {
        sendToServer({ type: 'cmd_result', id: msg.id, success: false, error: err.message });
      }
      break;
    }

    // ── Info page ──
    case 'cmd_page_info': {
      try {
        const tabId = await getActiveTabId();
        const tab = await chrome.tabs.get(tabId);
        sendToServer({ type: 'cmd_result', id: msg.id, success: true, url: tab.url, title: tab.title });
      } catch (err) {
        sendToServer({ type: 'cmd_result', id: msg.id, success: false, error: err.message });
      }
      break;
    }

    // ── Tag & Extract DOM ──
    case 'cmd_tag_extract': {
      try {
        const tabId = await getActiveTabId();
        await ensureContentScript(tabId);
        const result = await sendToContentScript(tabId, { 
          type: 'tag_and_extract', 
          maxElements: msg.maxElements || 150 
        });
        sendToServer({ type: 'cmd_result', id: msg.id, success: true, elements: result.elements });
      } catch (err) {
        sendToServer({ type: 'cmd_result', id: msg.id, success: false, error: err.message, elements: [] });
      }
      break;
    }

    // ── Extract structured content ──
    case 'cmd_extract_content': {
      try {
        const tabId = await getActiveTabId();
        await ensureContentScript(tabId);
        const result = await sendToContentScript(tabId, { 
          type: 'extract_content', 
          maxChars: msg.maxChars || 8000 
        });
        sendToServer({ type: 'cmd_result', id: msg.id, success: true, content: result.content });
      } catch (err) {
        sendToServer({ type: 'cmd_result', id: msg.id, success: false, error: err.message });
      }
      break;
    }

    // ── Click par index ──
    case 'cmd_click': {
      try {
        const tabId = await getActiveTabId();
        const result = await sendToContentScript(tabId, { type: 'click', index: msg.index });
        await sleep(800);
        sendToServer({ type: 'cmd_result', id: msg.id, ...result });
      } catch (err) {
        sendToServer({ type: 'cmd_result', id: msg.id, success: false, error: err.message });
      }
      break;
    }

    // ── Click par texte ──
    case 'cmd_click_by_text': {
      try {
        const tabId = await getActiveTabId();
        const result = await sendToContentScript(tabId, { type: 'click_by_text', text: msg.text });
        await sleep(800);
        sendToServer({ type: 'cmd_result', id: msg.id, ...result });
      } catch (err) {
        sendToServer({ type: 'cmd_result', id: msg.id, success: false, error: err.message });
      }
      break;
    }

    // ── Saisie par index ──
    case 'cmd_type': {
      try {
        const tabId = await getActiveTabId();
        const result = await sendToContentScript(tabId, { 
          type: 'type_text', index: msg.index, text: msg.text, clear: msg.clear || false
        });
        sendToServer({ type: 'cmd_result', id: msg.id, ...result });
      } catch (err) {
        sendToServer({ type: 'cmd_result', id: msg.id, success: false, error: err.message });
      }
      break;
    }

    // ── Saisie par placeholder ──
    case 'cmd_type_by_placeholder': {
      try {
        const tabId = await getActiveTabId();
        const result = await sendToContentScript(tabId, { 
          type: 'type_by_placeholder', placeholder: msg.placeholder, text: msg.text, clear: msg.clear || false
        });
        sendToServer({ type: 'cmd_result', id: msg.id, ...result });
      } catch (err) {
        sendToServer({ type: 'cmd_result', id: msg.id, success: false, error: err.message });
      }
      break;
    }

    // ── Touche clavier ──
    case 'cmd_press_key': {
      try {
        const tabId = await getActiveTabId();
        const result = await sendToContentScript(tabId, { type: 'press_key', key: msg.key });
        await sleep(500);
        sendToServer({ type: 'cmd_result', id: msg.id, ...result });
      } catch (err) {
        sendToServer({ type: 'cmd_result', id: msg.id, success: false, error: err.message });
      }
      break;
    }

    // ── Scroll ──
    case 'cmd_scroll': {
      try {
        const tabId = await getActiveTabId();
        const result = await sendToContentScript(tabId, { 
          type: 'scroll', direction: msg.direction || 'down', amount: msg.amount || 500
        });
        await sleep(500);
        sendToServer({ type: 'cmd_result', id: msg.id, ...result });
      } catch (err) {
        sendToServer({ type: 'cmd_result', id: msg.id, success: false, error: err.message });
      }
      break;
    }

    // ── Retour ──
    case 'cmd_go_back': {
      try {
        const tabId = await getActiveTabId();
        // Détacher debugger avant navigation
        if (debuggerAttached.has(tabId)) {
          try { await chrome.debugger.detach({ tabId }); } catch {}
          debuggerAttached.delete(tabId);
        }
        await chrome.tabs.goBack(tabId);
        await waitForTabLoad(tabId, 10000);
        await sleep(1000);
        const tab = await chrome.tabs.get(tabId);
        sendToServer({ type: 'cmd_result', id: msg.id, success: true, url: tab.url });
      } catch (err) {
        sendToServer({ type: 'cmd_result', id: msg.id, success: false, error: err.message });
      }
      break;
    }

    // ── Wait ──
    case 'cmd_wait': {
      await sleep(msg.duration || 2000);
      sendToServer({ type: 'cmd_result', id: msg.id, success: true });
      break;
    }

    // ── Sélectionner l'onglet à contrôler ──
    case 'cmd_set_tab': {
      activeTabId = msg.tabId;
      sendToServer({ type: 'cmd_result', id: msg.id, success: true });
      break;
    }

    // ── Liste des onglets ──
    case 'cmd_list_tabs': {
      try {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        const tabList = tabs.map(t => ({ 
          id: t.id, title: t.title, url: t.url, active: t.active 
        }));
        sendToServer({ type: 'cmd_result', id: msg.id, success: true, tabs: tabList, activeTabId });
      } catch (err) {
        sendToServer({ type: 'cmd_result', id: msg.id, success: false, error: err.message });
      }
      break;
    }

    case 'ping': {
      sendToServer({ type: 'pong' });
      break;
    }

    default:
      console.warn('⚠️ Commande inconnue:', msg.type);
      sendToServer({ type: 'cmd_result', id: msg.id, success: false, error: `Commande inconnue: ${msg.type}` });
  }
}

// ══════════════════════════════════════════════════════════════════════
// 🔧 HELPERS
// ══════════════════════════════════════════════════════════════════════

async function getActiveTabId() {
  if (activeTabId) {
    try {
      await chrome.tabs.get(activeTabId);
      return activeTabId;
    } catch { /* tab fermé */ }
  }

  // Trouver un onglet actif qui n'est PAS le dashboard Phantom
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  for (const tab of tabs) {
    if (!tab.url.includes('localhost:3001') && !tab.url.startsWith('chrome://')) {
      activeTabId = tab.id;
      return tab.id;
    }
  }

  // Fallback : premier onglet non-phantom
  const allTabs = await chrome.tabs.query({ currentWindow: true });
  for (const tab of allTabs) {
    if (!tab.url.includes('localhost:3001') && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
      activeTabId = tab.id;
      return tab.id;
    }
  }

  // Dernier recours : créer un nouvel onglet
  const newTab = await chrome.tabs.create({ url: 'about:blank' });
  activeTabId = newTab.id;
  return newTab.id;
}

async function ensureContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'ping' });
    if (response && response.pong) return;
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
    await sleep(300);
  }
}

function sendToContentScript(tabId, message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout content script (10s)'));
    }, 10000);

    chrome.tabs.sendMessage(tabId, message, (response) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response || {});
      }
    });
  });
}

function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);

    const listener = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ══════════════════════════════════════════════════════════════════════
// 📡 MESSAGES INTERNES (popup)
// ══════════════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'get_status') {
    sendResponse({ connected: isConnected });
    return;
  }
  if (msg.type === 'connect') {
    connect();
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'disconnect') {
    disconnect();
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'set_active_tab') {
    activeTabId = msg.tabId;
    sendResponse({ ok: true });
    return;
  }
});

// Quand un onglet est fermé, détacher le debugger
chrome.tabs.onRemoved.addListener((tabId) => {
  if (debuggerAttached.has(tabId)) {
    debuggerAttached.delete(tabId);
  }
  if (activeTabId === tabId) {
    activeTabId = null;
  }
});

// Quand le debugger est détaché par l'utilisateur
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    debuggerAttached.delete(source.tabId);
  }
});

// ── Auto-connect au démarrage ──
connect();

console.log('👻 Phantom Agent Extension v2 — Background chargé');
