// ── Phantom Agent — Popup Script (MV3 compliant) ─────────────────────

function updateUI(connected) {
  const status = document.getElementById('status');
  const text = document.getElementById('statusText');
  const btn = document.getElementById('actionBtn');

  if (connected) {
    status.className = 'status connected';
    text.textContent = 'Connecté au serveur Phantom';
    btn.className = 'btn btn-disconnect';
    btn.textContent = '⛔ Déconnecter';
  } else {
    status.className = 'status disconnected';
    text.textContent = 'Déconnecté';
    btn.className = 'btn btn-connect';
    btn.textContent = '🔌 Connecter';
  }
}

function toggleConnection() {
  chrome.runtime.sendMessage({ type: 'get_status' }, (res) => {
    if (res && res.connected) {
      chrome.runtime.sendMessage({ type: 'disconnect' });
      updateUI(false);
    } else {
      chrome.runtime.sendMessage({ type: 'connect' });
      setTimeout(() => {
        chrome.runtime.sendMessage({ type: 'get_status' }, (res2) => {
          updateUI(res2 && res2.connected);
        });
      }, 1000);
    }
  });
}

// ── Init au chargement du DOM ──
document.addEventListener('DOMContentLoaded', () => {
  // Bouton connecter/déconnecter
  document.getElementById('actionBtn').addEventListener('click', toggleConnection);

  // Récupérer le statut actuel
  chrome.runtime.sendMessage({ type: 'get_status' }, (res) => {
    updateUI(res && res.connected);
  });

  // Écouter les changements de statut en temps réel
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'status') {
      updateUI(msg.connected);
    }
  });
});
