#!/usr/bin/env node
/**
 * scripts/bake.js
 *
 * Lee live/index.html (source of truth, con APIs activas) y genera index.html
 * (versión pública) con datos pre-bakeados y keys API eliminadas.
 *
 * Estrategia híbrida:
 *  · Yahoo Finance (sin límite diario, vía yahoo-finance2 npm) para perfiles +
 *    históricos + datos de analistas (Wall Street consensus, target prices,
 *    earnings dates).
 *  · FMP como fallback si Yahoo falla en algún símbolo.
 *
 * Variables de entorno:
 *   FMP_KEY  → API key de FMP (GitHub Secret) — solo para fallback
 *
 * Uso local:
 *   FMP_KEY=tu_key node scripts/bake.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'live', 'index.html');
const OUT = path.join(ROOT, 'index.html');

const FMP_KEY = process.env.FMP_KEY || '';
const YAHOO_PROXY_URL = process.env.YAHOO_PROXY_URL || ''; // ej: https://yahoo-proxy.usuario.workers.dev

// Reescribe URL Yahoo → URL via Cloudflare Worker proxy
function viaProxy(url) {
  if (!YAHOO_PROXY_URL) return url;
  return YAHOO_PROXY_URL.replace(/\/$/, '') + '/?url=' + encodeURIComponent(url);
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ───────────────────────────────────────────────────────────────────────────
// Yahoo Finance — fuente principal
// ───────────────────────────────────────────────────────────────────────────
async function yahooProfile(sym) {
  try {
    const data = await yf.quoteSummary(sym, {
      modules: ['price', 'summaryDetail', 'financialData', 'defaultKeyStatistics', 'calendarEvents', 'summaryProfile']
    }, { validateResult: false });
    const price = data.price || {};
    const summary = data.summaryDetail || {};
    const fin = data.financialData || {};
    const stats = data.defaultKeyStatistics || {};
    const cal = data.calendarEvents || {};
    const profile = data.summaryProfile || {};

    // Próxima fecha de earnings: cal.earnings?.earningsDate es Array<Date>
    let earningsDate = null;
    const eds = cal.earnings && cal.earnings.earningsDate;
    if (Array.isArray(eds) && eds.length && eds[0] instanceof Date) {
      earningsDate = eds[0].toISOString();
    }

    const out = {
      price: price.regularMarketPrice,
      changesPercentage: price.regularMarketChangePercent != null ? price.regularMarketChangePercent * 100 : 0,
      marketCap: price.marketCap,
      fullTimeEmployees: profile.fullTimeEmployees,
      range: summary.fiftyTwoWeekRange,  // ya viene "X-Y"
      beta: summary.beta || stats.beta,
      // — Analistas (Wall Street consensus)
      numAnalysts: fin.numberOfAnalystOpinions,
      recommendationKey: fin.recommendationKey,    // 'strong_buy'|'buy'|'hold'|'sell'|'strong_sell'
      recommendationMean: fin.recommendationMean,  // 1-5 (1=Strong Buy, 5=Strong Sell)
      targetMean: fin.targetMeanPrice,
      targetHigh: fin.targetHighPrice,
      targetLow: fin.targetLowPrice,
      earningsDate
    };

    if (!out.price) { console.error(`  yahoo profile ${sym}: respuesta sin price`); return null; }
    return out;
  } catch (e) {
    console.error(`  yahoo profile ${sym}: ${e.message}`);
    return null;
  }
}

async function yahooHistorical(sym, fromDate, toDate) {
  try {
    const data = await yf.historical(sym, { period1: fromDate, period2: toDate, interval: '1d' }, { validateResult: false });
    if (!data || !data.length) return null;
    const arr = data
      .filter(d => d.close != null && !isNaN(d.close))
      .map(d => ({ date: (d.date instanceof Date ? d.date.toISOString().slice(0, 10) : String(d.date).slice(0, 10)), price: d.close }))
      .filter(d => d.date);
    return arr.length ? arr : null;
  } catch (e) {
    console.error(`  yahoo hist ${sym}: ${e.message}`);
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// FMP — fallback si Yahoo falla
// ───────────────────────────────────────────────────────────────────────────
async function fmpProfile(sym) {
  if (!FMP_KEY) { console.error(`  fmp profile ${sym}: SIN FMP_KEY`); return null; }
  try {
    const url = `https://financialmodelingprep.com/stable/profile?symbol=${encodeURIComponent(sym)}&apikey=${FMP_KEY}`;
    const d = await fetchJson(url);
    if (d && d['Error Message']) { console.error(`  fmp profile ${sym}: ${d['Error Message']}`); return null; }
    const q = Array.isArray(d) ? d[0] : d;
    if (!q || !q.price) { console.error(`  fmp profile ${sym}: respuesta sin price`); return null; }
    return {
      price: q.price,
      changesPercentage: q.changesPercentage ?? q.changePercentage ?? 0,
      marketCap: q.marketCap,
      fullTimeEmployees: q.fullTimeEmployees,
      range: q.range,
      beta: q.beta
      // sin datos de analistas en FMP free
    };
  } catch (e) {
    console.error(`  fmp profile ${sym}: ${e.message}`);
    return null;
  }
}

async function fmpHistorical(sym, fromDate, toDate) {
  if (!FMP_KEY) return null;
  try {
    const url = `https://financialmodelingprep.com/stable/historical-price-eod/light?symbol=${encodeURIComponent(sym)}&from=${fromDate}&to=${toDate}&apikey=${FMP_KEY}`;
    const d = await fetchJson(url);
    if (d && d['Error Message']) { console.error(`  fmp hist ${sym}: ${d['Error Message']}`); return null; }
    let arr = Array.isArray(d) ? d : (d.historical || d.data || []);
    if (!arr.length) return null;
    arr = arr.map(x => ({ date: x.date, price: parseFloat(x.price ?? x.close ?? x.adjClose) })).filter(x => x.date && !isNaN(x.price));
    arr.sort((a, b) => a.date.localeCompare(b.date));
    return arr.length ? arr : null;
  } catch (e) {
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Extracción de datos del HTML source
// ───────────────────────────────────────────────────────────────────────────
function extractFmpSym(html) {
  const m = html.match(/const FMP_SYM\s*=\s*\{([\s\S]*?)\};/);
  if (!m) throw new Error('FMP_SYM no encontrado');
  const obj = {};
  const re = /'([^']+)'\s*:\s*'([^']+)'/g;
  let mm;
  while ((mm = re.exec(m[1])) !== null) obj[mm[1]] = mm[2];
  return obj;
}

function extractCompanyTickers(html) {
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
let yf;

async function main() {
  console.log('▸ FMP_KEY presente:', !!FMP_KEY);
  console.log('▸ YAHOO_PROXY_URL presente:', !!YAHOO_PROXY_URL);

  // Si tenemos proxy, monkey-patch global fetch ANTES de cargar yahoo-finance2
  // Esto enruta todas las llamadas Yahoo (query1, query2, finance, guce, consent) por CF Worker
  if (YAHOO_PROXY_URL) {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      const target = typeof url === 'string' ? url : (url.url || url.href || String(url));
      if (target.includes('yahoo.com')) {
        const proxied = viaProxy(target);
        return origFetch(proxied, opts);
      }
      return origFetch(url, opts);
    };
    console.log('▸ Fetch global monkey-patched → proxy CF Worker activo');
  } else {
    console.log('▸ ⚠ Sin proxy: las llamadas Yahoo desde GitHub Actions probablemente serán bloqueadas');
  }

  // Cargar yahoo-finance2 (ESM-only) DESPUÉS del monkey-patch
  yf = (await import('yahoo-finance2')).default;
  try { yf.suppressNotices(['yahooSurvey', 'ripHistorical']); } catch(e) {}
  console.log('▸ yahoo-finance2 cargado');

  console.log('▸ Source: live/index.html');
  const src = fs.readFileSync(SRC, 'utf8');
  const fmpSym = extractFmpSym(src);
  const tickers = extractCompanyTickers(src);
  console.log(`▸ ${Object.keys(fmpSym).length} símbolos · ${tickers.length} empresas`);

  // ── PROFILES ──────────────────────────────────────────────────────────
  console.log('▸ Profiles vía Yahoo Finance (fallback FMP)...');
  const prices = {};
  let yahooHits = 0, fmpFallbacks = 0, totalFails = 0;
  for (const [tid, sym] of Object.entries(fmpSym)) {
    let p = await yahooProfile(sym);
    if (p) { yahooHits++; }
    else {
      p = await fmpProfile(sym);
      if (p) fmpFallbacks++;
      else totalFails++;
    }
    if (p) prices[tid] = p;
    await sleep(120);  // ratelimit suave Yahoo
  }
  console.log(`  ✓ ${yahooHits} Yahoo · ↻ ${fmpFallbacks} FMP fallback · ✗ ${totalFails} fallidos`);

  // ── HISTORICAL 1Y ─────────────────────────────────────────────────────
  console.log('▸ Históricos 1Y vía Yahoo Finance (fallback FMP)...');
  const now = new Date();
  const toDate = now.toISOString().slice(0, 10);
  const fromDate = new Date(now.getTime() - 370 * 86400e3).toISOString().slice(0, 10);

  const symsToFetch = new Set();
  for (const { ticker, tid } of tickers) {
    if (fmpSym[tid]) symsToFetch.add(fmpSym[tid]);
  }
  const idxSyms = new Set();
  for (const { ticker, tid } of tickers) {
    if (fmpSym[tid]) idxSyms.add(pickCountryIdx(ticker, fmpSym[tid]));
  }
  idxSyms.forEach(s => symsToFetch.add(s));
  symsToFetch.add(EU_IDX_SYM);

  console.log(`  ${symsToFetch.size} símbolos únicos`);
  const historical = {};
  let yhHits = 0, yhFmpFb = 0, yhFails = 0;
  for (const sym of symsToFetch) {
    let arr = await yahooHistorical(sym, fromDate, toDate);
    if (arr) { yhHits++; }
    else {
      arr = await fmpHistorical(sym, fromDate, toDate);
      if (arr) yhFmpFb++;
      else yhFails++;
    }
    if (arr) historical[sym + '__1Y'] = arr;
    await sleep(120);
  }
  console.log(`  ✓ ${yhHits} Yahoo · ↻ ${yhFmpFb} FMP fallback · ✗ ${yhFails} fallidos`);

  // ── INYECTAR EN HTML ──────────────────────────────────────────────────
  const staticPayload = { bakedAt: new Date().toISOString(), prices, historical };
  const staticJson = JSON.stringify(staticPayload);
  const staticBlock = `<script id="static-data" type="application/json">${staticJson}</script>`;

  let pub = src;
  pub = pub.replace(/<script id="static-data" type="application\/json">[\s\S]*?<\/script>/, staticBlock);
  pub = pub.replace(/const FMP_KEY='[^']*';/, "const FMP_KEY='';");
  pub = pub.replace(/const FH_KEY='[^']*';/, "const FH_KEY='';");
  pub = pub.replace(
    /(<footer>[\s\S]*?<div>)(Análisis de Inversión)/,
    `$1<span style="color:#5b9cf6;">Versión pública · datos actualizados ${new Date().toISOString().slice(0,16).replace('T',' ')} UTC · </span>$2`
  );

  fs.writeFileSync(OUT, pub, 'utf8');
  console.log(`▸ Escrito ${OUT} (${pub.length} bytes · payload ${(staticJson.length/1024).toFixed(1)}KB)`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`✓ Bake completado · profiles ${yahooHits + fmpFallbacks}/${Object.keys(fmpSym).length} · históricos ${yhHits + yhFmpFb}/${symsToFetch.size}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main().catch(e => { console.error('✗ Bake falló:', e.message); process.exit(1); });
