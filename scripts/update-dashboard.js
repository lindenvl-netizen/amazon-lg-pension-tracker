const fs = require("fs");

const ROOT = "https://fundcentres.landg.com";
const DASHBOARD = "index.html";
const OUT = "work/lg-monthly-performance.json";
const SEED_URL = `${ROOT}/en/uk/workplace-adviser/fund-centre/UK-Equity-Index-Fund/?isin_code=GB00B4MV7743`;

const forcedSkips = new Set([
  "L&G MT UK Smaller Companies Equity Fund"
]);

const aliases = new Map([
  ["L&G MT Active Diversified Growth Fund", "Legal & General Mastertrust Active Diversified Growth Fund"],
  ["L&G MT Emerging Markets Index Fund", "Legal & General Mastertrust Emerging Markets Index Fund"],
  ["L&G MT Future World Multi-Asset Fund", "Legal & General Mastertrust Future World Multi-Asset Fund"],
  ["L&G MT Glbl Fossil Fuel Exclusions Equity Idx Fund", "Legal & General MT Global Fossil Fuel Exclusions Equity Index Fund"],
  ["L&G MT Global Developed Equity Index Fund", "Legal & General Mastertrust Global Developed Equity Index Fund"],
  ["L&G MT Global Real Estate Equity Index Fund", "Legal & General Mastertrust Global Real Estate Equity Index Fund"],
  ["L&G MT Positive Change Fund", "L&G MT Positive Change Fund"],
  ["L&G MT Short Dated Bond Index Fund", "Legal & General Mastertrust Short Dated Bond Index Fund"],
  ["L&G MT Smaller Companies Index Fund", "Legal & General Mastertrust Smaller Companies Index Fund"],
  ["L&G MT UK Smaller Companies Equity Fund", "Legal & General Mastertrust UK Smaller Companies Fund"],
  ["L&G PMC AAA-AA-A Corp Bond All Stocks Index 3", "L&G PMC AAA-AA-A Corporate Bond All Stocks Index Fund 3"],
  ["L&G PMC Cash 3", "L&G PMC Cash Fund 3"],
  ["L&G PMC CT Managed Equity Fund 3", "L&G PMC CT Managed Equity 3"],
  ["L&G PMC Ethical Global Equity Index 3", "L&G PMC Ethical Global Equity Index Fund 3"],
  ["L&G PMC FW Global Multi-Factor Equity Index Fd G3", "L&G PMC Future World Global Multi-Factor Equity Index Fund 3"],
  ["L&G PMC Janus Henderson Fixed Int Monthly Income 3", "L&G PMC Janus Henderson Fixed Interest Monthly Income Fund 3"],
  ["L&G PMC Multi-Asset 3", "L&G PMC Multi-Asset Fund 3"],
  ["L&G PMC Retirement Income Multi-Asset 3", "L&G PMC Retirement Income Multi-Asset Fund 3"],
  ["L&G PMC Sustainable Property Fund 3", "L&G PMC Sustainable Property Fund 3"],
  ["L&G PMC UK Equity Index 3", "L&G PMC UK Equity Index Fund 3"],
  ["L&G PMC World (Ex-UK) Equity Index 3", "L&G PMC World (ex UK) Equity Index Fund 3"],
  ["MT Active Global Equity Fund", "Legal & General MT Active Global Equity Fund"]
]);

const pageUrlOverrides = new Map([
  ["L&G PMC UK Equity Index 3", SEED_URL]
]);

function decodeHtml(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&#x2D;|&#45;/g, "-")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalise(text) {
  return decodeHtml(text)
    .replace(/\bFd\b/gi, "Fund")
    .replace(/\bCorporate\b/gi, "Corp")
    .replace(/ex-uk/gi, "ex uk")
    .replace(/[()]/g, "")
    .replace(/\bFund\b/gi, "")
    .replace(/\s+-\s+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function extractFunds(html) {
  const block = html.match(/const funds = \[([\s\S]*?)\]\.map/);
  if (!block) throw new Error("Could not find dashboard funds block");
  return [...block[1].matchAll(/^\s*\["([^"]+)",\s*"([^"]+)"/gm)].map((match) => ({
    name: match[1],
    status: match[2]
  }));
}

function buildCatalog(seedHtml) {
  const catalog = [];
  const itemRe = /<a\b[^>]*class="[^"]*\bFundSelectorItem\b[^"]*"[^>]*>[\s\S]*?<\/a>/g;
  for (const match of seedHtml.matchAll(itemRe)) {
    const item = match[0];
    const hrefMatch = item.match(/\bhref="([^"]*)"/);
    const nameMatch = item.match(/<span class="FundSelectorItem-name">([\s\S]*?)<\/span>/);
    const typeMatch = item.match(/<span class="FundSelectorItem-type">([\s\S]*?)<\/span>/);
    if (!hrefMatch || !nameMatch) continue;
    const href = decodeHtml(hrefMatch[1]);
    const name = decodeHtml(nameMatch[1]).trim();
    const type = decodeHtml(typeMatch ? typeMatch[1] : "").trim();
    if (!name || !href) continue;
    catalog.push({ href, name, type, key: normalise(name) });
  }
  return catalog;
}

function absoluteUrl(href, fallback) {
  if (href.startsWith("https://")) return href;
  if (href.startsWith("?")) return fallback.split("?")[0] + href;
  if (href.startsWith("/")) return ROOT + href;
  return `${ROOT}/${href}`;
}

function chooseCatalogEntry(fund, catalog) {
  const alias = aliases.get(fund.name) || fund.name;
  const keys = [normalise(alias), normalise(fund.name)];
  return catalog.find((entry) => keys.includes(entry.key))
    || catalog.find((entry) => keys.some((key) => entry.key.includes(key) || key.includes(entry.key)));
}

function chooseShareclassId(pageHtml, fundName) {
  const alias = aliases.get(fundName) || fundName;
  const keys = [normalise(alias), normalise(fundName)];
  const menuRe = /class="ShareClassSelector-menuItem[^"]*"[\s\S]*?data-value="([^"]+)"[\s\S]*?data-shareclass-alt-label="([^"]*)"/g;
  for (const match of pageHtml.matchAll(menuRe)) {
    const label = decodeHtml(match[2]);
    if (keys.includes(normalise(label))) return match[1];
  }

  const h1Re = /data-shareclass-id="([^"]+)"[^>]*data-shareclass-name="([^"]+)"/g;
  for (const match of pageHtml.matchAll(h1Re)) {
    const label = decodeHtml(match[2]);
    if (keys.includes(normalise(label))) return match[1];
  }

  const selected = pageHtml.match(/data-value="([^"]+)"[^>]*class="[^"]*initially-selected/);
  return selected ? selected[1] : null;
}

function getPerformancePartId(pageHtml) {
  const match = pageHtml.match(/part-(\d+) part perfchart[\s\S]*?data-part_id="(\d+)"/);
  return match ? match[2] : null;
}

function toMonthly(points) {
  const months = new Map();
  for (const [timestamp, value] of points) {
    const date = new Date(timestamp);
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    months.set(key, { date: key, value: Number(value.toFixed(2)), timestamp });
  }
  return [...months.values()].sort((a, b) => a.timestamp - b.timestamp);
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 dashboard updater",
      "Accept": "text/html,application/json;q=0.9,*/*;q=0.8"
    }
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${response.status} ${response.statusText}${text ? `: ${text.slice(0, 240)}` : ""}`);
  }
  return response.text();
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

function writeResult(series, skipped) {
  fs.mkdirSync("work", { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: "L&G Fund Centre /srp/api/perf-chart-part-new",
    series,
    skipped
  }, null, 2));
}

function compactSeries(series) {
  return series.map((item) => ({
    name: item.name,
    asAt: item.asAt,
    startDate: item.startDate,
    endDate: item.endDate,
    source: item.source,
    monthly: item.monthly.map((point) => ({ date: point.date, value: point.value }))
  }));
}

function formatAsDisplayDate(isoDate) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC"
  }).format(date);
}

function embedPerformance(series) {
  const compact = compactSeries(series);
  const replacement = `const monthlyPerformanceSeries = ${JSON.stringify(compact, null, 6)};
    const historicalReturns = new Map(monthlyPerformanceSeries.map((series) => [series.name, series]));`;
  let dashboard = fs.readFileSync(DASHBOARD, "utf8");
  const performanceBlockRe = /const monthlyPerformanceSeries = [\s\S]*?const historicalReturns = new Map\(monthlyPerformanceSeries\.map\(\(series\) => \[series\.name, series\]\)\);/;
  if (!performanceBlockRe.test(dashboard)) throw new Error("Could not replace historical return block");
  const updated = dashboard.replace(performanceBlockRe, replacement);

  const latestAsAt = compact.map((item) => item.asAt).sort().at(-1);
  dashboard = updated.replace(
    /Performance data: [^|<]+ \| Charges checked:/,
    `Performance data: ${formatAsDisplayDate(latestAsAt)} | Charges checked:`
  );
  fs.writeFileSync(DASHBOARD, dashboard);
}

async function main() {
  const dashboard = fs.readFileSync(DASHBOARD, "utf8");
  const funds = extractFunds(dashboard);
  const seed = await fetchText(SEED_URL);
  const catalog = buildCatalog(seed);
  const series = [];
  const skipped = [];

  for (const fund of funds) {
    if (forcedSkips.has(fund.name)) {
      skipped.push({ name: fund.name, reason: "Skipped because the source page repeatedly stalled during refresh" });
      writeResult(series, skipped);
      continue;
    }
    if (/Lifestyle/.test(fund.name)) {
      skipped.push({ name: fund.name, reason: "Lifestyle profile; no single shareclass curve" });
      continue;
    }
    if (/Target Date|Lifetime Advantage/.test(fund.name)) {
      skipped.push({ name: fund.name, reason: "L&G chart API returns no valid monthly periods for this range" });
      writeResult(series, skipped);
      continue;
    }

    const entry = chooseCatalogEntry(fund, catalog);
    if (!entry) {
      skipped.push({ name: fund.name, reason: "No matching Fund Centre page in catalog" });
      continue;
    }

    try {
      const pageUrl = pageUrlOverrides.get(fund.name) || absoluteUrl(entry.href, `${ROOT}/en/uk/workplace-adviser/fund-centre/`);
      const page = await fetchText(pageUrl);
      const partId = getPerformancePartId(page);
      const shareclassId = chooseShareclassId(page, fund.name);
      if (!partId || !shareclassId) {
        skipped.push({ name: fund.name, reason: "Missing performance part or shareclass id" });
        continue;
      }

      const api = `${ROOT}/srp/api/perf-chart-part-new?shareclass=${encodeURIComponent(shareclassId)}&part_id=${encodeURIComponent(partId)}&max_period_length=40`;
      const data = await fetchJson(api);
      const plot = data.share_class_plots && data.share_class_plots[0];
      if (!plot || !plot.data || plot.data.length < 2) {
        skipped.push({ name: fund.name, reason: "No chart data returned" });
        continue;
      }

      series.push({
        name: fund.name,
        status: fund.status,
        sourceName: data.share_class_info.share_class_name,
        asAt: data.as_at_date,
        startDate: data.start_date,
        endDate: data.end_date,
        shareclassId,
        partId,
        source: pageUrl,
        monthly: toMonthly(plot.data)
      });
      writeResult(series, skipped);
      console.log(`ok ${series.length}: ${fund.name}`);
    } catch (error) {
      skipped.push({ name: fund.name, reason: error.message });
      writeResult(series, skipped);
      console.log(`skip: ${fund.name} (${error.message})`);
    }
  }

  if (!series.length) throw new Error("No performance series were loaded; leaving dashboard unchanged");
  embedPerformance(series);
  writeResult(series, skipped);
  console.log(`updated ${DASHBOARD}: ${series.length} series, ${skipped.length} skipped`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
