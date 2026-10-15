const dns = require('dns').promises;
const net = require('net');

// Guards server-side calls to a URL a user typed in (e.g. a self-hosted "Local AI" server):
// only http(s), and never an address inside the server's own network (loopback, private ranges,
// link-local/cloud metadata), so a saved URL cannot be used to reach internal services on the
// VPS. An operator who runs the AI server on the same machine can opt in with
// LOCAL_AI_ALLOW_PRIVATE=true.

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

async function assertPublicHttpUrl(raw, { allowPrivate = process.env.LOCAL_AI_ALLOW_PRIVATE === 'true' } = {}) {
  let url;
  try { url = new URL(String(raw || '').trim()); } catch { throw Object.assign(new Error('Enter the server address as a full URL, e.g. https://ai.example.com/v1'), { statusCode: 422 }); }
  if (!['http:', 'https:'].includes(url.protocol)) throw Object.assign(new Error('The server address must start with http:// or https://'), { statusCode: 422 });
  if (url.username || url.password) throw Object.assign(new Error('Do not put a username or password in the server address; use the API key field.'), { statusCode: 422 });
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) throw Object.assign(new Error(`Could not find the server "${host}". Check the address.`), { statusCode: 422 });
  if (addresses.some(isPrivateAddress)) throw Object.assign(new Error('That address is inside a private network, which the CareerZ server cannot reach. Use your AI server\'s public address.'), { statusCode: 422 });
  return url;
}

module.exports = { assertPublicHttpUrl, isPrivateAddress };
