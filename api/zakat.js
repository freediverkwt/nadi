// وسيط الزكاة والتطهير — يجلب النسب والمصادر من الويب لكل سهم
// المفتاح يبقى على الخادم ولا يصل للمتصفح إطلاقًا
//
// الطلب : POST { holdings: [{ symbol, name, market }] }   market: KW | AE | US
// الرد  : { goldUsdPerGram, items: [ { symbol, assetType, shariaStatus,
//           zakatPerShare, zakatableRatio, purificationRatio, purificationPerShare,
//           dividendPerShare12m, source, confidence, notes } ] }
// الحساب نفسه يتم في اللوحة حتى تقدر تعدّل أي رقم قبل الاعتماد

const MODEL = "claude-sonnet-5";

// أصول حكمها ثابت بطبيعتها — لا تحتاج بحث
const FIXED = {
  "IAU":      { assetType:"gold",   shariaStatus:"compliant", purificationRatio:0, confidence:"high", source:"الذهب يُزكّى بكامل قيمته السوقية", notes:"" },
  "IBIT":     { assetType:"crypto", shariaStatus:"disputed",  purificationRatio:0, confidence:"high", source:"يُعامل معاملة النقد وعروض التجارة", notes:"حكم البيتكوين مختلف فيه بين الهيئات" },
  "KFH":      { assetType:"islamic_company", shariaStatus:"compliant", purificationRatio:0, confidence:"high", source:"بنك إسلامي بالكامل — لا تطهير", notes:"" },
  "KFH REIT": { assetType:"islamic_fund",    shariaStatus:"compliant", purificationRatio:0, confidence:"high", source:"صندوق عقاري إسلامي — لا تطهير", notes:"" },
};

// الأسهم الإسلامية بالكامل نبحث لها فقط عن زكاة السهم والتوزيعات
const SEARCH_ANYWAY = ["KFH", "KFH REIT"];

const SYSTEM = `You are a Sharia-finance data researcher. The user is a Kuwaiti investor calculating zakat and
purification (تطهير) for his portfolio for the current Hijri year. For EACH holding, search the web and return
the most recent published figures. Search Arabic sources for Kuwaiti/Gulf companies (Boursa Kuwait disclosures,
the company's Sharia board annual report, "زكاة السهم", "نسبة الزكاة للسهم", "نسبة التطهير").

Fields per holding (null when not found — NEVER invent a number):
- assetType: "islamic_company" | "mixed_company" | "us_stock" | "sharia_etf" | "reit" | "other"
- shariaStatus: "compliant" | "non_compliant" | "disputed"
- zakatPerShare: zakat amount PER SHARE in the trading currency, if the company's Sharia board publishes it
  (common for Kuwaiti/Saudi companies, e.g. "زكاة السهم ٣ فلوس" -> 0.003 KWD). null otherwise.
- zakatableRatio: fraction 0-1 of share market value that is zakatable (نسبة الموجودات الزكوية), if published. null otherwise.
- purificationRatio: fraction 0-1 of income that is non-permissible (from the Sharia board, or Zoya / Musaffa /
  Islamicly / IdealRatings). Fully Islamic institutions -> 0.
- purificationPerShare: purification amount PER SHARE in trading currency if a fund publishes it directly
  (SP Funds publishes this annually for SPUS). null otherwise.
- dividendPerShare12m: total cash dividends per share paid in the last 12 months, trading currency. 0 if none.
- currency: "KWD" | "AED" | "USD"
- source: one URL or a clear reference (report name + year)
- confidence: "high" | "medium" | "low". Rules: US-stock screening ratios are at most "medium" (screeners disagree);
  anything not from an official company/fund/Sharia-board source is "low".
- notes: one short Arabic line, e.g. what year the figure is from.

Also return goldUsdPerGram: current gold spot price in USD per gram (search for it).

Return ONLY JSON, no prose, no markdown fences:
{"goldUsdPerGram": number, "items":[{"symbol":"","assetType":"","shariaStatus":"","zakatPerShare":null,
"zakatableRatio":null,"purificationRatio":null,"purificationPerShare":null,"dividendPerShare12m":null,
"currency":"","source":"","confidence":"","notes":""}]}`;

module.exports = async function handler(req, res) {
  // فحص سريع: افتح /api/zakat في المتصفح
  if (req.method === "GET") {
    res.status(200).json({
      ok: true,
      model: MODEL,
      keyConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
      hint: process.env.ANTHROPIC_API_KEY
        ? "المفتاح مضبوط — شغّل الحساب من تبويب الزكاة"
        : "المفتاح غير مضبوط. أضفه في إعدادات المشروع ثم أعد النشر."
    });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "الطريقة غير مسموحة" });
    return;
  }

  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    res.status(500).json({ error: "المفتاح غير مضبوط في إعدادات المشروع" });
    return;
  }

  try {
    var payload = req.body || {};
    if (typeof payload === "string") {
      try { payload = JSON.parse(payload); } catch (e) { payload = {}; }
    }
    var holdings = Array.isArray(payload.holdings) ? payload.holdings : [];
    if (!holdings.length) {
      res.status(400).json({ error: "لا توجد مراكز" });
      return;
    }

    // نفصل الثابت عن اللي يحتاج بحث
    var fixed = [], lookup = [];
    holdings.forEach(function (h) {
      var sym = String(h.symbol || "").toUpperCase().trim();
      var f = FIXED[sym];
      if (f && SEARCH_ANYWAY.indexOf(sym) === -1) {
        fixed.push(Object.assign({ symbol: sym, zakatPerShare: null, zakatableRatio: null,
          purificationPerShare: null, dividendPerShare12m: 0, currency: h.market === "KW" ? "KWD" : h.market === "AE" ? "AED" : "USD" }, f));
      } else {
        lookup.push(Object.assign({}, h, { symbol: sym }));
      }
    });

    var gold = null, found = [];

    if (lookup.length) {
      var list = lookup.map(function (h) {
        var mk = h.market === "KW" ? "Boursa Kuwait, KWD" : h.market === "AE" ? "ADX Abu Dhabi, AED" : "US market, USD";
        return "- " + h.symbol + " — " + (h.name || "") + " (" + mk + ")";
      }).join("\n");

      var r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 6000,
          system: SYSTEM,
          tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 20 }],
          messages: [{ role: "user", content: "Holdings:\n" + list + "\n\nReturn the JSON now." }]
        })
      });

      var raw = await r.text();
      var data;
      try { data = JSON.parse(raw); }
      catch (e) { res.status(502).json({ error: "رد غير مقروء: " + raw.slice(0, 200) }); return; }

      if (!r.ok) {
        res.status(r.status).json({
          error: (data && data.error && data.error.message) || ("الخدمة ردّت بالرمز " + r.status)
        });
        return;
      }

      var text = "";
      (data.content || []).forEach(function (b) { if (b.type === "text") text += b.text + "\n"; });
      var clean = text.replace(/```json|```/g, "").trim();
      var s = clean.indexOf("{"), e = clean.lastIndexOf("}");
      if (s === -1 || e === -1) { res.status(502).json({ error: "الرد جاء بدون بيانات مفهومة" }); return; }

      var out = JSON.parse(clean.slice(s, e + 1));
      gold = typeof out.goldUsdPerGram === "number" ? out.goldUsdPerGram : null;
      var items = Array.isArray(out.items) ? out.items : [];

      found = lookup.map(function (h) {
        var m = items.find(function (x) { return String(x.symbol || "").toUpperCase() === h.symbol; }) || {};
        var f = FIXED[h.symbol] || {};
        var conf = m.confidence || "low";
        if (h.market === "US" && conf === "high") conf = "medium";   // الفاحصون يختلفون
        return {
          symbol: h.symbol,
          assetType: f.assetType || m.assetType || "mixed_company",
          shariaStatus: f.shariaStatus || m.shariaStatus || "disputed",
          zakatPerShare: typeof m.zakatPerShare === "number" ? m.zakatPerShare : null,
          zakatableRatio: typeof m.zakatableRatio === "number" ? m.zakatableRatio : null,
          purificationRatio: f.purificationRatio != null ? f.purificationRatio
                             : (typeof m.purificationRatio === "number" ? m.purificationRatio : null),
          purificationPerShare: typeof m.purificationPerShare === "number" ? m.purificationPerShare : null,
          dividendPerShare12m: typeof m.dividendPerShare12m === "number" ? m.dividendPerShare12m : null,
          currency: m.currency || (h.market === "KW" ? "KWD" : h.market === "AE" ? "AED" : "USD"),
          source: m.source || f.source || "",
          confidence: conf,
          notes: m.notes || f.notes || ""
        };
      });
    }

    res.status(200).json({ goldUsdPerGram: gold, items: fixed.concat(found) });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
