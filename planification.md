# Planification — Phantom Agent v4 "Claude in Chrome"

> Objectif : transformer Phantom Agent en un agent de navigation autonome au niveau de Claude in Chrome.
> Base actuelle : ~2 300 lignes, architecture Plan → Observe → Decide → Execute.

---

## 1. Diagnostic de l'existant

### Ce qui fonctionne bien (on garde)
| Module | Force |
|--------|-------|
| `data-phantom-id` sync | Injection d'index dans le DOM = zéro drift entre vision IA et exécution Playwright |
| Stealth mode | Masquage webdriver, faux plugins, faux languages, user-agent réaliste |
| Frappe humaine | Typos QWERTY + correction Backspace + pauses d'hésitation |
| Cookie auto-dismiss | Gère page principale + iframes |
| Session persistence | Sauvegarde/restauration cookies + localStorage |
| Frontend temps réel | WebSocket bidirectionnel, screenshot live, plan, chat |

### Ce qui manque (les vrais problèmes)

| Problème | Impact | Fichier concerné |
|----------|--------|-------------------|
| L'IA ne peut pas **lire** le contenu des pages (seulement les boutons/inputs) | L'agent est "aveugle" au texte, résultats de recherche, articles | `dom-observer.js:140-173` — extrait le texte mais limité à 3000 chars, sans structure |
| Pas de **scroll intelligent** — l'observateur ignore le hors-viewport | L'agent ne peut pas trouver d'éléments en bas de page | `dom-observer.js:82-83` — filtre les éléments hors viewport+200px |
| **Planification rigide** — plan fait 1 seule fois, jamais mis à jour | Si la page est différente de ce qui était attendu, l'agent est perdu | `agent.js:42` — un seul appel `planner.plan()` |
| **Pas de mémoire** entre les étapes — appels IA stateless | Chaque décision ignore tout ce qui s'est passé sauf 6 dernières actions | `ai-decider.js:63` — `actionHistory.slice(-6)` |
| **Pas d'extraction de données** — impossible de retourner des infos structurées | L'agent fait des actions mais ne rapporte rien d'utile | `agent.js:77-79` — `done` ne retourne qu'un string |
| Détection de boucle **trop basique** | Seulement "3x même action" ou "3 échecs". Pas de pattern A→B→A→B | `ai-decider.js:110-130` |
| **Pas de gestion d'onglets** | Sites qui ouvrent de nouveaux onglets = agent cassé | `browser-controller.js:60` — un seul `this.page` |
| **Pas de gestion d'iframes** (sauf cookies) | Formulaires embarqués, captchas, embeds = invisibles | `dom-observer.js` — ne traverse pas les iframes |
| **Pas d'instructions intermédiaires** | L'utilisateur ne peut pas corriger/guider l'agent en cours de route | `index.js:44-46` — `task` lance `executeTask` bloquant |
| Timeout **fixe** partout | 800ms après clic, 500ms après scroll — inadapté selon le contexte | `browser-controller.js` — waits hardcodés |

---

## 2. Plan de refonte — 6 phases

### Phase 1 — L'IA peut LIRE les pages (P0)

**Objectif** : L'agent voit et comprend le contenu textuel complet, pas juste les boutons.

#### 1.1 Extraction de contenu structurée (`dom-observer.js`)

**Fichier** : `src/core/dom-observer.js` — méthode `extractVisibleText()` lignes 140-173

Actuellement : TreeWalker qui concatène tout le texte brut (max 3000 chars).
Problème : Aucune structure — l'IA ne distingue pas un titre d'un paragraphe, un résultat de recherche d'un menu.

**Modifications** :
```
extractStructuredContent(page) → {
  headings: [{level, text}],         // h1-h6
  paragraphs: [text],                // <p>, <article>, <section>
  lists: [{items: [text]}],          // <ul>/<ol>
  tables: [{headers, rows}],         // <table> (résumé)
  searchResults: [{title, snippet, url}],  // Heuristique pour Google/DDG/Bing
  mainContent: text,                 // <main> ou <article> ou plus gros bloc
  metadata: {                        // Infos contextuelles
    hasForm: bool,
    hasLogin: bool,
    hasSearch: bool,
    pageType: 'search_results' | 'article' | 'form' | 'listing' | 'homepage' | 'other'
  }
}
```

- Augmenter la limite de texte à **8000 chars** (le screenshot compense déjà visuellement)
- Détecter le type de page pour aider l'IA à adapter son comportement
- Les résultats de recherche méritent un traitement spécial (titre + snippet + URL = ce que l'IA cherche 90% du temps)

#### 1.2 Formatage enrichi pour l'IA (`dom-observer.js`)

**Fichier** : `src/core/dom-observer.js` — méthode `formatForAI()` lignes 176-219

Actuellement : Sépare "Champs" et "Boutons/liens" puis colle le texte brut à la fin.

**Nouveau format** :
```
📍 URL: https://...
📄 Titre: ...
📊 Type de page: search_results

── Contenu principal ──
[Structure hiérarchique : titres, paragraphes, résultats...]

── Champs de saisie (N) ──
[Comme avant]

── Boutons & liens (N) ──
[Comme avant]
```

L'IA reçoit d'abord le **contenu** (ce qu'elle doit comprendre) puis les **contrôles** (ce qu'elle peut faire).

---

### Phase 2 — Scroll intelligent & observation complète (P0)

**Objectif** : L'agent peut voir TOUTE la page, pas juste le viewport.

#### 2.1 Scroll-and-observe dans l'agent (`agent.js`)

**Fichier** : `src/core/agent.js` — boucle principale lignes 54-98

Actuellement : 1 observation = 1 screenshot du viewport actuel. Les éléments hors viewport sont ignorés.

**Nouveau comportement** :
- Avant la première observation d'une nouvelle page, estimer la hauteur totale (`document.body.scrollHeight`)
- Si la page est plus haute que le viewport, faire un **scroll exploratoire** :
  - Scroll down → observer → collecter éléments
  - Jusqu'à 3 viewports de scroll max (éviter les pages infinies)
  - Revenir en haut pour le screenshot final
- Les éléments collectés gardent un flag `viewport: 'above' | 'visible' | 'below'` pour que l'IA sache où ils sont
- L'IA peut demander `scroll` et le prochain `observe()` re-tague les éléments depuis la nouvelle position

#### 2.2 Action scroll améliorée (`browser-controller.js`)

**Fichier** : `src/core/browser-controller.js` — méthode `scroll()` lignes 372-377

Actuellement : `window.scrollBy(0, ±500)` puis 500ms de wait.

**Améliorations** :
- `scroll_to_element` : scroll jusqu'à un élément par index (scrollIntoView)
- `scroll_to_top` / `scroll_to_bottom` : raccourcis
- Retourner la position actuelle dans le résultat : `{scrollY, scrollHeight, viewportHeight, atBottom}`
- L'IA sait ainsi où elle est dans la page

#### 2.3 Position de scroll dans l'observation

Ajouter dans le formatage IA :
```
📍 Position: 40% (scroll 320px / 800px total)
```

L'IA sait qu'il y a du contenu plus bas et peut décider de scroller.

---

### Phase 3 — Re-planification dynamique (P0)

**Objectif** : Le plan s'adapte quand la réalité diverge de ce qui était prévu.

#### 3.1 Nouveau module `re-planner.js` (`src/core/re-planner.js`)

**Nouveau fichier** à créer.

Le Planner actuel (`planner.js`) fait **1 appel** au début. Le Re-planner intervient **pendant** l'exécution.

**Déclencheurs de re-planification** :
- Page inattendue (URL ne correspond pas au plan)
- Élément attendu introuvable après 2 tentatives
- Erreur répétée (3 échecs différents consécutifs)
- L'IA signale explicitement "je suis bloqué" (nouvelle action `replan`)
- Toutes les N étapes (ex: toutes les 5), vérifier que le plan est toujours pertinent

**Appel API** :
```
Contexte:
- Tâche originale: {task}
- Plan initial: {plan}
- Étapes accomplies: {history résumé}
- État actuel de la page: {URL, titre, type de page}
- Problème rencontré: {description}

Donne un nouveau plan adapté en JSON.
```

#### 3.2 Intégration dans l'agent (`agent.js`)

Dans la boucle principale, après chaque `executeAction()` :
- Vérifier les déclencheurs de re-planification
- Si déclenchés → appel re-planner → mettre à jour le plan
- Émettre un event `replan` au frontend pour afficher le nouveau plan

---

### Phase 4 — Mémoire contextuelle (P1)

**Objectif** : L'IA se souvient de ce qu'elle a vu et fait, pas juste des 6 dernières actions.

#### 4.1 Module mémoire (`src/core/memory.js`)

**Nouveau fichier** à créer.

```js
class AgentMemory {
  constructor() {
    this.visitedPages = [];      // {url, title, summary, timestamp}
    this.extractedData = [];     // Données collectées
    this.failedAttempts = [];    // Ce qui n'a pas marché (et pourquoi)
    this.currentGoal = '';       // Objectif de l'étape en cours
    this.keyFindings = [];       // Infos importantes trouvées
  }

  summarize() → string           // Résumé compact pour le prompt IA
  addPageVisit(observation)      // Résumer et stocker
  addFinding(text)               // Stocker une info importante
  addFailure(action, error)      // Stocker un échec
  getRelevantContext(task) → string  // Contexte pertinent pour la tâche
}
```

**Fonctionnement** :
- Après chaque observation, résumer la page visitée (titre + URL + type + 2-3 phrases)
- Garder les 10 dernières pages visitées
- Garder les 5 derniers échecs
- Injecter le résumé dans le prompt du décideur (entre l'historique d'actions et l'état de la page)

#### 4.2 Intégration dans le décideur (`ai-decider.js`)

**Fichier** : `src/core/ai-decider.js` — méthode `decide()` lignes 55-108

Le message envoyé à Claude devient :
```
🎯 TÂCHE : {task}

── Mémoire (pages visitées, données collectées) ──
{memory.summarize()}

── Historique récent (6 dernières actions) ──
{actionHistory}

── État de la page ──
{formattedDOM enrichi}

Prochaine action ? (JSON)
```

Augmenter `max_tokens` de 1024 → **2048** pour permettre des réponses plus détaillées.

---

### Phase 5 — Robustesse & Actions avancées (P1)

**Objectif** : L'agent gère plus de situations sans se bloquer.

#### 5.1 Retry intelligent avec fallbacks (`browser-controller.js`)

**Fichier** : `src/core/browser-controller.js`

Pour chaque action de clic :
1. Essayer `clickByIndex` (data-phantom-id)
2. Si échec → essayer `clickByText` (texte de l'élément)
3. Si échec → essayer par CSS selector (aria-label, role)
4. Si échec → signaler à l'IA avec les alternatives disponibles

Même logique pour la saisie : index → placeholder → name → CSS selector.

#### 5.2 Détection de boucle avancée (`ai-decider.js`)

**Fichier** : `src/core/ai-decider.js` — méthode `_detectLoop()` lignes 110-130

Patterns à détecter en plus :
- **Oscillation** : A→B→A→B (2 actions alternées)
- **Boucle longue** : A→B→C→A→B→C
- **Stagnation** : URL identique sur 5+ étapes sans progression visible
- **Score de progression** : comparer les observations entre étapes (le DOM change-t-il ?)

#### 5.3 Attentes intelligentes (`browser-controller.js`)

Remplacer les `waitForTimeout(800)` par :
- `waitForNavigation` quand on s'attend à un changement de page
- `waitForLoadState('networkidle')` après soumission de formulaire
- `waitForSelector` quand on attend l'apparition d'un élément
- Timeout adaptatif : 500ms pour un clic simple, 3000ms pour une navigation

#### 5.4 Gestion multi-onglets (`browser-controller.js`)

**Fichier** : `src/core/browser-controller.js`

Actuellement : un seul `this.page`. Les liens `target="_blank"` ouvrent un onglet que l'agent ignore.

**Modifications** :
- Écouter l'événement `context.on('page')` pour détecter les nouveaux onglets
- Maintenir un tableau `this.pages = []` avec l'onglet actif
- Nouvelles actions pour l'IA :
  - `switch_tab` : changer d'onglet (par index ou titre)
  - `close_tab` : fermer l'onglet courant
  - `list_tabs` : lister les onglets ouverts
- L'observation inclut la liste des onglets et lequel est actif

#### 5.5 Gestion basique des iframes (`dom-observer.js`)

**Fichier** : `src/core/dom-observer.js`

Actuellement : seule la page principale est taguée. Les iframes (formulaires, embeds, captchas) sont invisibles.

**Modifications** :
- Après le taggage de la page principale, itérer sur `page.frames()`
- Pour chaque iframe visible de taille significative (>100px largeur et hauteur) :
  - Taguer les éléments interactifs avec un offset d'index (ex: éléments iframe commencent à 1000)
  - Inclure dans le formatage avec un label `[IFRAME: nom/url]`
- Limité aux iframes same-origin (cross-origin = inaccessible par Playwright)

#### 5.6 Nouvelles actions

| Action | Params | Usage |
|--------|--------|-------|
| `extract_text` | `selector?` | Extraire le texte d'un élément ou de la page entière |
| `scroll_to_element` | `index` | Scroller jusqu'à un élément spécifique |
| `switch_tab` | `index \| title` | Changer d'onglet |
| `close_tab` | — | Fermer l'onglet courant |
| `screenshot_full` | — | Screenshot de la page complète (full page) |
| `highlight` | `index` | Mettre en évidence un élément (box rouge) pour debug |
| `drag_drop` | `fromIndex, toIndex` | Glisser-déposer |
| `upload_file` | `index, filePath` | Upload de fichier |
| `replan` | `reason` | Demander une re-planification |

---

### Phase 6 — Frontend conversationnel (P2)

**Objectif** : L'utilisateur peut interagir avec l'agent pendant son exécution.

#### 6.1 Instructions intermédiaires (`index.js` + `agent.js`)

**Fichiers** : `src/index.js` lignes 43-47, `src/core/agent.js`

Actuellement : envoyer `task` pendant que l'agent tourne → "une tâche est déjà en cours".

**Modifications** :
- Nouveau type de message : `{ type: 'instruction', text: '...' }`
- L'agent stocke l'instruction dans `this.pendingInstructions`
- Au prochain cycle decide(), l'instruction est injectée dans le prompt :
  ```
  ⚡ INSTRUCTION UTILISATEUR : "Non pas celui-là, clique sur le deuxième résultat"
  ```
- L'IA prend en compte l'instruction pour sa prochaine décision
- Le frontend affiche un indicateur quand une instruction est en attente

#### 6.2 Highlight d'éléments sur le screenshot (`dom-observer.js` + frontend)

Quand l'IA décide de cliquer sur `[8]`, avant l'exécution :
- Injecter un overlay rouge semi-transparent sur l'élément `[data-phantom-id="8"]`
- Prendre un screenshot avec le highlight
- Envoyer au frontend avec un label "va cliquer ici"
- Retirer le highlight
- Exécuter l'action

#### 6.3 Historique et reprise de tâches (`frontend`)

- Stocker l'historique des tâches dans `localStorage` du navigateur
- Bouton "Reprendre" pour relancer une tâche précédente
- Afficher les tâches récentes dans le panneau latéral

---

## 3. Modifications par fichier

### Fichiers existants à modifier

| Fichier | Lignes actuelles | Changements |
|---------|-----------------|-------------|
| `src/config.js` | 37 | Ajouter : `CONTENT_MAX_CHARS`, `SCROLL_EXPLORE_MAX`, `REPLAN_EVERY_N_STEPS`, `MEMORY_MAX_PAGES`, `MAX_TOKENS_DECIDER` |
| `src/core/dom-observer.js` | 221 | Refonte `extractVisibleText` → `extractStructuredContent`. Refonte `formatForAI`. Support iframes. Position scroll. ~350 lignes estimées |
| `src/core/ai-decider.js` | 134 | Intégration mémoire. Détection boucle avancée. Support instructions utilisateur. Nouvelles actions dans le prompt. ~250 lignes estimées |
| `src/core/agent.js` | 166 | Boucle avec re-planification. Scroll exploratoire. Mémoire. Instructions intermédiaires. Highlight. ~300 lignes estimées |
| `src/core/browser-controller.js` | 476 | Multi-onglets. Scroll amélioré. Retry fallbacks. Waits intelligents. Nouvelles actions. ~650 lignes estimées |
| `src/core/planner.js` | 93 | Améliorer le prompt pour meilleure qualité de plan. ~100 lignes estimées |
| `src/index.js` | 116 | Message `instruction`. Gestion multi-onglets côté WS. ~150 lignes estimées |
| `public/index.html` | 819 | Highlight, historique, instructions intermédiaires, liste onglets. ~1000 lignes estimées |

### Nouveaux fichiers à créer

| Fichier | Rôle | Lignes estimées |
|---------|------|-----------------|
| `src/core/memory.js` | Mémoire contextuelle entre les étapes | ~120 |
| `src/core/re-planner.js` | Re-planification dynamique en cours de tâche | ~100 |

### Estimation totale

| Métrique | Avant | Après |
|----------|-------|-------|
| Fichiers JS | 6 | 8 |
| Lignes JS total | ~1 480 | ~2 700 |
| Lignes HTML | 819 | ~1 000 |
| **Total** | **~2 300** | **~3 700** |

---

## 4. Ordre d'implémentation

```
Phase 1 — Lecture de contenu        ██████████
  1.1 extractStructuredContent()     → dom-observer.js
  1.2 formatForAI() enrichi          → dom-observer.js
  1.3 Mettre à jour le prompt IA     → ai-decider.js

Phase 2 — Scroll intelligent        ██████████
  2.1 Position scroll dans observe   → dom-observer.js
  2.2 scroll amélioré                → browser-controller.js
  2.3 scroll exploratoire            → agent.js

Phase 3 — Re-planification          ██████████
  3.1 Créer re-planner.js           → nouveau fichier
  3.2 Intégrer dans la boucle       → agent.js
  3.3 Event frontend replan          → index.js + index.html

Phase 4 — Mémoire                   ██████████
  4.1 Créer memory.js               → nouveau fichier
  4.2 Intégrer dans agent            → agent.js
  4.3 Injecter dans le prompt IA     → ai-decider.js

Phase 5 — Robustesse                ██████████
  5.1 Retry fallbacks               → browser-controller.js
  5.2 Détection boucle avancée      → ai-decider.js
  5.3 Waits intelligents            → browser-controller.js
  5.4 Multi-onglets                 → browser-controller.js
  5.5 Iframes basiques              → dom-observer.js
  5.6 Nouvelles actions             → browser-controller.js + agent.js

Phase 6 — Frontend                   ██████████
  6.1 Instructions intermédiaires   → index.js + agent.js + index.html
  6.2 Highlight éléments            → dom-observer.js + index.html
  6.3 Historique tâches             → index.html
```

---

## 5. Risques et mitigations

| Risque | Probabilité | Mitigation |
|--------|-------------|------------|
| Prompt trop long = coût API explose | Haute | Limiter contenu structuré à 8000 chars. Résumer la mémoire. Monitorer les tokens/appel |
| Extraction contenu casse sur certains sites | Moyenne | Fallback vers texte brut si extraction structurée échoue |
| Re-planification boucle infinie (replan qui déclenche replan) | Moyenne | Max 3 re-planifications par tâche. Cooldown de 3 étapes entre re-plans |
| Multi-onglets complexifie l'observation | Moyenne | Toujours observer l'onglet actif seulement. Juste lister les autres |
| Iframes cross-origin inaccessibles | Certaine | Documenter la limitation. Signaler à l'IA quand un iframe est cross-origin |
| Highlight ralentit l'exécution | Faible | Optionnel (config `HIGHLIGHT_ENABLED`). Injection/retrait rapide (<100ms) |

---

## 6. Config finale (`src/config.js`)

```js
export const CONFIG = {
  // ── API Claude ──
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  CLAUDE_MODEL: 'claude-sonnet-4-5-20250929',

  // ── Browser ──
  HEADLESS: false,
  VIEWPORT: { width: 1280, height: 800 },
  USER_AGENT: '...',
  DEFAULT_TIMEOUT: 30_000,
  SESSION_DIR: './sessions',
  SESSION_FILE: 'default.json',

  // ── Server ──
  PORT: 3001,

  // ── Agent ──
  MAX_STEPS: 40,                    // 25 → 40 (plus de marge avec re-planification)
  SCREENSHOT_QUALITY: 75,
  DOM_MAX_ELEMENTS: 200,            // 150 → 200
  CONTENT_MAX_CHARS: 8000,          // Nouveau : limite texte contenu
  MEMORY_MAX_PAGES: 10,             // Nouveau : pages mémorisées max
  MAX_TOKENS_DECIDER: 2048,         // Nouveau : tokens max pour le décideur

  // ── Scroll ──
  SCROLL_EXPLORE_MAX: 3,            // Nouveau : viewports max pour scroll exploratoire
  SCROLL_WAIT: 300,                 // Nouveau : attente après scroll (ms)

  // ── Re-planification ──
  REPLAN_EVERY_N_STEPS: 8,          // Nouveau : vérifier plan toutes les N étapes
  REPLAN_MAX: 3,                    // Nouveau : max re-planifications par tâche
  REPLAN_COOLDOWN: 3,               // Nouveau : étapes min entre 2 re-plans

  // ── UI ──
  HIGHLIGHT_ENABLED: true,          // Nouveau : highlight avant clic

  // ── Simulation humaine ──
  HUMAN_TYPING: { ... },            // Inchangé
};
```

---

## 7. Protocole WebSocket mis à jour

### Nouveaux messages serveur → client

| Type | Data | Quand |
|------|------|-------|
| `replan` | `{plan, reason}` | Re-planification déclenchée |
| `memory_update` | `{summary}` | Nouvelle page mémorisée |
| `highlight` | `{image, elementIndex, action}` | Avant exécution d'un clic |
| `tabs` | `{tabs: [{index, title, url, active}]}` | Liste des onglets mise à jour |
| `scroll_position` | `{scrollY, scrollHeight, percent}` | Position dans la page |
| `page_type` | `{type, hasForm, hasLogin, hasSearch}` | Type de page détecté |

### Nouveaux messages client → serveur

| Type | Data | Quand |
|------|------|-------|
| `instruction` | `{text}` | Instruction intermédiaire pendant l'exécution |
| `switch_tab` | `{index}` | Demande de changement d'onglet (mode manuel) |

---

## 8. Critères de validation par phase

### Phase 1 : L'agent peut lire
- [ ] Donner la tâche "va sur Wikipedia et dis-moi ce que tu vois sur la page de la Tour Eiffel"
- [ ] L'agent doit retourner un résumé du contenu (pas juste "j'ai vu des boutons")
- [ ] Le formatage IA contient des titres, paragraphes, et métadonnées de page

### Phase 2 : L'agent peut scroller
- [ ] Tâche : "va sur un long article et trouve l'information en bas de page"
- [ ] L'agent scrolle, re-observe, et trouve l'élément hors du viewport initial
- [ ] La position de scroll est visible dans le formatage IA

### Phase 3 : L'agent s'adapte
- [ ] Tâche : "cherche X sur Google" mais Google affiche un CAPTCHA
- [ ] L'agent re-planifie automatiquement vers DuckDuckGo ou Bing
- [ ] Le frontend affiche le nouveau plan

### Phase 4 : L'agent se souvient
- [ ] Tâche multi-page : "compare les prix de X sur 3 sites"
- [ ] L'agent retient les prix des pages précédentes pour comparer
- [ ] Le résultat final inclut les données de toutes les pages

### Phase 5 : L'agent est robuste
- [ ] Si un clic par index échoue, il retente par texte automatiquement
- [ ] Détection d'oscillation A→B→A→B et changement d'approche
- [ ] Les liens `target="_blank"` sont gérés (switch_tab automatique)

### Phase 6 : L'utilisateur peut guider
- [ ] Pendant une tâche, taper "non, clique plutôt sur le 2ème résultat"
- [ ] L'agent prend en compte l'instruction au prochain cycle
- [ ] L'élément ciblé est mis en évidence sur le screenshot avant le clic
