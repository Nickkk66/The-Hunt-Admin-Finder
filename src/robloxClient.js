import { RequestQueue, sleep } from './queue.js';
import { createLogger } from './log.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

export class RobloxApiError extends Error {
  constructor(status, url, body) {
    super(`Roblox API ${status} for ${url}${body ? `: ${String(body).slice(0, 300)}` : ''}`);
    this.name = 'RobloxApiError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/**
 * Roblox answered with a captcha / 2-step challenge. Nothing headless can solve
 * it, so callers should stop hammering that endpoint and tell the human.
 */
export class ChallengeRequiredError extends Error {
  constructor(url, challenge) {
    super(
      `Roblox demanded a ${challenge.type || 'captcha'} challenge for ${url}. ` +
        'Open roblox.com in a browser with this account, do whatever it asks, then restart.',
    );
    this.name = 'ChallengeRequiredError';
    this.url = url;
    this.challenge = challenge;
  }
}

export class RobloxClient {
  /**
   * @param {object} opts
   * @param {string} [opts.cookie] .ROBLOSECURITY value. Most endpoints we touch
   *   (group member pages, presence) require it these days.
   */
  constructor({
    cookie = '',
    maxConcurrent = 2,
    minIntervalMs = 250,
    timeoutMs = 20000,
    maxRetries = 5,
    logger = createLogger('roblox'),
  } = {}) {
    this.cookie = (cookie || '').trim();
    this.queue = new RequestQueue({ maxConcurrent, minIntervalMs });
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.log = logger;
    this.csrfToken = null;
  }

  get authenticated() {
    return this.cookie.length > 0;
  }

  #headers(extra = {}) {
    const headers = {
      accept: 'application/json',
      'user-agent': USER_AGENT,
      ...extra,
    };
    if (this.cookie) headers.cookie = `.ROBLOSECURITY=${this.cookie}`;
    if (this.csrfToken) headers['x-csrf-token'] = this.csrfToken;
    return headers;
  }

  async #once(url, { method = 'GET', body, headers = {} }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const init = { method, headers: this.#headers(headers), signal: controller.signal };
      if (body !== undefined) {
        init.body = typeof body === 'string' ? body : JSON.stringify(body);
        init.headers['content-type'] = 'application/json';
      }
      return await fetch(url, init);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Performs a request with CSRF handling, 429 backoff and 5xx retries. */
  async request(url, options = {}) {
    let attempt = 0;
    let csrfRetried = false;

    for (;;) {
      const res = await this.queue.run(() => this.#once(url, options));

      // Roblox hands back a fresh CSRF token on the first authenticated write.
      const freshToken = res.headers.get('x-csrf-token');
      if (freshToken && freshToken !== this.csrfToken) {
        this.csrfToken = freshToken;
        if (res.status === 403 && !csrfRetried) {
          csrfRetried = true;
          this.log.debug(`refreshed x-csrf-token, retrying ${url}`);
          continue;
        }
      }

      if (res.ok) {
        const text = await res.text();
        if (!text) return null;
        try {
          return JSON.parse(text);
        } catch {
          throw new RobloxApiError(res.status, url, text);
        }
      }

      const body = await res.text().catch(() => '');

      if (res.status === 429 && attempt < this.maxRetries) {
        attempt += 1;
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(60000, 5000 * 2 ** (attempt - 1));
        this.log.warn(`429 from ${url}; backing off ${Math.round(waitMs / 1000)}s (attempt ${attempt}/${this.maxRetries})`);
        this.queue.pauseFor(waitMs);
        await sleep(waitMs);
        continue;
      }

      if (res.status >= 500 && attempt < this.maxRetries) {
        attempt += 1;
        const waitMs = Math.min(30000, 1000 * 2 ** (attempt - 1));
        this.log.warn(`${res.status} from ${url}; retry in ${waitMs}ms (attempt ${attempt}/${this.maxRetries})`);
        await sleep(waitMs);
        continue;
      }

      if (res.status === 403) {
        const challengeType = res.headers.get('rblx-challenge-type');
        const challengeId = res.headers.get('rblx-challenge-id');
        if (challengeType || challengeId || /challenge/i.test(body)) {
          throw new ChallengeRequiredError(url, { type: challengeType, id: challengeId });
        }
      }

      if (res.status === 401 || res.status === 403) {
        throw new RobloxApiError(
          res.status,
          url,
          `${body}\nHint: this endpoint needs a valid .ROBLOSECURITY cookie. ` +
            (this.authenticated ? 'The cookie you supplied was rejected or expired.' : 'No cookie was supplied.'),
        );
      }

      throw new RobloxApiError(res.status, url, body);
    }
  }

  get(url) {
    return this.request(url, { method: 'GET' });
  }

  post(url, body) {
    return this.request(url, { method: 'POST', body });
  }

  /** Confirms the cookie works and returns the logged-in user, or null when anonymous. */
  async whoami() {
    if (!this.authenticated) return null;
    return this.get('https://users.roblox.com/v1/users/authenticated');
  }
}
