// Small in-process semaphores so multiple linked sessions cannot all start
// large media conversions/downloads at once and spike the Node heap.
//
// Two independent pools, so a slow download can never block a reply:
//   'heavy' - downloads / conversions (.play, .sticker, view-once fetch).
//             Default 1 at a time (MEDIA_MAX_CONCURRENT).
//   'send'  - sending an already-prepared command image/video (.menu, .ping…).
//             Default 2 at a time (MEDIA_SEND_CONCURRENT).
function makePool(limit) {
  const queue = [];
  let active = 0;
  function pump() {
    while (active < limit && queue.length) {
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
  return {
    limit,
    run(task) {
      return new Promise((resolve, reject) => {
        queue.push({ task, resolve, reject });
        pump();
      });
    },
    stats: () => ({ maxConcurrent: limit, active, queued: queue.length })
  };
}

const POOLS = {
  heavy: makePool(Math.max(1, Math.floor(Number(process.env.MEDIA_MAX_CONCURRENT || 1)))),
  send: makePool(Math.max(1, Math.floor(Number(process.env.MEDIA_SEND_CONCURRENT || 2))))
};

export function withMediaSlot(task, { pool = 'heavy' } = {}) {
  return (POOLS[pool] || POOLS.heavy).run(task);
}

export function mediaGuardStats() {
  return { heavy: POOLS.heavy.stats(), send: POOLS.send.stats() };
}
