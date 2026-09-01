import { chromium } from 'playwright';
const url = 'file:///' + process.argv[2];
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
await p.goto(url);
await p.waitForFunction('document.title === "BITTI"', null, { timeout: 120000 });
console.log(await p.textContent('#out'));
console.log('\ntarayici:', (await b.version()));
await b.close();
