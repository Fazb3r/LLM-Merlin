// Quick Gemini API test — run with: node test-gemini.js
require("dotenv").config();
const { GoogleGenerativeAI } = require("@google/generative-ai");

const key = process.env.GEMINI_API_KEY;
if (!key) { console.error("❌ GEMINI_API_KEY not set"); process.exit(1); }

console.log("🔑 Key loaded:", key.slice(0, 8) + "...");

const genAI = new GoogleGenerativeAI(key);

async function test(modelName) {
  process.stdout.write(`Testing ${modelName}... `);
  try {
    const model = genAI.getGenerativeModel({ model: modelName });
    const result = await model.generateContent("Reply with only: OK");
    console.log("✅", result.response.text().trim());
  } catch (e) {
    console.log("❌", e.message || String(e));
  }
}

(async () => {
  await test("gemini-2.0-flash");
  await test("gemini-2.0-flash-exp");
  await test("gemini-1.5-flash");
  await test("gemini-1.5-flash-latest");
})();
