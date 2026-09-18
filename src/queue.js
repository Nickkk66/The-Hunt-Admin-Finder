/**
 * Serializes outbound requests so we stay under Roblox's rate limits.
 * Caps concurrency and enforces a minimum gap between request starts.
 */
export class RequestQueue {
  constructor({ maxConcurrent = 2, minIntervalMs = 250 } = {}) {
    this.maxConcurrent = Math.max(1, maxConcurrent);
    this.minIntervalMs = Math.max(0, minIntervalMs);
    this.active = 0;
    this.lastStart = 0;
    this.pending = [];
  }

  run(fn) {
    return new Promise((resolve, reject) => {
      this.pending.push({ fn, resolve, reject });
      this.#pump();
    });
  }

  /** Blocks every queued request for `ms` (used when Roblox hands back a 429). */
  pauseFor(ms) {
    this.lastStart = Math.max(this.lastStart, Date.now() + ms - this.minIntervalMs);
  }

  #pump() {
    if (this.active >= this.maxConcurrent || this.pending.length === 0) return;

    const wait = Math.max(0, this.lastStart + this.minIntervalMs - Date.now());
    if (wait > 0) {
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.#pump();
        }, wait);
      }
      return;
    }

    const job = this.pending.shift();
    this.active += 1;
    this.lastStart = Date.now();

    Promise.resolve()
      .then(job.fn)
      .then(job.resolve, job.reject)
      .finally(() => {
        this.active -= 1;
        this.#pump();
      });

    this.#pump();
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
