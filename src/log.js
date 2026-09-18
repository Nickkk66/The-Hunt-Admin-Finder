const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

const sinks = new Set();

/** Lets the local dashboard tail the same lines that go to the console. */
export function addSink(fn) {
  sinks.add(fn);
  return () => sinks.delete(fn);
}

function emit(level, scope, args) {
  if (LEVELS[level] < threshold) return;
  const prefix = scope ? `[${stamp()}] [${level}] [${scope}]` : `[${stamp()}] [${level}]`;
  const stream = level === 'error' || level === 'warn' ? console.error : console.log;
  stream(prefix, ...args);

  if (sinks.size) {
    const line = { at: Date.now(), level, scope, message: args.map(String).join(' ') };
    for (const sink of sinks) {
      try {
        sink(line);
      } catch {
        /* a broken sink must never break logging */
      }
    }
  }
}

export function createLogger(scope = '') {
  return {
    debug: (...a) => emit('debug', scope, a),
    info: (...a) => emit('info', scope, a),
    warn: (...a) => emit('warn', scope, a),
    error: (...a) => emit('error', scope, a),
    child: (sub) => createLogger(scope ? `${scope}:${sub}` : sub),
  };
}

export const log = createLogger();
