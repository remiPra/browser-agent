// ── Phantom Agent v3 ─────────────────────────────────────────────────
// Orchestrateur principal : Planificateur → [Observer → Décideur → Exécuteur]

import { DOMObserver } from './dom-observer.js';
import { AIDecider } from './ai-decider.js';
import { Planner } from './planner.js';
import { CONFIG } from '../config.js';

export class PhantomAgent {
  constructor(browserController, eventCallback = null) {
    this.browser = browserController;
    this.observer = new DOMObserver(this.browser);
    this.decider = new AIDecider();
    this.planner = new Planner();
    this.emit = eventCallback || (() => {});
    this.isRunning = false;
    this.currentTask = null;
    this.actionHistory = [];
  }

  async init() {
    await this.browser.launch();
    this.emit('status', { status: 'ready', message: '🤖 Phantom Agent prêt !' });
  }

  // ── Exécuter une tâche ───────────────────────────────────────────
  async executeTask(userTask) {
    if (this.isRunning) {
      this.emit('error', { message: 'Une tâche est déjà en cours' });
      return;
    }

    this.isRunning = true;
    this.currentTask = userTask;
    this.actionHistory = [];
    this.decider.reset();

    try {
      // 🧠 Planification
      this.emit('phase', { phase: 'planning', message: '🧠 Planification...' });
      const plan = await this.planner.plan(userTask);
      this.emit('plan', { plan });

      if (plan.starting_url) {
        this.emit('phase', { phase: 'navigating', message: `📍 ${plan.starting_url}` });
        await this.browser.goto(plan.starting_url);
      }

      // 🔄 Boucle Agent
      this.emit('phase', { phase: 'executing', message: '🔄 Exécution...' });
      
      let step = 0;
      while (step < CONFIG.MAX_STEPS && this.isRunning) {
        step++;
        this.emit('step', { step, maxSteps: CONFIG.MAX_STEPS });

        // 👁️ Observer (tague les éléments + extrait)
        this.emit('phase', { phase: 'observing', message: `👁️ Observation (${step})...` });
        const observation = await this.observer.observe();
        const formattedDOM = this.observer.formatForAI(observation);

        if (observation?.screenshot) {
          this.emit('screenshot', {
            image: observation.screenshot,
            url: observation.url,
            title: observation.title,
          });
        }

        // 🎯 Décider
        this.emit('phase', { phase: 'deciding', message: '🎯 Réflexion...' });
        const decision = await this.decider.decide(userTask, observation, formattedDOM, this.actionHistory);
        this.emit('decision', { decision });

        // Actions terminales
        if (decision.action === 'done') {
          this.emit('complete', { result: decision.result, steps: step, history: this.actionHistory });
          break;
        }
        if (decision.action === 'error') {
          this.emit('error', { message: decision.message, steps: step, history: this.actionHistory });
          break;
        }

        // 🔧 Exécuter
        this.emit('phase', { phase: 'executing_action', message: `🔧 ${decision.reason || decision.action}` });
        const result = await this.executeAction(decision);

        this.actionHistory.push({
          step,
          action: `${decision.action}${decision.reason ? ' — ' + decision.reason : ''}`,
          result: result.success ? '✅ OK' : `❌ ${result.error}`,
          details: decision,
        });

        this.emit('action_result', { step, result, decision });
      }

      if (step >= CONFIG.MAX_STEPS) {
        this.emit('error', { message: `Max étapes atteint (${CONFIG.MAX_STEPS})`, history: this.actionHistory });
      }
    } catch (err) {
      this.emit('error', { message: `Erreur fatale: ${err.message}` });
    } finally {
      this.isRunning = false;
      this.currentTask = null;
    }
  }

  // ── Exécuter une action ──────────────────────────────────────────
  async executeAction(decision) {
    switch (decision.action) {
      case 'goto':
        return await this.browser.goto(decision.url);

      case 'click':
        if (decision.selector) return await this.browser.click(decision.selector);
        return await this.browser.clickByIndex(decision.index);

      case 'click_by_text':
        return await this.browser.clickByText(decision.text);

      case 'type':
        if (decision.selector) return await this.browser.type(decision.selector, decision.text, { clear: decision.clear });
        return await this.browser.typeByIndex(decision.index, decision.text, { clear: decision.clear });

      case 'type_by_placeholder':
        return await this.browser.typeByPlaceholder(decision.placeholder, decision.text, { clear: decision.clear });

      case 'press_key':
        return await this.browser.pressKey(decision.key);

      case 'scroll':
        return await this.browser.scroll(decision.direction || 'down', decision.amount || 500);

      case 'wait':
        return await this.browser.wait(decision.duration || 2000);

      case 'go_back':
        return await this.browser.goBack();

      case 'select':
        return await this.browser.select(decision.selector, decision.value);

      case 'hover':
        return await this.browser.hover(decision.selector);

      default:
        return { success: false, error: `Action inconnue: ${decision.action}` };
    }
  }

  stop() {
    console.log('⛔ Arrêt demandé');
    this.isRunning = false;
    this.emit('stopped', { message: 'Tâche arrêtée' });
  }

  async shutdown() {
    this.stop();
    await this.browser.close();
    this.emit('status', { status: 'shutdown', message: 'Agent arrêté' });
  }
}
