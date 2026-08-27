// تخزين بيانات المحفظة على الخادم — محمي بكلمة مرور
// يستخدم Vercel KV إن توفر، وإلا يعود لتخزين مؤقت في الذاكرة

const KEY = "nadi:portfolio";

// تخزين احتياطي في الذاكرة (يُفقد عند إعادة تشغيل الخادم)
let memory = null;

function getPassword() {
  return process.env.NADI_PASSWORD || "";
}

// هل مفاتيح قاعدة البيانات مضبوطة؟
function hasKV() {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

async function kvGet() {
  const r = await fetch(
    process.env.KV_REST_API_URL + "/get/" + encodeURIComponent(KEY),
    { headers: { Authorization: "Bearer " + process.env.KV_REST_API_TOKEN } }
  );
  if (!r.ok) return null;
  const j = await r.json();
  if (!j || j.result == null) return null;
  try { return JSON.parse(j.result); } catch (e) { return null; }
}

async function kvSet(value) {
  const r = await fetch(
    process.env.KV_REST_API_URL + "/set/" + encodeURIComponent(KEY),
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.KV_REST_API_TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(value)
    }
  );
  return r.ok;
}

module.exports = async function handler(req, res) {
  const pass = getPassword();

  // فحص الحالة
  if (req.method === "GET" && req.query && req.query.status === "1") {
    res.status(200).json({
      ok: true,
      passwordConfigured: Boolean(pass),
      storage: hasKV() ? "database" : "memory",
      note: hasKV()
        ? "التخزين دائم"
        : "التخزين مؤقت — أضف قاعدة بيانات من Vercel Storage ليصبح دائمًا"
    });
    return;
  }

  if (!pass) {
    res.status(500).json({ error: "كلمة المرور غير مضبوطة. أضف NADI_PASSWORD في إعدادات المشروع." });
    return;
  }

  // التحقق من كلمة المرور في كل طلب
  var given = req.headers["x-nadi-pass"] || "";
  if (given !== pass) {
    res.status(401).json({ error: "كلمة المرور غير صحيحة" });
    return;
  }

  try {
    if (req.method === "GET") {
      var data = hasKV() ? await kvGet() : memory;
      res.status(200).json({ data: data || null });
      return;
    }

    if (req.method === "POST") {
      var payload = req.body || {};
      if (typeof payload === "string") {
        try { payload = JSON.parse(payload); } catch (e) { payload = {}; }
      }
      var value = payload.data;
      if (value === undefined) {
        res.status(400).json({ error: "لا توجد بيانات" });
        return;
      }

      if (hasKV()) {
        var ok = await kvSet(value);
        if (!ok) { res.status(502).json({ error: "تعذّر الحفظ في قاعدة البيانات" }); return; }
      } else {
        memory = value;
      }

      res.status(200).json({ ok: true, storage: hasKV() ? "database" : "memory" });
      return;
    }

    res.status(405).json({ error: "الطريقة غير مسموحة" });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
