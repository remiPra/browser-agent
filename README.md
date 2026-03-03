# 👻 Phantom Agent

**Clone de Comet/Nanobrowser — Agent IA d'automatisation de navigateur web**

Phantom Agent est un agent autonome qui contrôle un navigateur web via l'API Claude.
Tu lui donnes une tâche en langage naturel, il planifie, observe la page, décide et exécute.

## Architecture

```
┌─────────────────────────────────────────┐
│         Interface Web (Chat + Live)     │
│         http://localhost:3001           │
└───────────────────┬─────────────────────┘
                    │ WebSocket
┌───────────────────▼─────────────────────┐
│          🧠 Planificateur               │
│   Décompose la tâche en sous-étapes     │
│   (Claude API)                          │
└───────────────────┬─────────────────────┘
                    │
         ┌──────────▼──────────┐
         │   BOUCLE AGENT      │
         │                     │
         │  👁️ Observer        │
         │  Extrait le DOM     │
         │  + screenshot       │
         │         │           │
         │  🎯 Décideur        │
         │  Claude analyse     │
         │  et choisit         │
         │         │           │
         │  🔧 Exécuteur       │
         │  Playwright agit    │
         │         │           │
         │  ↻ Reboucle         │
         └─────────────────────┘
```

## 🚀 Installation

### Prérequis
- **Node.js** 18+ (https://nodejs.org)
- **Une clé API Anthropic** (https://console.anthropic.com)

### Étape 1 — Cloner et installer

```bash
cd phantom-agent
npm install
```

### Étape 2 — Installer les navigateurs Playwright

```bash
npx playwright install chromium
```

### Étape 3 — Configurer la clé API

Ouvre `src/config.js` et remplace `YOUR_API_KEY_HERE` par ta clé API Anthropic :

```js
ANTHROPIC_API_KEY: 'sk-ant-api03-...',
```

Ou utilise une variable d'environnement :

```bash
export ANTHROPIC_API_KEY="sk-ant-api03-..."
```

### Étape 4 — Lancer

```bash
# Mode normal (navigateur visible sur ton écran)
npm start

# Mode headless (navigateur invisible, plus rapide)
npm run headless

# Mode dev (auto-reload)
npm run dev
```

Ouvre **http://localhost:3001** dans ton navigateur.

## 🎮 Utilisation

1. Tape une tâche dans le chat, par exemple :
   - "Va sur Google et cherche les dernières news sur l'IA"
   - "Va sur Wikipedia et trouve la page de Paris"
   - "Va sur GitHub trending et dis-moi les repos populaires"

2. L'agent va :
   - 🧠 **Planifier** — décomposer ta tâche en étapes
   - 👁️ **Observer** — regarder la page (DOM + screenshot)
   - 🎯 **Décider** — demander à Claude quelle action faire
   - 🔧 **Exécuter** — cliquer, taper, naviguer via Playwright
   - 🔄 **Reboucler** — jusqu'à ce que la tâche soit terminée

3. Tu vois tout en temps réel : le screenshot du navigateur, les décisions de l'IA, l'historique des actions.

## ⚙️ Configuration

Tout se passe dans `src/config.js` :

| Paramètre | Description | Défaut |
|-----------|-------------|--------|
| `ANTHROPIC_API_KEY` | Ta clé API Claude | — |
| `CLAUDE_MODEL` | Modèle Claude à utiliser | `claude-sonnet-4-5-20250929` |
| `HEADLESS` | Navigateur invisible | `false` |
| `MAX_STEPS` | Nombre max d'actions par tâche | `25` |
| `DOM_MAX_ELEMENTS` | Nombre max d'éléments DOM extraits | `150` |
| `PORT` | Port du serveur web | `3001` |

## 📁 Structure du projet

```
phantom-agent/
├── public/
│   └── index.html          # Interface web (dashboard)
├── src/
│   ├── config.js            # Configuration
│   ├── index.js             # Serveur Express + WebSocket
│   └── core/
│       ├── agent.js          # 🎯 Orchestrateur principal
│       ├── browser-controller.js  # 🔧 Exécuteur (Playwright)
│       ├── dom-observer.js   # 👁️ Observer (extraction DOM)
│       ├── ai-decider.js     # 🎯 Décideur (Claude API)
│       └── planner.js        # 🧠 Planificateur (Claude API)
├── package.json
└── README.md
```

## 🔮 Roadmap

- [x] Phase 1 : Exécuteur + Observer
- [x] Phase 2 : Décideur avec Claude
- [x] Phase 3 : Planificateur
- [x] Phase 4 : Interface web live
- [ ] Phase 5 : Gestion d'erreurs avancée, retry, mémoire
- [ ] Phase 6 : Multi-onglets
- [ ] Phase 7 : Enregistrement et replay de workflows
- [ ] Phase 8 : Support d'autres LLMs (OpenAI, Mistral...)

## ⚠️ Limitations

- L'agent ne peut pas résoudre les CAPTCHAs
- Les sites avec beaucoup de JavaScript dynamique peuvent être plus lents
- Chaque action = 1 appel API Claude (coût à surveiller)
- Pas de gestion multi-onglets pour l'instant

---

Fait avec 👻 par toi et Claude.
