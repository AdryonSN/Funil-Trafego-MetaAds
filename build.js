/* ------------------------------------------------------------------
   build.js — roda no GitHub Actions (Node 20+, sem dependências).
   Lê (somente leitura) a aba "Meta Ads" do Google Sheets via export CSV,
   monta data.json e injeta o BUILD_ID no index.html. Nunca escreve na planilha.
------------------------------------------------------------------ */
"use strict";
const fs = require("fs");
const path = require("path");

const SHEET_ID = "1sBNg5Od_3raPym0_toWdcR4qZsLEc-cUZex3FE_U1vE";
const GID = "0";
const SHEET_TAB = "Meta Ads";
const SOURCE_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?gid=${GID}#gid=${GID}`;
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID}`;
const GOAL_DEFAULT = 20000;

const OUT_DIR = path.join(__dirname, "dist");

/* ---------- CSV parser (RFC-4180-ish: aspas, vírgulas internas, "" escapado) */
function parseCSV(text){
  text = text.replace(/^﻿/, "");          // remove BOM
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++){
    const ch = text[i];
    if (inQ){
      if (ch === '"'){
        if (text[i+1] === '"'){ field += '"'; i++; }
        else inQ = false;
      } else field += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ','){ row.push(field); field = ""; }
      else if (ch === '\n'){ row.push(field); rows.push(row); row = []; field = ""; }
      else if (ch === '\r'){ /* ignora */ }
      else field += ch;
    }
  }
  if (field.length || row.length){ row.push(field); rows.push(row); }
  return rows.filter(r => r.length && !(r.length === 1 && r[0].trim() === ""));
}

/* ---------- número no formato BR: "1.234,56" -> 1234.56 ; "16,79" -> 16.79 */
function brNum(s){
  if (s == null) return 0;
  s = String(s).trim();
  if (!s || s === "-" || s === "—") return 0;
  s = s.replace(/[R$\s]/g, "").replace(/\./g, "").replace(",", ".");
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
}

/* ---------- data -> ISO (aceita YYYY-MM-DD e DD/MM/YYYY) */
function parseDate(s){
  if (!s) return null;
  s = String(s).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${String(m[2]).padStart(2,"0")}-${String(m[1]).padStart(2,"0")}`;
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString().slice(0,10);
}

/* ---------- hora em São Paulo */
function spParts(){
  const p = new Intl.DateTimeFormat("en-GB", {timeZone:"America/Sao_Paulo",
    year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false})
    .formatToParts(new Date());
  const g = t => (p.find(x => x.type === t) || {}).value;
  return {y:g("year"), mo:g("month"), d:g("day"), h:g("hour"), mi:g("minute"), s:g("second")};
}

async function fetchCSV(){
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++){
    try {
      const r = await fetch(CSV_URL, {redirect:"follow", headers:{"User-Agent":"funnel-build"}});
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const t = await r.text();
      if (/<html/i.test(t.slice(0, 500))) throw new Error("recebi HTML (planilha não está pública por link?)");
      return t;
    } catch(e){ lastErr = e; console.error(`tentativa ${attempt} falhou: ${e.message}`); await new Promise(r => setTimeout(r, 1500*attempt)); }
  }
  throw lastErr;
}

(async () => {
  console.log("Baixando CSV:", CSV_URL);
  const csv = await fetchCSV();
  const rows = parseCSV(csv);
  if (rows.length < 2) throw new Error("CSV sem linhas de dados");

  const H = rows[0].map(h => h.trim().toLowerCase());
  const find = pred => H.findIndex(pred);
  const col = {
    date:     find(h => h === "date" || h.startsWith("date") || h.includes("dia")),
    campaign: find(h => h.includes("campaign")),
    adset:    find(h => h.includes("adset") || h.includes("ad set") || h.includes("conjunto")),
    ad:       find(h => h.includes("ad name") || h === "anuncio" || h.includes("anúncio") || h.includes("anuncio")),
    spend:    find(h => h.includes("spend") || h.includes("amount spent") || h.includes("gasto") || h.includes("cost")),
    imp:      find(h => h.includes("impress")),
    clk:      find(h => h.includes("link click") || h.includes("inline link") || h === "clicks" || h.includes("clique")),
    lpv:      find(h => h.includes("landing page view") || h.includes("page view")),
    ic:       find(h => h.includes("initiate checkout") || h.includes("checkout")),
    purchase: find(h => h.includes("purchase") && !h.includes("value") && !h.includes("valor") && !h.includes("initiate")),
    value:    find(h => (h.includes("value") || h.includes("valor")) && h.includes("purchase"))
  };
  console.log("Cabeçalho:", rows[0]);
  console.log("Mapa de colunas:", col);
  const missing = Object.entries(col).filter(([k,v]) => v < 0).map(([k]) => k);
  if (col.date < 0 || col.spend < 0) throw new Error("não achei colunas essenciais (date/spend). Cabeçalho: " + rows[0].join(" | "));

  const ads = [];
  const r2 = v => Math.round(v * 100) / 100;
  for (let i = 1; i < rows.length; i++){
    const r = rows[i];
    const d = parseDate(r[col.date]);
    if (!d) continue;
    const spend = col.spend >= 0 ? r2(brNum(r[col.spend])) : 0;
    const imp   = col.imp   >= 0 ? Math.round(brNum(r[col.imp])) : 0;
    const clk   = col.clk   >= 0 ? Math.round(brNum(r[col.clk])) : 0;
    const lpv   = col.lpv   >= 0 ? Math.round(brNum(r[col.lpv])) : 0;
    const ic    = col.ic    >= 0 ? Math.round(brNum(r[col.ic])) : 0;
    const sales = col.purchase >= 0 ? Math.round(brNum(r[col.purchase])) : 0;
    const rev   = col.value >= 0 ? r2(brNum(r[col.value])) : 0;
    // ignora linhas totalmente vazias
    if (!spend && !imp && !clk && !lpv && !ic && !sales && !rev) continue;
    ads.push({
      d,
      c: (col.campaign >= 0 ? (r[col.campaign]||"").trim() : "") || "(sem campanha)",
      s: (col.adset    >= 0 ? (r[col.adset]||"").trim()    : "") || "(sem conjunto)",
      a: (col.ad       >= 0 ? (r[col.ad]||"").trim()       : "") || "(sem anúncio)",
      spend, imp, clk, lpv, ic, sales, rev
    });
  }
  if (!ads.length) throw new Error("nenhuma linha de anúncio válida após parse");
  ads.sort((a,b) => a.d < b.d ? -1 : a.d > b.d ? 1 : 0);

  const tot = ads.reduce((t,r) => {
    t.spend += r.spend; t.imp += r.imp; t.clk += r.clk; t.lpv += r.lpv;
    t.ic += r.ic; t.sales += r.sales; t.rev += r.rev; return t;
  }, {spend:0, imp:0, clk:0, lpv:0, ic:0, sales:0, rev:0});

  const date_min = ads[0].d, date_max = ads[ads.length-1].d;
  const ticket = tot.sales > 0 ? r2(tot.rev / tot.sales) : 0;
  const cac_goal = ticket > 0 ? ticket : 1;

  const warnings = [];
  if (missing.length) warnings.push("Colunas não encontradas no CSV (tratadas como 0): " + missing.join(", ") + ".");
  if (tot.sales === 0) warnings.push("Nenhuma venda (compra) encontrada no período — ROAS, CAC e saúde ficam sem base.");

  const t = spParts();
  const BUILD_ID = `${t.y}${t.mo}${t.d}${t.h}${t.mi}${t.s}`;
  const generated_at_br = `${t.d}/${t.mo}/${t.y} ${t.h}:${t.mi}`;

  const data = {
    meta: {
      title: "Funil de Tráfego",
      platform: "Meta Ads",
      date_min, date_max,
      generated_at_br,
      goal_default: GOAL_DEFAULT,
      ticket,
      cac_goal,
      sheet_tab: SHEET_TAB,
      source_url: SOURCE_URL,
      counts: {
        ads_rows: ads.length,
        sales: tot.sales,
        rev: r2(tot.rev),
        spend: r2(tot.spend)
      },
      warnings
    },
    ads
  };

  fs.mkdirSync(OUT_DIR, {recursive:true});
  fs.writeFileSync(path.join(OUT_DIR, "data.json"), JSON.stringify(data));
  // injeta BUILD_ID no index.html
  let html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  html = html.split("__BUILD_ID__").join(BUILD_ID);
  fs.writeFileSync(path.join(OUT_DIR, "index.html"), html);
  // .nojekyll pra o Pages não processar nada
  fs.writeFileSync(path.join(OUT_DIR, ".nojekyll"), "");

  console.log(`OK — ${ads.length} linhas · ${tot.sales} vendas · gasto R$ ${tot.spend.toFixed(2)} · receita R$ ${tot.rev.toFixed(2)} · ticket R$ ${ticket.toFixed(2)}`);
  console.log(`Período ${date_min} → ${date_max} · build ${BUILD_ID}`);
  if (warnings.length) console.log("Avisos:", warnings);
})().catch(e => { console.error("BUILD FALHOU:", e); process.exit(1); });
