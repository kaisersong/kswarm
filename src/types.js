/**
 * Swarm Hub — Core Types
 *
 * Minimal. Hub only knows about projects, tasks, and agent capabilities.
 * All transport goes through intent-broker protocol.
 */

// ─── Project ────────────────────────────────────────────────────────────────

export const PROJECT_STATUS = ['setup', 'planning', 'active', 'delivered', 'abandoned'];

/**
 * @typedef {Object} Project
 * @property {string} id
 * @property {string} name
 * @property {string} goal - Natural language goal
 * @property {Deliverable} deliverable
 * @property {'setup'|'planning'|'active'|'delivered'|'abandoned'} status
 * @property {string[]} taskIds
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * @typedef {Object} Deliverable
 * @property {string} description - What "done" looks like
 * @property {string[]} acceptanceCriteria
 * @property {string[]} expectedArtifacts
 */

// ─── Task (Hub's view — maps to broker's task object) ───────────────────────

export const TASK_STATUS = ['pending', 'dispatched', 'accepted', 'in_progress', 'submitted', 'approved', 'done', 'failed'];

/**
 * @typedef {Object} HubTask
 * @property {string} id - Same as broker taskId
 * @property {string} projectId
 * @property {string} title
 * @property {string} brief - Agent-readable description
 * @property {string[]} requiredCapabilities
 * @property {string[]} dependencies - Other taskIds that must complete first
 * @property {'pending'|'dispatched'|'accepted'|'in_progress'|'submitted'|'approved'|'done'|'failed'} status
 * @property {string|null} assignedAgent - participantId from broker
 * @property {TaskResult|null} result
 * @property {number} createdAt
 * @property {number} completedAt
 */

/**
 * @typedef {Object} TaskResult
 * @property {boolean} success
 * @property {string} summary
 * @property {Artifact[]} artifacts
 */

/**
 * @typedef {Object} Artifact
 * @property {string} name
 * @property {'file'|'text'|'url'} type
 * @property {string} content
 */

// ─── Agent Capability (Hub's registry — supplements broker presence) ────────

/**
 * @typedef {Object} AgentProfile
 * @property {string} participantId - Broker participant ID
 * @property {string} alias - e.g. "@xiaok", "@claude", "@codex"
 * @property {string[]} capabilities - ["typescript", "architecture", "testing", ...]
 * @property {string} role - "engineer" | "analyst" | "pm" | ...
 * @property {'available'|'busy'|'offline'} status
 */
