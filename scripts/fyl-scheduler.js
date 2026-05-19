// scripts/fyl-scheduler.js — cola de tareas post-paint (idle / visible / critical)

const queues = {
  critical: [],
  visible: [],
  idle: [],
};

let flushScheduled = false;

function runQueue(name) {
  const q = queues[name];
  while (q.length) {
    const fn = q.shift();
    try {
      fn();
    } catch (e) {
      console.warn(`[fyl-scheduler] Error en tarea ${name}:`, e);
    }
  }
}

function flushQueues() {
  flushScheduled = false;
  runQueue("critical");
  runQueue("visible");

  const runIdle = () => {
    runQueue("idle");
  };

  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(runIdle, { timeout: 2500 });
  } else {
    setTimeout(runIdle, 120);
  }
}

function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  const schedule = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn) => setTimeout(fn, 0);
  schedule(flushQueues);
}

/**
 * @param {() => void} fn
 * @param {{ priority?: 'critical'|'visible'|'idle', timeout?: number }} [options]
 */
export function fylSchedule(fn, options = {}) {
  if (typeof fn !== "function") return;
  const priority = options.priority === "critical" || options.priority === "visible" ? options.priority : "idle";
  queues[priority].push(fn);
  scheduleFlush();
}

export function fylScheduleIdle(fn, timeoutMs = 2000) {
  if (typeof fn !== "function") return;
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(() => {
      try {
        fn();
      } catch (e) {
        console.warn("[fyl-scheduler] idle error:", e);
      }
    }, { timeout: timeoutMs });
    return;
  }
  setTimeout(fn, Math.min(timeoutMs, 400));
}

if (typeof window !== "undefined") {
  window.fylSchedule = fylSchedule;
  window.fylScheduleIdle = fylScheduleIdle;
}
