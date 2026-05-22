const express = require("express");
const https   = require("https");
const zlib    = require("zlib");
const axios   = require("axios");

const app = express();
app.use(express.json());

/* ================= CONFIGURATION ================= */
const BASE_URL       = "https://www.ivasms.com";
const USER_AGENT     = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36";

// আপনার নতুন টেলিগ্রাম বটের ডিটেইলস
const BOT_TOKEN      = "8954465990:AAHNFwF94E3gMNw-3rfH19QqwoXE9DtbcjQ";
const CHANNEL_ID     = "@otphub001"; 

// আপনার দেওয়া লাইভ আইভাস কুকিজ
let COOKIES = {
  "XSRF-TOKEN": "eyJpdiI6IjNqMUN5K1Zhb0tFZ2dUelZOYmpqWFE9PSIsInZhbHVlIjoiUWRtenBMRnFBZm5xdXZycHIrdjlzd21uVFExelpzNTQ2R0l0UmNhTEJlcUlXOTVzeUIzcVpwVjlGVzVVak1jSWM0b1EvNi9VZDNxdFgzbUxvT0xXS0x2TUVEK0hWWHBXWnhiU2plMVZ0c3VFRnZtbWs3VlE0cWxEZVJWN1BNK0EiLCJtYWMiOiI0OTViZDk3OWZlYjQ5MjBmYzdjZjAwYzU0MTk3NTRjYWMzZjFhMjE3N2I1NDc1MWZkYzQwNGNhOTA0NDc3Mjg0IiwidGFnIjoiIn0%3D",
  "ivas_sms_session": "eyJpdiI6IkJnc0hHZFpkcUNwT2FFRjBBMkZmYnc9PSIsInZhbHVlIjoibDJXK1IrRGd2YitpbnZnMVNVelJtb3FlL3ZxYW4ycHEzK3hNWWwrdzBoSUxSbElyZWlpZ2FwMG1yeDlMRlVyZVpJTWZmMXozYlEraFBjOTVMQjBSWDFGYUpFbUlHanpKVkRBQjZnYVMydlhTeUFkZENmM0FTTlM5dXk1T3JmWlIiLCJtYWMiOiI2YWNkN2Q2ZjFjYWY1YTQwZTI5N2QwYWI1ZDhjM2Q5OTg3NGU1ODJhOGIyZGNjNDM4OGRkNTMwY2EwNzcwMzgwIiwidGFnIjoiIn0%3D"
};

// একই মেসেজ যাতে টেলিগ্রামে বারবার না যায়, তা ট্র্যাক করার জন্য
let processedMessages = new Set();

/* ================= HELPER FUNCTION ================= */
function makeRequest(method, path, bodyData = null, contentType = null, customHeaders = {}) {
  return new Promise((resolve, reject) => {
    const cookieStr = Object.keys(COOKIES).map(k => `${k}=${COOKIES[k]}`).join("; ");
    const headers = {
      "Cookie": cookieStr,
      "User-Agent": USER_AGENT,
      "Accept-Encoding": "gzip, deflate, br",
      ...customHeaders
    };
    if (contentType) headers["Content-Type"] = contentType;

    const url = `${BASE_URL}${path}`;
    const reqOpts = { method, headers };

    const req = https.request(url, reqOpts, (res) => {
      let chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        let buffer = Buffer.concat(chunks);
        const encoding = res.headers["content-encoding"];
        
        const processBody = (err, decoded) => {
          if (err) return reject(err);
          const bodyString = decoded.toString();
          resolve({ statusCode: res.statusCode, headers: res.headers, body: bodyString });
        };

        if (encoding === "gzip") zlib.gunzip(buffer, processBody);
        else if (encoding === "deflate") zlib.inflate(buffer, processBody);
        else if (encoding === "br") zlib.brotliDecompress(buffer, processBody);
        else processBody(null, buffer);
      });
    });

    req.on("error", err => reject(err));
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

// টেলিগ্রামে ওটিপি মেসেজ পাঠানোর ফাংশন
async function sendToTelegram(messageText) {
  const telegramUrl = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  try {
    await axios.post(telegramUrl, {
      chat_id: CHANNEL_ID,
      text: messageText,
      parse_mode: "Markdown"
    });
    console.log("🚀 [Telegram] Message posted successfully!");
  } catch (error) {
    console.error("❌ [Telegram] Error sending message:", error.message);
  }
}

// iVAS থেকে টোকেন বের করার ফাংশন
async function fetchToken() {
  try {
    const r = await makeRequest("GET", "/portal/sms/received");
    const m = r.body.match(/name="_token"\s+value="([^"]+)"/);
    return m ? m[1] : null;
  } catch (e) {
    console.error("❌ [IVAS] Token fetch failed:", e.message);
    return null;
  }
}

/* ================= CORE AUTOMATION ENGINE ================= */
async function checkAndForwardSMS() {
  console.log("🔄 Checking iVAS for new codes...");
  try {
    const token = await fetchToken();
    if (!token) {
      console.log("⚠️ Session expired or invalid cookies. Please update cookies via API.");
      return;
    }

    const today = new Date().toISOString().split('T')[0];

    // লেভেল ১: আজকের রেঞ্জ বা ক্যাটেগরি চেক করা
    const r1 = await makeRequest("POST", "/portal/sms/received/getsms/range",
      new URLSearchParams({ _token: token, start: today, end: today }).toString(),
      "application/x-www-form-urlencoded",
      { "Referer": `${BASE_URL}/portal/sms/received`, "X-Requested-With": "XMLHttpRequest" }
    );

    let ranges = [];
    try { ranges = JSON.parse(r1.body); } catch(e) { return; }
    if (!ranges || !ranges.aaData || ranges.aaData.length === 0) return;

    for (let row of ranges.aaData) {
      const rangeName = row[1]; 
      const match = rangeName.match(/value="([^"]+)"/);
      if (!match) continue;
      const rangeId = match[1];

      // লেভেল ২: ঐ রেঞ্জের ভেতরের নম্বর চেক করা
      const r2 = await makeRequest("POST", "/portal/sms/received/getsms/number",
        new URLSearchParams({ _token: token, start: today, end: today, Range: rangeId }).toString(),
        "application/x-www-form-urlencoded",
        { "Referer": `${BASE_URL}/portal/sms/received`, "X-Requested-With": "XMLHttpRequest" }
      );

      let numbers = [];
      try { numbers = JSON.parse(r2.body); } catch(e) { continue; }
      if (!numbers || !numbers.aaData) continue;

      for (let numRow of numbers.aaData) {
        const numName = numRow[1]; 
        const nMatch = numName.match(/value="([^"]+)"/);
        if (!nMatch) continue;
        const numberId = nMatch[1];

        // লেভেল ৩: সুনির্দিষ্ট নম্বরের মেসেজ বা ওটিপি বের করা
        const r3 = await makeRequest("POST", "/portal/sms/received/getsms/number/sms",
          new URLSearchParams({ _token: token, start: today, end: today, Number: numberId, Range: rangeId }).toString(),
          "application/x-www-form-urlencoded",
          { "Referer": `${BASE_URL}/portal/sms/received`, "X-Requested-With": "XMLHttpRequest" }
        );

        let smsData = [];
        try { smsData = JSON.parse(r3.body); } catch(e) { continue; }
        if (!smsData || !smsData.aaData) continue;

        // মেসেজগুলো চেক করে টেলিগ্রামে পাঠানো
        for (let smsRow of smsData.aaData) {
          const time = smsRow[0];
          const phoneNum = smsRow[2];
          const sender = smsRow[3];
          const fullMessage = smsRow[4];

          // একই মেসেজ বারবার পাঠানো বন্ধ করতে ইউনিক আইডি তৈরি করা
          const msgUniqueId = `${phoneNum}_${time}_${sender}`;

          if (!processedMessages.has(msgUniqueId)) {
            processedMessages.add(msgUniqueId);

            // টেলিগ্রামের জন্য সুন্দর মেসেজ ফরম্যাট
            const telegramMsg = `📩 *NEW OTP RECEIVED!*\n` +
                                `━━━━━━━━━━━━━━━━━━━━━\n\n` +
                                `📱 *Number:* \`${phoneNum}\`\n` +
                                `👤 *Sender:* ${sender}\n` +
                                `⏰ *Time:* ${time}\n\n` +
                                `💬 *Message:*\n\`${fullMessage}\`\n\n` +
                                `━━━━━━━━━━━━━━━━━━━━━`;

            await sendToTelegram(telegramMsg);
          }
        }
      }
    }
  } catch (error) {
    console.error("❌ Error in automation loop:", error.message);
  }
}

/* ================= API ROUTES FOR MANAGEMENT ================= */

// কুকি আপডেট করার এন্ডপয়েন্ট (কুকি এক্সপায়ার হয়ে গেলে কোড এডিট না করেই আপডেট করার জন্য)
app.post("/update-session", (req, res) => {
  const { xsrf, session } = req.body || {};
  if (!xsrf || !session) {
    return res.status(400).json({ error: "Required: xsrf and session" });
  }
  COOKIES["XSRF-TOKEN"]       = xsrf;
  COOKIES["ivas_sms_session"] = session;
  console.log("✅ [IVAS] Cookies updated successfully via API!");
  res.json({ success: true, message: "Cookies updated successfully!" });
});

app.get("/status", (req, res) => {
  res.json({ status: "running", channel: CHANNEL_ID, bot: "Active" });
});

/* ================= START SERVER & LIVE LOOP ================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🤖 Bot server is running on port ${PORT}`);
  
  // প্রতি ২০ সেকেন্ড পর পর অটোমেটিকভাবে চেক করবে নতুন মেসেজ আছে কিনা
  setInterval(checkAndForwardSMS, 20000);
});
