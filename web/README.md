# KSwarm Web UI

React + Vite project board for KSwarm.

The web UI is a diagnostic and operation surface for the KSwarm hub:

- project cards with lifecycle state
- phase-aware task board
- task start/completion/failure timestamps
- PO review feedback and recovery hints
- artifact preview/download links
- agent status and runtime-health visibility

The UI is intentionally thin. KSwarm server state is the source of truth; the browser only renders project state and sends explicit user actions such as approve, retry, dispatch, continue, deliver, or close.

## Development

```bash
npm install
npm run dev
```

By default the Vite server runs on `http://localhost:5173` or the next available port. The API server must be running separately:

```bash
cd ..
node src/server/index.js
```

## Release Notes

This UI follows the v0.8.0 Swarm reliability baseline: failed/blocked task states must stay visible, recovery actions must be explicit, and final deliverables should show user-facing artifact names instead of internal task IDs.
