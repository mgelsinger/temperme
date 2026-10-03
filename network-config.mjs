import { isIP } from 'node:net';

export function isLoopback(address) {
  return address === 'localhost' || address === '::1' || address === '127.0.0.1' || address === '::ffff:127.0.0.1';
}

export function networkConfig(env = process.env) {
  const port = Number(env.TEMPERME_PORT || 8765);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid TEMPERME_PORT');
  const bindHost = env.TEMPERME_BIND_HOST || '127.0.0.1';
  if (!isIP(bindHost) && bindHost !== 'localhost') throw new Error('TEMPERME_BIND_HOST must be an IP address or localhost');
  const httpsProxy = env.TEMPERME_HTTPS_PROXY === '1';
  if (env.TEMPERME_HTTPS_PROXY && !['0', '1'].includes(env.TEMPERME_HTTPS_PROXY)) throw new Error('TEMPERME_HTTPS_PROXY must be 0 or 1');
  if (!httpsProxy && !isLoopback(bindHost)) throw new Error('A LAN bind requires TEMPERME_HTTPS_PROXY=1 behind a private HTTPS reverse proxy');
  const origins = env.TEMPERME_PUBLIC_ORIGINS?.split(',').map(value => value.trim()).filter(Boolean)
    || (httpsProxy ? [] : [`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...(bindHost === '::1' ? [`http://[::1]:${port}`] : [])]);
  if (!origins.length || origins.length > 8) throw new Error('Configure one to eight exact TEMPERME_PUBLIC_ORIGINS');
  const originByHost = new Map();
  for (const origin of origins) {
    let url;
    try { url = new URL(origin); } catch { throw new Error('Invalid TEMPERME_PUBLIC_ORIGINS'); }
    if (url.origin !== origin || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use exact origins without paths in TEMPERME_PUBLIC_ORIGINS');
    if (httpsProxy ? url.protocol !== 'https:' : url.protocol !== 'http:' || !isLoopback(url.hostname.replace(/^\[|\]$/g, '')) || url.port !== String(port)) {
      throw new Error(httpsProxy ? 'Reverse proxy origins must use HTTPS' : 'Native HTTP origins must use loopback and TEMPERME_PORT');
    }
    originByHost.set(url.host, origin);
  }
  return { port, bindHost, httpsProxy, origins, originByHost };
}

// The configured proxy is the only ingress in Docker. Do not infer trust from
// client-controlled X-Forwarded-Host or X-Forwarded-Proto headers.
export function requestOrigin(config, headers) {
  return typeof headers.host === 'string' ? config.originByHost.get(headers.host) || null : null;
}

export function sameOriginJson(config, headers) {
  const origin = requestOrigin(config, headers);
  return !!origin && headers.origin === origin && /^application\/json(?:\s*;|$)/i.test(headers['content-type'] || '');
}

export function sessionCookie(id, config) {
  return `temperme_session=${id}; HttpOnly; SameSite=Strict; Path=/${config.httpsProxy ? '; Secure' : ''}`;
}
