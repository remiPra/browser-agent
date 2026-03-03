// ── AI Decider v3 ────────────────────────────────────────────────────
// Couche 🎯 DÉCIDEUR : Claude analyse la page et décide
// v3 : prompt clarifié sur l'indexation, anti-boucle renforcé

import OpenAI from 'openai';
import { CONFIG } from '../config.js';

const SYSTEM_PROMPT = `Tu es Phantom Agent, un agent d'automatisation web autonome. Tu contrôles un navigateur et accomplis des tâches.

À chaque étape tu reçois :
- Un screenshot de la page (image)
- Le contenu structuré de la page (titres, paragraphes, résultats de recherche...)
- Les éléments interactifs numérotés [0], [1], [2]...
- L'historique de tes dernières actions

Tu dois analyser TOUT ce contenu pour comprendre la page, puis choisir UNE action.

═══ INDEXATION ═══
Les éléments sont numérotés [0], [1], [2]... etc.
⚠️ L'index est GLOBAL et UNIQUE : le même [N] sert pour cliquer ET pour taper.

═══ ACTIONS ═══

Navigation :
  {"action": "goto", "url": "https://...", "reason": "..."}
  {"action": "go_back", "reason": "..."}
  {"action": "scroll", "direction": "down", "amount": 500, "reason": "..."}
  {"action": "wait", "duration": 2000, "reason": "..."}

Clic (préfère click_by_text quand le texte est visible) :
  {"action": "click", "index": 5, "reason": "..."}
  {"action": "click_by_text", "text": "Texte du bouton", "reason": "..."}

Saisie (préfère type_by_placeholder quand il y a un placeholder) :
  {"action": "type", "index": 8, "text": "ma recherche", "clear": true, "reason": "..."}
  {"action": "type_by_placeholder", "placeholder": "Rechercher", "text": "ma recherche", "clear": true, "reason": "..."}
  {"action": "press_key", "key": "Enter", "reason": "..."}

Fin :
  {"action": "done", "result": "Résumé DÉTAILLÉ du résultat avec les données trouvées", "reason": "..."}
  {"action": "error", "message": "Description", "reason": "..."}

═══ CONTENU STRUCTURÉ ═══
Tu reçois le contenu de la page organisé en sections :
- 📊 Type de page : search_results, article, login, form, listing, homepage
- Résultats de recherche : titre + snippet + URL de chaque résultat
- Titres : hiérarchie h1 → h6
- Contenu principal : paragraphes, listes
- Champs de saisie et boutons/liens

UTILISE CE CONTENU pour :
- Lire et comprendre ce qui est affiché
- Trouver l'information demandée par l'utilisateur
- Choisir le bon lien/bouton à cliquer
- Rédiger un résumé riche quand tu as terminé (action "done")

═══ RÈGLES CRITIQUES ═══
1. L'index [N] est le MÊME pour click et type
2. click_by_text est PLUS FIABLE que click par index — utilise-le quand possible
3. type_by_placeholder est PLUS FIABLE que type par index — utilise-le quand possible
4. Après type, fais press_key Enter pour soumettre les formulaires de recherche
5. "clear": true pour vider un champ avant de taper dedans
6. ⛔ NE RÉPÈTE JAMAIS la même action 3x. Change d'approche !
7. Les cookies/RGPD sont gérés automatiquement, ignore-les
8. Si tu es bloqué, essaie une approche différente (autre sélecteur, texte, placeholder)
9. Quand la tâche est terminée, utilise "done" avec un résumé RICHE incluant les données collectées
10. Si la page contient l'information demandée, LIS-LA depuis le contenu structuré avant de déclarer "done"

Réponds UNIQUEMENT avec le JSON.`;

export class AIDecider {
  constructor() {
    this.client = new OpenAI({
      apiKey: CONFIG.ZAI_API_KEY,
      baseURL: CONFIG.ZAI_BASE_URL,
    });
  }

  async decide(task, observation, formattedDOM, actionHistory = []) {
    const loopWarning = this._detectLoop(actionHistory);

    // Construire le message texte
    let msg = `🎯 TÂCHE : ${task}\n\n`;

    if (actionHistory.length > 0) {
      msg += `── Historique (${actionHistory.length}) ──\n`;
      for (const e of actionHistory.slice(-6)) {
        msg += `  ${e.step}. ${e.action} → ${e.result}\n`;
      }
      msg += '\n';
    }

    if (loopWarning) {
      msg += `🚨 ${loopWarning}\n\n`;
    }

    msg += `── État de la page ──\n${formattedDOM}\n`;
    msg += `\nProchaine action ? (JSON)`;

    // Construire les messages au format OpenAI (compatible Z.ai)
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
    ];

    const userContent = [];
    if (observation?.screenshot) {
      userContent.push({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${observation.screenshot}` },
      });
    }
    userContent.push({ type: 'text', text: msg });
    messages.push({ role: 'user', content: userContent });

    try {
      // Utiliser le modèle vision quand on envoie un screenshot
      const model = observation?.screenshot ? CONFIG.ZAI_VISION_MODEL : CONFIG.ZAI_MODEL;
      const response = await this.client.chat.completions.create({
        model,
        max_tokens: CONFIG.MAX_TOKENS_DECIDER || 2048,
        messages,
      });

      const text = response.choices[0]?.message?.content || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.error('❌ Réponse non JSON:', text.slice(0, 200));
        return { action: 'error', message: 'Réponse IA invalide' };
      }

      const decision = JSON.parse(jsonMatch[0]);
      console.log(`🤖 Décision: ${decision.action} — ${decision.reason || ''}`);
      return decision;
    } catch (err) {
      console.error('❌ Erreur API:', err.message);
      return { action: 'error', message: `Erreur API: ${err.message}` };
    }
  }

  _detectLoop(history) {
    if (history.length < 3) return null;

    const last3 = history.slice(-3);
    
    // Même action répétée 3x
    const keys = last3.map(a => {
      const d = a.details || {};
      return `${d.action}-${d.index ?? ''}-${d.text ?? ''}-${d.key ?? ''}`;
    });
    if (keys[0] === keys[1] && keys[1] === keys[2]) {
      return `BOUCLE DÉTECTÉE : tu as fait "${last3[0].action}" 3 fois. CHANGE D'APPROCHE. Utilise click_by_text ou type_by_placeholder.`;
    }

    // 3 échecs consécutifs
    if (last3.every(a => a.result.startsWith('❌'))) {
      return `3 ÉCHECS CONSÉCUTIFS. Essaie une approche complètement différente.`;
    }

    return null;
  }

  reset() {}
}
