# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Phantom Agent is an autonomous browser automation agent. Users provide natural-language tasks via a web chat interface; the agent plans, observes the page, decides on actions, and executes them in a Playwright-controlled browser. It uses the Anthropic Claude API for planning and decision-making.

The codebase and all comments/prompts are in **French**.

## Commands

```bash
npm start            # Launch (browser visible, port 3001)
npm run dev          # Launch with --watch auto-reload
npm run headless     # Launch headless (HEADLESS=true)
```

Playwright browsers must be installed first: `npx playwright install chromium`

No test framework or linter is configured.

## Configuration

All config is in `src/config.js`. The API key can also be set via `ANTHROPIC_API_KEY` env var. Key tunables: `MAX_STEPS` (25), `DOM_MAX_ELEMENTS` (150), `DOM_MAX_DEPTH` (8), `SCREENSHOT_QUALITY` (75).

## Architecture

**ES modules** (`"type": "module"` in package.json). Entry point is `src/index.js`.

### Runtime flow

1. Express + WebSocket server starts on port 3001
2. Each WebSocket connection creates a `PhantomAgent` instance
3. On a `task` message, the agent loop runs: **Plan -> [Observe -> Decide -> Execute]**

### Core modules (`src/core/`)

- **`agent.js`** — `PhantomAgent` orchestrator. Owns the loop: calls planner once, then iterates observe/decide/execute up to `MAX_STEPS`. Dispatches events to the WebSocket client via an `emit` callback. Maps AI decision JSON to `BrowserController` method calls in `executeAction()`.

- **`planner.js`** — `Planner`. Single Claude API call that decomposes a user task into a JSON plan with `starting_url`, `steps[]`, and `success_criteria`. Falls back to a minimal plan if the API fails. Note: the planner prompt redirects "Google" searches to DuckDuckGo to avoid CAPTCHAs.

- **`ai-decider.js`** — `AIDecider`. Each step sends Claude the current task, formatted DOM, screenshot (as base64 image), and last 6 action history entries. Expects a single JSON action in response. Has loop detection: warns the AI if the same action repeats 3x or 3 consecutive failures occur.

- **`dom-observer.js`** — `DOMObserver`. Injects `data-phantom-id` attributes onto interactive elements in the page, then extracts a structured list. This is the critical sync mechanism: the index `[N]` the AI sees is the same `data-phantom-id` Playwright uses to locate elements. Elements are categorized as `field` (inputs) or `action` (buttons/links). `formatForAI()` produces a text representation with separate sections for fields and actions.

- **`browser-controller.js`** — `BrowserController`. Playwright wrapper with stealth mode (hides webdriver fingerprint, fakes plugins/languages). Supports session persistence via `storageState` in `sessions/`. Has human-like typing simulation (variable delays, typos on adjacent QWERTY keys, hesitation pauses). Auto-dismisses cookie/GDPR popups on navigation. All click/type methods have variants: by index (`data-phantom-id`), by text, by placeholder, or by CSS selector.

### Frontend

`public/index.html` — Single-file SPA dashboard. Connects via WebSocket, renders chat, live screenshots, action history, and plan display.

### WebSocket protocol

Messages are `{type, data}` JSON. Server sends: `status`, `phase`, `plan`, `step`, `screenshot`, `decision`, `action_result`, `complete`, `error`, `stopped`. Client sends: `task`, `stop`, `navigate`, `save_session`, `screenshot_request`.

### Session persistence

Browser state (cookies, localStorage) is saved to `sessions/default.json` on close and restored on launch.

## Key Design Decisions

- **data-phantom-id sync**: The Observer tags DOM elements with `data-phantom-id=N` *in the live page*. The AI references `[N]` and the BrowserController locates by `[data-phantom-id="N"]`. This avoids index drift between observation and execution.
- **Stateless AI calls**: Each decide() call is independent (no conversation history in the API). Context is provided via the formatted DOM + action history in a single user message.
- **Human typing simulation**: Configurable typo rate and hesitation pauses to reduce bot detection. Typos are based on adjacent QWERTY keys and auto-corrected with Backspace.
