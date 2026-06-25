// Quick Groq API test — run with: node test-groq.js
require("dotenv").config();
const Groq = require("groq-sdk").default ?? require("groq-sdk");

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function test(model) {
  process.stdout.write(`Testing ${model}... `);
  try {
    const res = await groq.chat.completions.create({
      model,
      messages: [{ role: "user", content: "Reply with only: OK" }],
      max_tokens: 10,
    });
    console.log("✅", res.choices[0]?.message?.content?.trim());
  } catch (e) {
    const msg = e?.message || String(e);
    const match = msg.match(/try again in ([^\. ]+)/i);
    console.log(`❌ ${match ? "Rate limit — retry in " + match[1] : msg.slice(0, 120)}`);
  }
}

(async () => {
  await test("openai/gpt-oss-120b");
  await test("llama-3.3-70b-versatile");
  await test("llama3-8b-8192");       // tiny model, different quota
  await test("gemma2-9b-it");          // Google's Gemma via Groq, different quota pool
})();
