// Small in-process semaphore so multiple linked sessions cannot all start
// large media conversions/downloads at once and spike the Node heap.
const MAX_CONCURRENT = Math.max(1, Math.floor(Number(process.env.MEDIA_MAX_CONCURRENT || 1)));
const queue = [];
let active = 0;

function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    active += 1;
    Promise.resolve()
      .then(job.task)
      .then(job.resolve, job.reject)
      .finally(() => {
        active -= 1;
        pump();
      });
  }
}

export function withMediaSlot(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });
}

export function mediaGuardStats() {
  return { maxConcurrent: MAX_CONCURRENT, active, queued: queue.length };
}
