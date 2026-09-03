// api/zakat.js  —  Vercel serverless (CommonJS)
// Input : POST { holdings: [{ ticker, name, market, qty, priceUsd }], hijriYear }
// Output: { generatedAt, hijriYear, items: [...] }
// Each item carries ratios + source + confidence. Calculation happens in the UI.

const MODEL = "claude-sonnet-5";

// Assets whose treatment is fixed by nature — no web lookup needed.
const FIXED = {
  IAU:  { assetType: "gold",   zakatMethod: "full_mv", zakatableRatio: 1, purificationRatio: 0, shariaStatus: "compliant", confidence: "high", source: "الذهب يزكّى بكامل قيمته السوقية", notes: "" },
  IBIT: { assetType: "crypto", zakatMethod: "full_mv", zakatableRatio: 1, purificationRatio: 0, shariaStatus: "disputed",  confidence: "high", source: "يعامل معاملة النقد/عروض التجارة", notes: "حكم البيتكوين مختلف فيه" },
  CASH: { assetType: "cash",   zakatMethod: "full_mv", zakatableRatio: 1, purificationRatio: 0, shariaStatus: "compliant", confidence: "high", source: "النقد يزكّى بالكامل", notes: "" },
  KFH:  { assetType: "islamic_company", zakatMethod: "conservative", zakatableRatio: null, purificationRatio: 0, shariaStatus: "compliant", confidence: "high", source: "بنك إسلامي بالكامل — لا تطهير", notes: "نسبة الموجودات الزكوية تُحدّث من تقرير الهيئة الشرعية" },
  "KFH REIT": { assetType: "islamic_fund", zakatMethod: "conservative", zakatableRatio: null, purificationRatio: 0, shariaStatus: "compliant", confidence: "high", source: "صندوق عقاري إسلامي — لا تطهير", notes: "" },
};

const SYSTEM = `You are a Sharia-finance data researcher. For each stock you receive, search the web and return
the latest published data for the CURRENT or most recent fiscal year:

1. purificationRatio: fraction (0-1) of the company's income that is non-permissible (from the company's own
   Sharia board report, or from Zoya / Musaffa / Islamicly / IdealRatings / SP Funds annual purification report).
2. zakatableRatio: fraction (0-1) of share market value that is zakatable (نسبة الموجودات الزكوية للسهم), if any
   authority publishes it. Kuwaiti and Saudi companies often do; US companies usually do not -> null.
3. shariaStatus: "compliant" | "non_compliant" | "disputed".
4. dividendPerShare12m: total cash dividends per share over the last 12 months, in the company's trading
   currency (KWD for Kuwait, AED for Abu Dhabi, USD for US).
5. source: one URL or clear reference. confidence: "high" | "medium" | "low".

Rules:
- Never invent numbers. If not found, return null for that field and confidence "low".
- Fully Islamic institutions -> purificationRatio 0.
- Return ONLY a JSON array, no prose, no markdown fences. Each element:
  {"ticker":"","assetType":"mixed_company|islamic_company|us_stock|sharia_etf","purificationRatio":null,
   "zakatableRatio":null,"shariaStatus":"","dividendPerShare12m":null,"dividendCurrency":"",
   "source":"","confidence":"","notes":""}`;

async function askClaude(holdings) {
  const list = holdings.map(h => `${h.ticker} — ${h.name} (${h.market})`).join("\n");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 15 }],
      messages: [{ role: "user", content: `Stocks:\n${list}\n\nReturn the JSON array now.` }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.content.filter(b => b.type === "text").map(b => b.text).join("\n");
  const clean = text.replace(/```json|```/g, "").trim();
  const start = clean.indexOf("["), end = clean.lastIndexOf("]");
  return JSON.parse(clean.slice(start, end + 1));
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { holdings = [], hijriYear } = req.body || {};
    const fixed = [], lookup = [];
    for (const h of holdings) {
      const key = h.ticker.toUpperCase();
      if (FIXED[key]) fixed.push({ ticker: h.ticker, ...FIXED[key], dividendPerShare12m: null });
      else lookup.push(h);
    }

    let fetched = [];
    if (lookup.length) {
      const raw = await askClaude(lookup);
      fetched = lookup.map(h => {
        const r = raw.find(x => (x.ticker || "").toUpperCase() === h.ticker.toUpperCase()) || {};
        return {
          ticker: h.ticker,
          assetType: r.assetType || "mixed_company",
          // default to the conservative method; UI can switch to "precise" when zakatableRatio exists
          zakatMethod: "conservative",
          zakatableRatio: r.zakatableRatio ?? null,
          purificationRatio: r.purificationRatio ?? null,
          shariaStatus: r.shariaStatus || "disputed",
          dividendPerShare12m: r.dividendPerShare12m ?? null,
          dividendCurrency: r.dividendCurrency || "",
          source: r.source || "",
          confidence: r.confidence || "low",
          notes: r.notes || "",
        };
      });
    }

    res.status(200).json({ generatedAt: new Date().toISOString(), hijriYear, items: [...fixed, ...fetched] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
