# 🧩 Phantom Agent — Mode Extension Chrome

## Le problème
Le mode Chrome CDP nécessite de fermer et relancer Chrome avec un flag spécial (`--remote-debugging-port=9222`). Ça peut bloquer sur certains PC (antivirus, profil verrouillé, etc.).

## La solution : Extension Chrome
Une extension Chrome qui se connecte directement au serveur Phantom Agent via WebSocket. Pas besoin de CDP, pas besoin de relancer Chrome !

## Installation

### 1. Copier les fichiers dans ton projet

Copie ces fichiers/dossiers dans ton projet `phantom-agent/` :

```
chrome-extension/          → phantom-agent/chrome-extension/  (NOUVEAU dossier)
src/core/extension-controller.js  → phantom-agent/src/core/extension-controller.js
src/core/dom-observer-universal.js → phantom-agent/src/core/dom-observer-universal.js
src/index.js               → phantom-agent/src/index.js  (REMPLACE l'existant)
public/index.html          → phantom-agent/public/index.html  (REMPLACE l'existant)
```

### 2. Installer l'extension dans Chrome

1. Ouvrir Chrome
2. Aller sur `chrome://extensions`
3. Activer le **Mode développeur** (toggle en haut à droite)
4. Cliquer **"Charger l'extension non empaquetée"**
5. Sélectionner le dossier `phantom-agent/chrome-extension/`
6. L'icône 👻 apparaît dans la barre d'extensions

### 3. Utiliser

1. Lancer le serveur : `npm start`
2. Ouvrir `http://localhost:3001`
3. Cliquer sur la carte **"Extension Chrome"** 🧩
4. L'extension se connecte automatiquement !
5. Donner une tâche à l'agent → il contrôle Chrome via l'extension

## Comment ça marche

```
┌─────────────────────────────────────────────┐
│     Interface Web (http://localhost:3001)    │
└──────────────────┬──────────────────────────┘
                   │ WebSocket (client)
┌──────────────────▼──────────────────────────┐
│        Serveur Phantom Agent (Node.js)      │
│        ExtensionController                   │
└──────────────────┬──────────────────────────┘
                   │ WebSocket (extension)
┌──────────────────▼──────────────────────────┐
│     Extension Chrome (background.js)         │
│         ↕ chrome.tabs / chrome.scripting     │
│     Content Script (content.js)              │
│         ↕ DOM manipulation directe           │
└──────────────────────────────────────────────┘
```

## Avantages vs CDP

| | CDP | Extension |
|---|---|---|
| Relancer Chrome | ✅ Oui | ❌ Non |
| Extensions Chrome | ❌ Perdues au restart | ✅ Intactes |
| Configuration | Flag `--remote-debugging-port` | Juste installer l'extension |
| Compatibilité | Parfois bloqué (antivirus, etc.) | Fonctionne partout |
| Screenshots | Via CDP protocol | Via `chrome.tabs.captureVisibleTab` |

