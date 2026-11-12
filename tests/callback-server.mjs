// Tiny local callback receiver for CI. Verifies x-clipper-signature (HMAC-SHA256 of "<timestamp>.<rawBody>").
// Usage: node callback-server.mjs <port> <outdir>  (env CLIPPER_CALLBACK_SECRET, FAIL_FIRST=1 answers the first request with 503)
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [port, outdir] = [Number(process.argv[2]), process.argv[3]];
const secret = process.env.CLIPPER_CALLBACK_SECRET;
let seen = 0;
let accepted = 0;

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    seen += 1;
    if (process.env.FAIL_FIRST === '1' && seen === 1) {
      res.writeHead(503).end();
      return;
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    const timestamp = req.headers['x-clipper-timestamp'] ?? '';
    const given = String(req.headers['x-clipper-signature'] ?? '');
    const expected = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
    const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;
    const good =
      req.method === 'POST' &&
      req.headers['content-type'] === 'application/json' &&
      fresh &&
      /^[0-9a-f]{64}$/.test(given) &&
      timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    if (!good) {
      res.writeHead(401).end();
      return;
    }
    accepted += 1;
    writeFileSync(join(outdir, `received-${accepted}.json`), raw);
    res.writeHead(204).end();
  });
}).listen(port, '127.0.0.1', () => console.log(`listening on ${port}`));
