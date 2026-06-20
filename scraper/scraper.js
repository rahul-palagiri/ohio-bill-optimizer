/**
 * Ohio Electricity Rate Scraper
 * Source: energychoice.ohio.gov (PUCO official site)
 *
 * Run:  node scraper.js
 * Output: data/rates.json — clean, structured, ready for your app
 */

const { chromium } = require("playwright");
const fs   = require("fs");
const path = require("path");

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const BASE_URL = "https://energychoice.ohio.gov/ApplesToApplesCategory.aspx?Category=Electric";

const UTILITIES = [
  { key: "duke_energy_ohio",  label: "Duke Energy Ohio",          clickLabel: "Duke Energy Ohio" },
  { key: "aep_ohio",          label: "AEP Ohio",                  clickLabel: "American Electric Power" },
  { key: "ohio_edison",       label: "Ohio Edison",               clickLabel: "Ohio Edison" },
  { key: "the_illuminating",  label: "The Illuminating Company",  clickLabel: "The Illuminating Company" },
  { key: "toledo_edison",     label: "Toledo Edison",             clickLabel: "Toledo Edison" },
  { key: "aes_ohio",          label: "AES Ohio (DP&L)",           clickLabel: "AES Ohio" },
];

const OUTPUT_PATH = path.join(__dirname, "data", "rates.json");

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function log(msg) {
  const time = new Date().toISOString().split("T")[1].split(".")[0];
  console.log(`[${time}] ${msg}`);
}

function cleanText(str) {
  return (str || "").replace(/\s+/g, " ").trim();
}

function parseRate(str) {
  // Handles "$0.0749", "7.49¢", "0.0749" → always returns dollars per kWh
  const n = parseFloat(cleanText(str).replace(/[,$¢]/g, ""));
  if (isNaN(n)) return null;
  return n > 1 ? parseFloat((n / 100).toFixed(6)) : parseFloat(n.toFixed(6));
}

function parseEtf(str) {
  const s = cleanText(str).toLowerCase();
  if (!s || ["none","no","n/a","$0","0"].includes(s)) return 0;
  const m = s.match(/\$?([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

function parseBool(str) {
  return ["yes","true","y"].includes(cleanText(str).toLowerCase());
}

// Splits "Company Name 123 Street Rd City,ST 00000 (888) 123-4567"
// into  { name, address, phone }
function parseSupplierString(raw) {
  let s = cleanText(raw);

  // 1. Pull phone from end — pattern: (888) 123-4567
  const phoneMatch = s.match(/\((\d{3})\)\s*(\d{3}-\d{4})\s*$/);
  let phone = null;
  if (phoneMatch) {
    phone = `(${phoneMatch[1]}) ${phoneMatch[2]}`;
    s = s.slice(0, phoneMatch.index).trim();
  }

  // 2. Pull ,STATE ZIP from end — city is the single word right before the comma
  //    e.g. "Seminole,FL 33777"  or  "Buffalo,NY 14240-0967"
  //    Using \S+ (no whitespace) prevents greedily swallowing street names
  const stateZipMatch = s.match(/(\S+),([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\s*$/);
  let address = null;
  if (stateZipMatch) {
    const city  = stateZipMatch[1];
    const state = stateZipMatch[2];
    const zip   = stateZipMatch[3];
    s = s.slice(0, stateZipMatch.index).trim();

    // 3. Split remaining "CompanyName StreetAddress" at the first street number
    //    Street addresses start with a digit or "PO"/"P.O."
    const streetStartRx = /\b(?:\d+|P\.?O\.?\s*(?:Box|BOX))\b/;
    const streetMatch   = s.match(streetStartRx);
    let companyName, street;

    if (streetMatch) {
      const idx   = s.search(streetStartRx);
      companyName = s.slice(0, idx).trim().replace(/,\s*$/, "");
      street      = s.slice(idx).trim();

      // Fix doubled addresses e.g. "2200 E Williams Rd Suite 200 2200 E Williams Rd Suite 200"
      const half = Math.floor(street.length / 2);
      if (street.slice(half).trim().startsWith(street.slice(0, 10))) {
        street = street.slice(0, half).trim();
      }
    } else {
      companyName = s.replace(/,\s*$/, "").trim();
      street      = null;
    }

    address = street
      ? `${street}, ${city}, ${state} ${zip}`
      : `${city}, ${state} ${zip}`;

    return { name: companyName, address, phone };
  }

  // Fallback — couldn't parse address structure
  return { name: s, address: null, phone };
}

// ─── BUILD ONE CLEAN SUPPLIER OBJECT ─────────────────────────────────────────

function buildSupplier(raw) {
  const rate = parseRate(raw.rateRaw);
  if (!rate) return null;

  const { name, address, phone } = parseSupplierString(raw.supplier);

  // contract months
  const contractMatch = (raw.contract || "").match(/(\d+)/);
  const contractMonths = contractMatch ? parseInt(contractMatch[1]) : 0;

  // month-to-month: explicit label OR variable with 1-month contract and no ETF
  const isMonthToMonth =
    (raw.contract || "").toLowerCase().includes("month-to-month") ||
    (raw.rateType === "variable" && contractMonths <= 1 && parseEtf(raw.etfRaw) === 0);

  return {
    name,
    address,
    phone,
    rate_kwh:        rate,
    rate_type:       (raw.typeRaw || "").toLowerCase().includes("fixed") ? "fixed" : "variable",
    contract_months: contractMonths,
    month_to_month:  isMonthToMonth,
    etf:             parseEtf(raw.etfRaw),     // Early termination fee ($)
    intro_rate:      parseBool(raw.introRaw),
    green:           parseBool(raw.greenRaw),
    promo_offers:    parseBool(raw.promoOffers), // boolean, not string
    // Removed: product (duplicate of name), monthly_fee (was cloning ETF incorrectly)
  };
}

// ─── SCRAPE ONE UTILITY ───────────────────────────────────────────────────────

async function scrapeUtility(page, utility) {
  log(`Scraping: ${utility.label}`);

  try {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Some pages require clicking "Residential" first
    const residentialBtn = await page.$("text=/residential/i");
    if (residentialBtn) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null),
        residentialBtn.click(),
      ]);
      await page.waitForTimeout(1500);
    }

    // Try dropdown first, fall back to link
    const dropdown = await page.$("select#MainContent_lstUtility, select[name*='Utility'], select[id*='Utility']");
    if (dropdown) {
      await dropdown.selectOption({ label: utility.label });
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(2000);
    } else {
      const link = await page.$(`a:has-text("${utility.clickLabel || utility.label}")`);
      if (!link) {
        log(`  ⚠ Could not find utility for ${utility.label}`);
        return null;
      }
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }),
        link.click(),
      ]);
      await page.waitForTimeout(2000);
    }

    // ── Price to Compare ────────────────────────────────────────────────────
    const ptcText = await page.evaluate(() => {
      const m = document.body.innerText.match(/\$?(0\.\d{4,6})\s*(?:per\s*kWh|\/kWh)/i);
      return m ? m[1] : null;
    });
    const ptc = ptcText ? parseFloat(ptcText) : null;
    if (ptc) log(`  PTC: $${ptc}/kWh`);

    // ── Supplier Table ───────────────────────────────────────────────────────
    const rawRows = await page.evaluate(() => {
      const table = document.querySelector(
        "table#MainContent_gvOffers, table.GridView, table[id*='grid'], table[id*='Grid'], table[id*='offer'], table[id*='Offer']"
      ) || [...document.querySelectorAll("table")].sort((a, b) => b.rows.length - a.rows.length)[0];

      if (!table) return [];

      const headerRow = table.querySelector("tr");
      if (!headerRow) return [];
      const headers = [...headerRow.querySelectorAll("th, td")].map(
        el => el.innerText.replace(/\s+/g, " ").trim().toLowerCase()
      );

      const getCol = (cells, keywords) => {
        const idx = headers.findIndex(h => keywords.some(k => h.includes(k)));
        if (idx < 0 || !cells[idx]) return "";
        return cells[idx].innerText.replace(/\s+/g, " ").trim()
          .replace(/\s*(Company Url|Offer Details|Terms of Service|Sign Up|details).*/i, "").trim();
      };

      const seen = new Set();
      const rows = [];

      for (const row of [...table.querySelectorAll("tr")].slice(1)) {
        const cells = [...row.querySelectorAll("td")];
        if (cells.length < 3) continue;

        const supplier = getCol(cells, ["supplier", "company"]);
        const rateRaw  = getCol(cells, ["$/", "price", "rate", "kwh"]);
        if (!supplier || !rateRaw) continue;

        const key = `${supplier}|${rateRaw}`;
        if (seen.has(key)) continue;
        seen.add(key);

        rows.push({
          supplier,
          rateRaw,
          typeRaw:     getCol(cells, ["rate type", "type"]),
          contract:    getCol(cells, ["term", "length"]),
          etfRaw:      getCol(cells, ["early term", "termination"]),
          introRaw:    getCol(cells, ["intro", "introductory"]),
          greenRaw:    getCol(cells, ["renew", "content", "green"]),
          promoOffers: getCol(cells, ["promo", "offers"]),
        });
      }

      return rows;
    });

    // Build clean supplier objects
    const suppliers = rawRows
      .map(buildSupplier)
      .filter(Boolean)
      .sort((a, b) => a.rate_kwh - b.rate_kwh);

    log(`  Found ${suppliers.length} suppliers`);
    return { ptc, suppliers };

  } catch (err) {
    log(`  ✗ Error scraping ${utility.label}: ${err.message}`);
    return null;
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  log("=== Ohio Rate Scraper Starting ===");

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await (await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
    viewport:  { width: 1280, height: 800 },
  })).newPage();

  // Skip images/fonts — faster scraping
  await page.route("**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf}", r => r.abort());

  const results = {
    last_updated:          new Date().toISOString(),
    last_updated_readable: new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
    source:                "energychoice.ohio.gov",
    scraper_version:       "2.0.0",
    utilities:             {},
  };

  for (const utility of UTILITIES) {
    const data = await scrapeUtility(page, utility);

    if (data) {
      const fixed     = data.suppliers.filter(s => s.rate_type === "fixed" && !s.intro_rate);
      results.utilities[utility.key] = {
        display_name:   utility.label,
        ptc:            data.ptc,
        total_offers:   data.suppliers.length,
        cheapest_fixed: fixed[0]            || null,  // best non-intro fixed rate
        cheapest_any:   data.suppliers[0]   || null,  // absolute cheapest (any type)
        suppliers:      data.suppliers,
      };
    } else {
      results.utilities[utility.key] = {
        display_name:   utility.label,
        ptc:            null,
        total_offers:   0,
        cheapest_fixed: null,
        cheapest_any:   null,
        suppliers:      [],
        error:          "Failed to scrape — check manually",
      };
    }

    await page.waitForTimeout(3000); // polite pause between requests
  }

  await browser.close();

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2));

  // ── Summary ───────────────────────────────────────────────────────────────
  log("\n=== Scrape Complete ===");
  log(`Output: ${OUTPUT_PATH}`);
  log(`Date:   ${results.last_updated_readable}\n`);

  for (const u of Object.values(results.utilities)) {
    if (u.error) {
      log(`  ✗ ${u.display_name.padEnd(30)} FAILED`);
      continue;
    }
    const ptc   = u.ptc   ? `PTC=$${u.ptc}/kWh`                              : "PTC=unknown";
    const cheap = u.cheapest_fixed
      ? `best fixed: ${u.cheapest_fixed.name} @ $${u.cheapest_fixed.rate_kwh}/kWh`
      : "no fixed offers";
    log(`  ✓ ${u.display_name.padEnd(30)} ${String(u.total_offers).padStart(3)} offers  ${ptc.padEnd(18)}  ${cheap}`);
  }

  log("\nDone.\n");
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
