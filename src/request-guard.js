// The server only serves its own page on a loopback address. Other web pages
// open in the same browser must not reach it, so every request has to name a
// loopback host, and a browser Origin, when sent, has to be this server's own.
// Requests without an Origin come from non-browser clients such as curl.
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * @param {{ host?: string, origin?: string }} headers
 * @returns {boolean}
 */
export function isAllowedRequest({ host, origin }) {
  const ownOrigin = loopbackOrigin(host);
  if (!ownOrigin) return false;
  if (origin === undefined) return true;
  return parseUrl(origin)?.origin === ownOrigin;
}

/**
 * @param {string | undefined} host
 * @returns {string | null}
 */
function loopbackOrigin(host) {
  if (typeof host !== "string" || !host) return null;
  const url = parseUrl(`http://${host}`);
  if (!url || !LOOPBACK_HOSTNAMES.has(url.hostname)) return null;
  return url.origin;
}

/**
 * @param {string} value
 * @returns {URL | null}
 */
function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
