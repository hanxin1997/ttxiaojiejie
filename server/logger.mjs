function write(level, message, fields = {}) {
  const record = JSON.stringify({
    time: new Date().toISOString(),
    level,
    message,
    ...fields,
  });
  if (level === 'error' || level === 'warn') console.error(record);
  else console.log(record);
}

export const logger = Object.freeze({
  info: (message, fields) => write('info', message, fields),
  warn: (message, fields) => write('warn', message, fields),
  error: (message, fields) => write('error', message, fields),
});
