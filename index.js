require("dotenv").config();

console.log("=== 장부 집계 봇 시작 ===");

process.on("uncaughtException", (e) => console.error("❌ UNCAUGHT:", e));
process.on("unhandledRejection", (e) => console.error("❌ UNHANDLED:", e));

const { Client, GatewayIntentBits } = require("discord.js");
const fetch = global.fetch;

// =========================
// ⭐ 여기 3개만 수정 ⭐
// =========================
const LOG_CHANNEL_ID = "1454845261447823421";
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GAS_WEBAPP_URL = process.env.GAS_WEBAPP_URL;
// =========================

// ✅ 백필 옵션
const BACKFILL_ON_START = false;     // true면 실행하자마자 과거로그 백필
const BACKFILL_MAX_MESSAGES = 0;     // 0이면 제한 없이 끝까지(많으면 오래 걸릴 수 있음). 예: 5000 처럼 제한 가능
const BACKFILL_BATCH_SIZE = 100;     // Discord API 최대 100
const BACKFILL_SLEEP_MS = 650;       // 레이트리밋 완화용 (너무 빠르면 막힐 수 있어)

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("clientReady", async () => {
  console.log("✅ 로그인 완료:", client.user.tag);
  console.log("✅ 감시 채널 ID:", LOG_CHANNEL_ID);

  if (BACKFILL_ON_START) {
    try {
      await backfillHistory();
      console.log("✅ 백필 완료");
    } catch (e) {
      console.error("❌ 백필 실패:", e);
    }
  }
});

// 메시지 본문+임베드 텍스트 합치기
function collectText(msg) {
  let out = "";
  if (msg.content) out += msg.content + "\n";

  for (const em of msg.embeds || []) {
    if (em.title) out += em.title + "\n";
    if (em.description) out += em.description + "\n";
    if (em.fields?.length) {
      for (const f of em.fields) out += `${f.name}: ${f.value}\n`;
    }
    if (em.footer?.text) out += em.footer.text + "\n";
  }
  return out.trim();
}

// 담당자: 🌞미야 -> 미야
function extractManager(text) {
  const raw = (text.match(/담당자\s*:\s*([^\n\r]+)/)?.[1] || "").trim();
  return raw.replace(/^[^0-9A-Za-z가-힣]+/g, "").trim();
}

// GAS로 전송(단건)
async function postToSheet(manager, messageId, loggedAtISO) {
  const res = await fetch(GAS_WEBAPP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ manager, messageId, loggedAt: loggedAtISO }),
  });

  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.ok === false) {
    console.error("❌ GAS ERROR:", res.status, j);
    return false;
  }
  return true;
}

// 메시지 1개 처리(실시간/백필 공용)
async function handleLedgerMessage(msg) {
  // 장부 로그 채널만
  if (msg.channelId !== LOG_CHANNEL_ID) return;

  // 봇 로그만
  if (!msg.author?.bot) return;

  const text = collectText(msg);
  if (!text.includes("담당자")) return;

  const manager = extractManager(text);
  if (!manager) return;

  await postToSheet(manager, msg.id, msg.createdAt.toISOString());
  console.log("✅ 건수 +1:", manager, "(msg:", msg.id + ")");
}

// ✅ 실시간 처리
client.on("messageCreate", async (msg) => {
  try {
    await handleLedgerMessage(msg);
  } catch (e) {
    console.error("❌ messageCreate error:", e);
  }
});

// ✅ 과거 로그 백필 (채널 메시지 기록을 뒤로 계속 가져옴)
async function backfillHistory() {
  const ch = await client.channels.fetch(LOG_CHANNEL_ID);
  if (!ch || !ch.isTextBased?.()) throw new Error("장부 로그 채널을 읽을 수 없습니다.");

  console.log("🔄 백필 시작: 과거 장부 로그를 읽는 중...");

  let beforeId = undefined;
  let total = 0;

  while (true) {
    const options = { limit: BACKFILL_BATCH_SIZE };
    if (beforeId) options.before = beforeId;

    const batch = await ch.messages.fetch(options);
    if (!batch.size) break;

    // 최신→과거로 오므로, 처리 순서는 상관없지만 보기 좋게 과거→최신으로 처리
    const msgs = Array.from(batch.values()).reverse();

    for (const m of msgs) {
      await handleLedgerMessage(m);
      total += 1;

      if (BACKFILL_MAX_MESSAGES > 0 && total >= BACKFILL_MAX_MESSAGES) {
        console.log("🛑 백필 제한 도달:", BACKFILL_MAX_MESSAGES);
        return;
      }
    }

    // 다음 페이지(더 과거)
    beforeId = batch.last().id;

    // 레이트리밋 완화
    await sleep(BACKFILL_SLEEP_MS);
  }

  console.log("📌 백필 처리된 메시지 수(대략):", total);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

client.login(DISCORD_TOKEN).catch((e) => console.error("❌ 로그인 실패:", e));
