
// تخزين بيانات المحفظة — لكل مستخدم مساحة منفصلة محمية بكلمة مروره
//
// الإعداد في Vercel:
//   NADI_PASSWORD  = كلمة مرورك أنت (المالك)
//   NADI_USERS     = ahmad:كلمة_مرور,sami:كلمة_مرور   ← اختياري للأصدقاء

const OWNER = "owner";

let memory = {};   // تخزين احتياطي مؤقت

function keyFor(user) {
  return "nadi:portfolio:" + user;
}

// يقرأ قائمة المستخدمين من الإعدادات
function getUsers() {
  var map = {};
  var owner = process.env.NADI_PASSWORD || "";
  if (owner) map[OWNER] = owner;

  var raw = process.env.NADI_USERS || "";
  raw.split(",").forEach(function (pair) {
    var i = pair.indexOf(":");
    if (i < 1) return;
    var name = pair.slice(0, i).trim().toLowerCase();
    var pass = pair.slice(i + 1).trim();
    if (name && pass) map[name] = pass;
  });
  return map;
}

function hasKV() {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

async function kvGet(k) {
  var r = await fetch(
    process.env.KV_REST_API_URL + "/get/" + encodeURIComponent(k),
    { headers: { Authorization: "Bearer " + process.env.KV_REST_API_TOKEN } }
  );
  if (!r.ok) return null;
  var j = await r.json();
  if (!j || j.result == null) return null;
  try { return JSON.parse(j.result); } catch (e) { return null; }
}

async function kvSet(k, value) {
  var r = await fetch(
    process.env.KV_REST_API_URL + "/set/" + encodeURIComponent(k),
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
  var users = getUsers();

  // فحص الحالة
  if (req.method === "GET" && req.query && req.query.status === "1") {
    res.status(200).json({
      ok: true,
      passwordConfigured: Boolean(users[OWNER]),
      users: Object.keys(users),
      storage: hasKV() ? "database" : "memory",
      note: hasKV() ? "التخزين دائم" : "التخزين مؤقت — اربط قاعدة بيانات"
    });
    return;
  }

  if (!Object.keys(users).length) {
    res.status(500).json({ error: "لا يوجد مستخدمون. أضف NADI_PASSWORD في إعدادات المشروع." });
    return;
  }

  // من هو المستخدم؟
  var who = String(
    (req.query && req.query.u) || req.headers["x-nadi-user"] || OWNER
  ).trim().toLowerCase() || OWNER;

  var expected = users[who];
  if (!expected) {
    res.status(404).json({ error: "مستخدم غير معروف: " + who });
    return;
  }

  var given = req.headers["x-nadi-pass"] || "";
  if (given !== expected) {
    res.status(401).json({ error: "كلمة المرور غير صحيحة" });
    return;
  }

  var k = keyFor(who);

  try {
    if (req.method === "GET") {
      var data = hasKV() ? await kvGet(k) : (memory[k] || null);
      res.status(200).json({ data: data || null, user: who });
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
        var ok = await kvSet(k, value);
        if (!ok) { res.status(502).json({ error: "تعذّر الحفظ" }); return; }
      } else {
        memory[k] = value;
      }

      res.status(200).json({ ok: true, user: who });
      return;
    }

    res.status(405).json({ error: "الطريقة غير مسموحة" });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
