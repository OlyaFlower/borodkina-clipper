// Tiny local callback receiver for CI. Verifies, with the one x-clipper-timestamp, both signatures:
// x-clipper-signature (HMAC-SHA256 of "<timestamp>.<rawBody>", what the production admin checks) and
// x-clipper-signature-v2 (HMAC-SHA256 of "<timestamp>.<jobId>.<rawBody>", jobId from /video-jobs/<jobId>/callback).
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
    const jobId = (req.url ?? '').match(/\/video-jobs\/([A-Za-z0-9_-]{1,64})\/callback$/)?.[1];
    const mac = (text) => createHmac('sha256', secret).update(text).digest('hex');
    const matches = (header, text) => {
      const given = String(req.headers[header] ?? '');
      return /^[0-9a-f]{64}$/.test(given) && timingSafeEqual(Buffer.from(given), Buffer.from(mac(text)));
    };
    const fresh = /^\d{1,12}$/.test(timestamp) && Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;
    const good =
      req.method === 'POST' &&
      req.headers['content-type'] === 'application/json' &&
      fresh &&
      jobId !== undefined &&
      matches('x-clipper-signature', `${timestamp}.${raw}`) &&
      matches('x-clipper-signature-v2', `${timestamp}.${jobId}.${raw}`);
    if (!good) {
      res.writeHead(401).end();
      return;
    }
    accepted += 1;
    writeFileSync(join(outdir, `received-${accepted}.json`), raw);
    // The headers as sent, so the test can check the MACs with an independent HMAC (openssl).
    const headers = ['x-clipper-timestamp', 'x-clipper-signature', 'x-clipper-signature-v2'].map((h) => req.headers[h]);
    writeFileSync(join(outdir, `received-${accepted}.headers`), `${headers.join('\n')}\n${jobId}\n`);
    res.writeHead(204).end();
  });
}).listen(port, '127.0.0.1', () => console.log(`listening on ${port}`));
