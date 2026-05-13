'use strict';

function parseArgs(argv) {
  const args = { _: [] };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }

    const eq = token.indexOf('=');
    if (eq !== -1) {
      args[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }

  return args;
}

function boolArg(value, defaultValue = false) {
  if (value === undefined) return defaultValue;
  if (value === true) return true;
  if (value === false) return false;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

function intArg(value, defaultValue) {
  if (value === undefined) return defaultValue;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

module.exports = {
  parseArgs,
  boolArg,
  intArg
};
