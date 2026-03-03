// ── Planner ──────────────────────────────────────────────────────────
// Couche 🧠 PLANIFICATEUR : décompose les tâches complexes en sous-tâches

import Anthropic from '@anthropic-ai/sdk';
import { CONFIG } from '../config.js';

const PLANNER_PROMPT = `Tu es le planificateur de Phantom Agent, un agent d'automatisation web.
L'utilisateur te donne une tâche à accomplir dans un navigateur web.

Ton rôle : décomposer cette tâche en étapes claires et ordonnées.

Réponds au format JSON :
{
  "task_understanding": "Ce que tu comprends de la tâche",
  "starting_url": "URL de départ (ou null si pas évident)",
  "steps": [
    {
      "step": 1,
      "description": "Description claire de l'étape",
      "expected_result": "Ce qu'on devrait voir après cette étape"
    }
  ],
  "success_criteria": "Comment savoir que la tâche est terminée",
  "potential_issues": ["Problème potentiel 1", "Problème potentiel 2"]
}

RÈGLES :
- Sois précis et concret
- Chaque étape doit être une action réalisable dans un navigateur
- Si l'URL de départ est évidente, mets-la
- ⚠️ IMPORTANT : quand l'utilisateur dit "cherche sur Google" ou "fais une recherche", utilise DuckDuckGo (https://duckduckgo.com) au lieu de Google. Google bloque les robots. Si l'utilisateur insiste sur Google spécifiquement, utilise Google mais préviens du risque de CAPTCHA.
- 3 à 10 étapes maximum
- Réponds UNIQUEMENT avec le JSON`;

export class Planner {
  constructor() {
    this.client = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });
  }

  // ── Planifier une tâche ──────────────────────────────────────────
  async plan(userTask) {
    console.log(`🧠 Planification de la tâche : "${userTask}"`);

    try {
      const response = await this.client.messages.create({
        model: CONFIG.CLAUDE_MODEL,
        max_tokens: 2048,
        system: PLANNER_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Tâche à planifier : ${userTask}`,
          },
        ],
      });

      const text = response.content[0]?.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      
      if (!jsonMatch) {
        console.error('❌ Plan non parseable:', text);
        return this.fallbackPlan(userTask);
      }

      const plan = JSON.parse(jsonMatch[0]);
      console.log(`📋 Plan créé : ${plan.steps.length} étapes`);
      plan.steps.forEach(s => console.log(`   ${s.step}. ${s.description}`));
      
      return plan;
    } catch (err) {
      console.error('❌ Erreur planification:', err.message);
      return this.fallbackPlan(userTask);
    }
  }

  // ── Plan de secours (sans IA) ────────────────────────────────────
  fallbackPlan(userTask) {
    return {
      task_understanding: userTask,
      starting_url: null,
      steps: [
        {
          step: 1,
          description: `Accomplir la tâche : ${userTask}`,
          expected_result: 'Tâche accomplie',
        },
      ],
      success_criteria: 'La tâche demandée est réalisée',
      potential_issues: ['Plan simplifié - l\'IA planificateur n\'a pas pu décomposer la tâche'],
    };
  }
}
