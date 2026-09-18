const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function emit(level, scope, args) {
  if (LEVELS[level] < threshold) return;
  const prefix = scope ? `[${stamp()}] [${level}] [${scope}]` : `[${stamp()}] [${level}]`;
  const stream = level === 'error' || level === 'warn' ? console.error : console.log;
  stream(prefix, ...args);
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
