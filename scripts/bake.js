#!/usr/bin/env node
/**
 * scripts/bake.js
 *
 * Lee live/index.html (source of truth, con APIs activas) y genera index.html
 * (versión pública) con datos pre-bakeados de FMP y keys API eliminadas.
 *
 * Ejecutado por GitHub Actions diariamente (cron 8:00 UTC).
 *
 * Variables de entorno:
 *   FMP_KEY  → API key de Financial Modeling Prep (GitHub Secret)
 *
 * Uso local (testing):
 *   FMP_KEY=tu_key node scripts/bake.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'live', 'index.html');
const OUT = path.join(ROOT, 'index.html');

const FMP_KEY = process.env.FMP_KEY;
if (!FMP_KEY) {
  console.error('✗ FMP_KEY no definida (variable de entorno requerida)');
  process.exit(1);
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers HTTP
// ───────────────────────────────────────────────────────────────────────────
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse: ${e.message} · raw: ${data.slice(0,200)}`)); }
      });
    }).on('error', reject);
  });
}

async function fmpProfile(sym) {
  const url = `https://financialmodelingprep.com/stable/profile?symbol=${encodeURIComponent(sym)}&apikey=${FMP_KEY}`;
  const d = await fetchJson(url);
  if (d && d['Error Message']) throw new Error(`FMP profile ${sym}: ${d['Error Message']}`);
  const q = Array.isArray(d) ? d[0] : d;
  if (!q || !q.price) return null;
  return {
    price: q.price,
    changesPercentage: q.changesPercentage ?? q.changePercentage ?? 0,
    marketCap: q.marketCap,
    fullTimeEmployees: q.fullTimeEmployees,
    range: q.range,
    beta: q.beta
  };
}

async function fmpHistorical(sym, fromDate, toDate) {
  const url = `https://financialmodelingprep.com/stable/historical-price-eod/light?symbol=${encodeURIComponent(sym)}&from=${fromDate}&to=${toDate}&apikey=${FMP_KEY}`;
  const d = await fetchJson(url);
  if (d && d['Error Message']) throw new Error(`FMP hist ${sym}: ${d['Error Message']}`);
  let arr = Array.isArray(d) ? d : (d.historical || d.data || []);
  if (!arr.length) return null;
  arr = arr.map(x => ({ date: x.date, price: parseFloat(x.price ?? x.close ?? x.adjClose) })).filter(x => x.date && !isNaN(x.price));
  arr.sort((a, b) => a.date.localeCompare(b.date));
  return arr.length ? arr : null;
}

// ───────────────────────────────────────────────────────────────────────────
// Extracción de FMP_SYM y tickers de empresas desde live/index.html
// ───────────────────────────────────────────────────────────────────────────
function extractFmpSym(html) {
  const m = html.match(/const FMP_SYM\s*=\s*\{([\s\S]*?)\};/);
  if (!m) throw new Error('FMP_SYM no encontrado en live/index.html');
  const obj = {};
  const re = /'([^']+)'\s*:\s*'([^']+)'/g;
  let mm;
  while ((mm = re.exec(m[1])) !== null) obj[mm[1]] = mm[2];
  return obj;
}

function extractCompanyTickers(html) {
  // Devuelve lista de tickers originales (e.g. "AMS:MT") en companies/top6/spanish + sus tids
  const tickers = [];
  ['companies', 'top6Section3', 'spanishCompanies'].forEach(arr => {
    const m = html.match(new RegExp(`const ${arr}\\s*=\\s*\\[([\\s\\S]*?)\\];`));
    if (!m) return;
    const re = /ticker:"([^"]+)"/g;
    let mm;
    while ((mm = re.exec(m[1])) !== null) {
      const t = mm[1];
      const tid = t.replace(/[^a-z0-9]/gi, '_');
      tickers.push({ ticker: t, tid });
    }
  });
  return tickers;
}

// Mapeo prefijo del ticker → código de país → símbolo del índice (igual que en la app)
const TICKER_PREFIX = {VIE:'VI',ETR:'DE',XETRA:'DE',EPA:'PA',SWX:'SW',BIT:'MI',BME:'MC',OM:'ST',CPH:'CO',ISE:'IR',WAR:'WA',AMS:'AMS',NYSE:'US',NASDAQ:'US'};
const COUNTRY_IDX = {
  VI:'^ATX', DE:'^GDAXI', PA:'^FCHI', SW:'^SSMI', MI:'FTSEMIB.MI',
  MC:'^IBEX', ST:'^OMX', CO:'^OMXC25', IR:'^ISEQ', WA:'WIG20.WA',
  AMS:'^AEX', US:'^GSPC'
};
const EU_IDX_SYM = '^STOXX';

function pickCountryIdx(originalTicker, fmpSym) {
  if (originalTicker && originalTicker.includes(':')) {
    const code = TICKER_PREFIX[originalTicker.split(':')[0]];
    if (code && COUNTRY_IDX[code]) return COUNTRY_IDX[code];
  }
  if (fmpSym && fmpSym.includes('.')) {
    const ext = fmpSym.split('.').pop();
    if (COUNTRY_IDX[ext]) return COUNTRY_IDX[ext];
  }
  return COUNTRY_IDX.US;
}

// ───────────────────────────────────────────────────────────────────────────
// MAIN
// ───────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('▸ Leyendo source: live/index.html');
  const src = fs.readFileSync(SRC, 'utf8');

  const fmpSym = extractFmpSym(src);
  const tickers = extractCompanyTickers(src);
  console.log(`▸ FMP_SYM tiene ${Object.keys(fmpSym).length} símbolos · ${tickers.length} empresas en arrays`);

  // ── 1. Profiles para todos los símbolos en FMP_SYM ────────────────────
  console.log('▸ Fetching profiles de FMP...');
  const prices = {};
  let okProfiles = 0, failProfiles = 0;
  for (const [tid, sym] of Object.entries(fmpSym)) {
    try {
      const p = await fmpProfile(sym);
      if (p) { prices[tid] = p; okProfiles++; }
      else { failProfiles++; }
    } catch (e) {
      console.error(`  ✗ ${tid} (${sym}): ${e.message}`);
      failProfiles++;
    }
  }
  console.log(`  ✓ ${okProfiles} OK · ✗ ${failProfiles} fallidos`);

  // ── 2. Históricos 1Y para empresas + sus índices país + Stoxx Europe ──
  console.log('▸ Fetching históricos 1Y...');
  const now = new Date();
  const toDate = now.toISOString().slice(0, 10);
  const from1Y = new Date(now.getTime() - 370 * 86400e3).toISOString().slice(0, 10);

  const historical = {};
  const symsToFetch = new Set();
  // Empresas
  for (const { ticker, tid } of tickers) {
    if (fmpSym[tid]) symsToFetch.add(fmpSym[tid]);
  }
  // Índices país (únicos)
  const idxSyms = new Set();
  for (const { ticker, tid } of tickers) {
    if (fmpSym[tid]) idxSyms.add(pickCountryIdx(ticker, fmpSym[tid]));
  }
  idxSyms.forEach(s => symsToFetch.add(s));
  // EU index
  symsToFetch.add(EU_IDX_SYM);

  console.log(`  ${symsToFetch.size} símbolos únicos a histórico`);
  let okHist = 0, failHist = 0;
  for (const sym of symsToFetch) {
    try {
      const arr = await fmpHistorical(sym, from1Y, toDate);
      if (arr) { historical[sym + '__1Y'] = arr; okHist++; }
      else { failHist++; }
    } catch (e) {
      console.error(`  ✗ hist ${sym}: ${e.message}`);
      failHist++;
    }
  }
  console.log(`  ✓ ${okHist} OK · ✗ ${failHist} fallidos`);

  // ── 3. Construir bloque static-data ───────────────────────────────────
  const staticPayload = {
    bakedAt: new Date().toISOString(),
    prices,
    historical
  };
  const staticJson = JSON.stringify(staticPayload);
  const staticBlock = `<script id="static-data" type="application/json">${staticJson}</script>`;

  // ── 4. Generar versión pública ────────────────────────────────────────
  let pub = src;
  // Reemplazar el script static-data vacío con el populado
  pub = pub.replace(/<script id="static-data" type="application\/json">[\s\S]*?<\/script>/, staticBlock);
  // Vaciar las API keys (la versión pública no llamará a APIs porque STATIC_DATA está poblado)
  pub = pub.replace(/const FMP_KEY='[^']*';/, "const FMP_KEY='';");
  pub = pub.replace(/const FH_KEY='[^']*';/, "const FH_KEY='';");
  // Banner discreto en el footer indicando el horario de actualización
  pub = pub.replace(
    /(<footer>[\s\S]*?<div>)(Análisis de Inversión)/,
    `$1<span style="color:#5b9cf6;">Versión pública · datos actualizados ${new Date().toISOString().slice(0,16).replace('T',' ')} UTC · </span>$2`
  );

  fs.writeFileSync(OUT, pub, 'utf8');
  console.log(`▸ Escrito ${OUT} (${pub.length} bytes, ${(staticJson.length/1024).toFixed(1)}KB de datos pre-bakeados)`);

  // Resumen para el log de Actions
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`✓ Bake completado · ${okProfiles}/${Object.keys(fmpSym).length} profiles · ${okHist}/${symsToFetch.size} históricos`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main().catch(e => {
  console.error('✗ Bake falló:', e.message);
  process.exit(1);
});
