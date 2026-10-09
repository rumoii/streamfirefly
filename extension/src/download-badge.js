// Toolbar badge state for downloads started from each page (source context). Kept in memory only:
// a page's marks end with the page, and a restarted background refills them from task.list.
const ACTIVE_STATES = new Set(["queued", "starting", "running", "retrying", "pausing", "cancelling", "stopping"]);
const ATTENTION_STATES = new Set(["failed", "partial", "interrupted"]);
const MAX_CONTEXTS = 200, MAX_TASKS_PER_CONTEXT = 50;
export const BADGE_COLORS = Object.freeze({ brand: "#2a8f7b", active: "#2563eb", failed: "#dc2626", done: "#16a34a" });

export function createDownloadBadge() {
  const contexts = new Map(), contextOfTask = new Map();

  function remove(taskId) {
    const contextId = contextOfTask.get(taskId);
    if (!contextId) return "";
    contextOfTask.delete(taskId);
    const tasks = contexts.get(contextId);
    tasks?.delete(taskId);
    if (tasks && !tasks.size) contexts.delete(contextId);
    return contextId;
  }
  function dropContext(contextId) {
    for (const taskId of contexts.get(contextId)?.keys() || []) contextOfTask.delete(taskId);
    contexts.delete(contextId);
  }
  /** Records a task snapshot; returns the source context whose badge may have changed. */
  function apply(task) {
    const contextId = typeof task?.source_context_id === "string" ? task.source_context_id : "";
    if (!task?.id || !contextId) return "";
    const previous = contextOfTask.get(task.id);
    if (previous && previous !== contextId) remove(task.id);
    let tasks = contexts.get(contextId);
    if (!tasks) {
      while (contexts.size >= MAX_CONTEXTS) dropContext(contexts.keys().next().value);
      contexts.set(contextId, tasks = new Map());
    }
    tasks.delete(task.id);
    tasks.set(task.id, { state: String(task.state || ""), progress: Number(task.progress) || 0, live: Boolean(task.live_recording) });
    contextOfTask.set(task.id, contextId);
    while (tasks.size > MAX_TASKS_PER_CONTEXT) { const oldest = tasks.keys().next().value; tasks.delete(oldest); contextOfTask.delete(oldest); }
    return contextId;
  }
  function badgeFor(contextId) {
    const tasks = [...(contexts.get(contextId)?.values() || [])];
    const active = tasks.filter(task => ACTIVE_STATES.has(task.state));
    const measured = active.filter(task => !task.live);
    if (measured.length) {
      const average = Math.round(measured.reduce((sum, task) => sum + Math.min(100, Math.max(0, task.progress)), 0) / measured.length);
      return { text: `${Math.min(99, average)}%`, color: BADGE_COLORS.active };
    }
    if (active.length) return { text: "LIVE", color: BADGE_COLORS.active };
    // Failed, partial (e.g. subtitles failed) and interrupted (needs a key or authorization) all need the user.
    if (tasks.some(task => ATTENTION_STATES.has(task.state))) return { text: "✕", color: BADGE_COLORS.failed };
    const finished = tasks.filter(task => !["paused", "cancelled"].includes(task.state));
    if (finished.length && finished.every(task => task.state === "succeeded")) return { text: "✓", color: BADGE_COLORS.done };
    return null;
  }
  return { apply, remove, badgeFor };
}
