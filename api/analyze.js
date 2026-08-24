// وسيط بين اللوحة وخدمة التحليل
// المفتاح يبقى على الخادم ولا يصل للمتصفح إطلاقًا

const MODEL = "claude-sonnet-5";

module.exports = async function handler(req, res) {
  // فحص سريع: افتح /api/analyze في المتصفح
  if (req.method === "GET") {
    res.status(200).json({
      ok: true,
      model: MODEL,
      keyConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
      hint: process.env.ANTHROPIC_API_KEY
        ? "المفتاح مضبوط — جرّب التحليل من اللوحة"
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

    var prompt = payload.prompt;
    var search = payload.search !== false;

    if (!prompt) {
      res.status(400).json({ error: "لا يوجد طلب" });
      return;
    }

    var body = {
      model: MODEL,
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }]
    };
    if (search) {
      body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }];
    }

    var r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(body)
    });

    var raw = await r.text();
    var data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      res.status(502).json({ error: "رد غير مقروء: " + raw.slice(0, 200) });
      return;
    }

    if (!r.ok) {
      res.status(r.status).json({
        error: (data && data.error && data.error.message) || ("الخدمة ردّت بالرمز " + r.status)
      });
      return;
    }

    var blocks = data.content || [];
    var text = "";
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i].type === "text") text += blocks[i].text + "\n";
    }

    if (!text.trim()) {
      res.status(502).json({ error: "الرد جاء فارغًا" });
      return;
    }

    res.status(200).json({ text: text });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
