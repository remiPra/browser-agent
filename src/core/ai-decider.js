// ── AI Decider v3 ────────────────────────────────────────────────────
// Couche 🎯 DÉCIDEUR : Claude analyse la page et décide
// v3 : prompt clarifié sur l'indexation, anti-boucle renforcé

import Anthropic from '@anthropic-ai/sdk';
import { CONFIG } from '../config.js';

const SYSTEM_PROMPT = `Tu es Phantom Agent, un agent d'automatisation web. Tu contrôles un navigateur et accomplis des tâches.

À chaque étape tu reçois l'état de la page et tu choisis UNE action.

═══ INDEXATION ═══
Les éléments sont numérotés [0], [1], [2]... etc.
⚠️ L'index est GLOBAL et UNIQUE : le même [N] sert pour cliquer ET pour taper.
Par exemple, si le champ de recherche est [8], tu utilises "index": 8 pour y taper.

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
  {"action": "done", "result": "Résumé du résultat", "reason": "..."}
  {"action": "error", "message": "Description", "reason": "..."}

═══ RÈGLES CRITIQUES ═══
1. L'index [N] est le MÊME pour click et type. Si [8] est un textarea, tu tapes avec "index": 8
2. click_by_text est PLUS FIABLE que click par index — utilise-le quand possible
3. type_by_placeholder est PLUS FIABLE que type par index — utilise-le quand possible  
4. Après type, fais press_key Enter pour soumettre les formulaires de recherche
5. "clear": true pour vider un champ avant de taper dedans
6. ⛔ NE RÉPÈTE JAMAIS la même action 3x. Change d'approche !
7. Les cookies/RGPD sont gérés automatiquement, ignore-les
8. Si tu es bloqué, essaie une approche différente (autre sélecteur, texte, placeholder)

Réponds UNIQUEMENT avec le JSON.`;

export class AIDecider {
  constructor() {
    this.client = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });
  }

  async decide(task, observation, formattedDOM, actionHistory = []) {
    const loopWarning = this._detectLoop(actionHistory);

    // Construire le message
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

    // Contenu avec screenshot
    const content = [];
    if (observation?.screenshot) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: observation.screenshot },
      });
    }
    content.push({ type: 'text', text: msg });

    try {
      const response = await this.client.messages.create({
        model: CONFIG.CLAUDE_MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
      });

      const text = response.content[0]?.text || '';
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
