'use strict';
const { attemptOcr } = require('./dist/ocr/index.js');
const { terminateOcrWorker } = require('./dist/ocr/textOcr.js');
const fs = require('fs');

const fullPath = String.raw`C:\Users\Fatih\AppData\Local\Temp\claude\c--Users-Fatih-Desktop-Programming-insider-API\9068811f-95fd-4a36-8b06-36e7792efa76\scratchpad\ocr-proto\pdfs\9116211.pdf`;

(async () => {
  const buf = fs.readFileSync(fullPath);
  const start = Date.now();
  const result = await attemptOcr(
    buf,
    'Michael T. McCaul',
    '2026-07-08',
    '9116211',
    'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/9116211.pdf',
  );
  console.log('elapsed ms:', Date.now() - start, 'matched:', result.matched, 'succeeded:', result.succeeded, 'rows:', result.rows.length);
  fs.writeFileSync('cli-rows.json', JSON.stringify(result.rows, null, 2));
  await terminateOcrWorker();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
