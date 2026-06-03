export const INTERACTION_BUDGET_MS = 8;

const frameTasks = new Map();
const performanceStats = new Map();
let frameScheduled = false;

function nowMs() {
  return globalThis.performance?.now ? globalThis.performance.now() : Date.now();
}

export function scheduleFrameTask(key, task) {
  frameTasks.set(key, { task, queuedAt: nowMs() });
  if (frameScheduled) return;
  frameScheduled = true;
  requestAnimationFrame(drainFrameTasks);
}

function drainFrameTasks() {
  const tasks = [...frameTasks.entries()];
  frameTasks.clear();
  frameScheduled = false;
  const frameStart = nowMs();
  for (let index = 0; index < tasks.length; index += 1) {
    const [key, queued] = tasks[index];
    const run = typeof queued === "function" ? queued : queued.task;
    if (queued?.queuedAt) {
      recordMeasure(`frameTask:${key}:queue`, nowMs() - queued.queuedAt, { key }, { warn: false, budgeted: false });
    }
    const workStart = nowMs();
    run();
    recordMeasure(`frameTask:${key}:work`, nowMs() - workStart, { key });
    if (nowMs() - frameStart < INTERACTION_BUDGET_MS || index === tasks.length - 1) continue;
    // A busy IRC client can ask for sidebar, message, badge, and hub refreshes
    // in the same tick. Carry the rest into the next frame so one burst does
    // not steal the user's whole paint budget.
    tasks.slice(index + 1).forEach(([remainingKey, remainingTask]) => {
      if (!frameTasks.has(remainingKey)) frameTasks.set(remainingKey, remainingTask);
    });
    if (frameTasks.size) {
      frameScheduled = true;
      requestAnimationFrame(drainFrameTasks);
    }
    break;
  }
}

export function requestIdle(task, timeout = 700) {
  if ("requestIdleCallback" in window) {
    return window.requestIdleCallback(task, { timeout });
  }
  return setTimeout(() => task({ didTimeout: true, timeRemaining: () => 0 }), Math.min(timeout, 120));
}

export function cancelIdle(handle) {
  if (!handle) return;
  if ("cancelIdleCallback" in window) window.cancelIdleCallback(handle);
  else clearTimeout(handle);
}

export function startInteractionMonitor() {
  if (!("PerformanceObserver" in window)) return;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const latency = entry.processingStart - entry.startTime;
        const total = entry.duration;
        if (latency > INTERACTION_BUDGET_MS || total > INTERACTION_BUDGET_MS * 2) {
          console.warn("[PERF] Interaction exceeded frame budget", {
            name: entry.name,
            latency: Math.round(latency * 10) / 10,
            total: Math.round(total * 10) / 10,
          });
        }
      }
    });
    observer.observe({ type: "event", buffered: true, durationThreshold: INTERACTION_BUDGET_MS });
  } catch (_) { }
}

// Keep lightweight rolling stats so performance work can be driven by numbers instead of screenshots.
function recordMeasure(name, duration, detail = {}, options = {}) {
  const { warn = true, budgeted = true } = options;
  const previous = performanceStats.get(name) || { count: 0, total: 0, max: 0, last: 0, budgetMisses: 0, lastDetail: {} };
  const missedBudget = budgeted && duration > INTERACTION_BUDGET_MS;
  const next = {
    count: previous.count + 1,
    total: previous.total + duration,
    max: Math.max(previous.max, duration),
    last: duration,
    budgetMisses: previous.budgetMisses + (missedBudget ? 1 : 0),
    lastDetail: detail || {},
  };
  performanceStats.set(name, next);
  if (warn && missedBudget) {
    console.warn(`[PERF] ${name} took ${duration.toFixed(1)}ms`);
  }
}

export function startInteraction(name, detail = {}) {
  return { name, detail, startedAt: nowMs() };
}

export function finishInteraction(mark, phase = "work", detail = {}, options = {}) {
  if (!mark?.name || !Number.isFinite(mark.startedAt)) return null;
  const duration = nowMs() - mark.startedAt;
  recordMeasure(`interaction:${mark.name}:${phase}`, duration, { ...mark.detail, ...detail }, options);
  return duration;
}

export function finishInteractionOnFrame(mark, phase = "frame-ready", detail = {}) {
  if (!mark?.name) return;
  // requestAnimationFrame gives us a practical browser-side "ready for paint"
  // mark. We keep it separate from CPU work because refresh rate can dominate
  // this number even when the app work itself stays under budget.
  requestAnimationFrame(() => finishInteraction(mark, phase, detail, { warn: false, budgeted: false }));
}

export function measureTask(name, task) {
  const start = nowMs();
  const result = task();
  recordMeasure(name, nowMs() - start);
  return result;
}

export async function measureAsyncTask(name, task) {
  const start = nowMs();
  try {
    return await task();
  } finally {
    recordMeasure(name, nowMs() - start);
  }
}

export function getPerformanceSnapshot() {
  return Object.fromEntries([...performanceStats.entries()].map(([name, value]) => [name, {
    count: value.count,
    last: Math.round(value.last * 10) / 10,
    max: Math.round(value.max * 10) / 10,
    average: Math.round((value.total / value.count) * 10) / 10,
    budgetMisses: value.budgetMisses || 0,
    lastDetail: value.lastDetail || {},
  }]));
}
