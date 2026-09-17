/**
 * The hub is the single source of truth for the office.
 * - Events: { ts, agent, type, status, station?, ticket?, message, data? }. The station tells the office where the agent walks.
 * - State drives the side panel (view, tickets, steps, pending approval, results).
 * Everything is broadcast to every connected browser.
 */
const LOG_LIMIT = 200;
const STATUSES = new Set(['idle', 'walking', 'working', 'waiting', 'done', 'error']);
export const STATIONS = ['board', 'rack', 'terminal', 'bench', 'you', 'coffee'];

const pad = n => String(n).padStart(2, '0');
export const nowStamp = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

export function validateEvent(e) {
  if (!e || typeof e !== 'object') return 'event must be a JSON object';
  if (typeof e.agent !== 'string' || !e.agent) return 'event.agent is required';
  if (typeof e.type !== 'string' || !e.type) return 'event.type is required';
  if (typeof e.message !== 'string') return 'event.message is required';
  if (e.status != null && !STATUSES.has(e.status)) return `event.status must be one of ${[...STATUSES].join(', ')}`;
  if (e.station != null && !STATIONS.includes(e.station)) return `event.station must be one of ${STATIONS.join(', ')}`;
  return null;
}

export class Hub {
  constructor(initialState) {
    this.clients = new Set();
    this.log = [];
    this.state = { ...initialState };
    this.listeners = new Set();
  }

  addClient(send) {
    this.clients.add(send);
    send({ kind: 'hello', state: this.state, log: this.log });
    return () => this.clients.delete(send);
  }

  broadcast(msg) {
    for (const send of this.clients) {
      try { send(msg); } catch { /* a dead socket is cleaned up on close */ }
    }
  }

  /** Emit an office event. Transient events move the characters but are not kept in the log. */
  emit(e, { transient = false } = {}) {
    const evt = { ts: nowStamp(), agent: e.agent, type: e.type, status: e.status || 'working' };
    if (e.ticket) evt.ticket = e.ticket;
    if (e.station) evt.station = e.station;
    evt.message = e.message;
    if (e.data !== undefined) evt.data = e.data;
    if (transient) evt.transient = true;
    else {
      this.log.unshift(evt);
      if (this.log.length > LOG_LIMIT) this.log.pop();
    }
    this.broadcast({ kind: 'event', event: evt });
    for (const fn of this.listeners) fn(evt);
    return evt;
  }

  onEvent(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.broadcast({ kind: 'state', state: this.state });
  }

  reset(initialState) {
    this.log = [];
    this.state = { ...initialState };
    this.broadcast({ kind: 'reset', state: this.state });
  }
}
