interface Env {
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  OWNER_USERNAME: string;
  DB: D1Database;
}

type TgUser = { id: number; username?: string; first_name?: string };
type TgMessage = { message_id: number; from?: TgUser; chat: { id: number }; text?: string };
type Update = {
  message?: TgMessage;
  callback_query?: {
    id: string;
    from: TgUser;
    data?: string;
    message?: { chat: { id: number }; message_id: number };
  };
};

async function tg(env: Env, method: string, body: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json() as { ok: boolean; description?: string };
  if (!result.ok) throw new Error(result.description || "Telegram API error");
  return result;
}

async function send(env: Env, chat_id: number | string, text: string, extra: Record<string, unknown> = {}) {
  return tg(env, "sendMessage", { chat_id, text, ...extra });
}

async function ownerId(env: Env): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'owner_id'").first<{value:string}>();
  return row?.value ?? null;
}

async function saveOwner(env: Env, id: number) {
  await env.DB.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('owner_id',?)").bind(String(id)).run();
}

async function setSession(env: Env, id: number, step: string, data: Record<string,string>) {
  await env.DB.prepare("INSERT OR REPLACE INTO sessions(user_id,step,data) VALUES(?,?,?)")
    .bind(String(id), step, JSON.stringify(data)).run();
}

async function getSession(env: Env, id: number) {
  return env.DB.prepare("SELECT step,data FROM sessions WHERE user_id=?").bind(String(id))
    .first<{step:string;data:string}>();
}

async function clearSession(env: Env, id: number) {
  await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(String(id)).run();
}

const menu = {
  keyboard: [
    [{ text: "📝 Подать заявку на администрацию" }],
    [{ text: "✉️ Связаться с владельцем" }],
  ],
  resize_keyboard: true,
};

async function handleMessage(env: Env, msg: TgMessage) {
  if (!msg.from || !msg.text) return;
  const id = msg.from.id;
  const text = msg.text.trim();
  const username = (msg.from.username || "").toLowerCase();

  if (text === "/start") {
    if (username === env.OWNER_USERNAME.replace(/^@/, "").toLowerCase()) {
      await saveOwner(env, id);
      await send(env, msg.chat.id, "Вы зарегистрированы как владелец бота. Новые заявки будут приходить сюда.", { reply_markup: menu });
    } else {
      await send(env, msg.chat.id, "Привет! Здесь можно подать заявку в администрацию.", { reply_markup: menu });
    }
    return;
  }

  if (text === "/id") {
    await send(env, msg.chat.id, `Ваш Telegram ID: ${id}`);
    return;
  }

  if (text === "✉️ Связаться с владельцем") {
    await send(env, msg.chat.id, "Связаться с владельцем: https://t.me/tw1ndypsyh", { reply_markup: menu });
    return;
  }

  if (text === "📝 Подать заявку на администрацию") {
    const pending = await env.DB.prepare("SELECT id FROM applications WHERE user_id=? AND status='pending' LIMIT 1")
      .bind(String(id)).first();
    if (pending) {
      await send(env, msg.chat.id, "У вас уже есть заявка на рассмотрении.", { reply_markup: menu });
      return;
    }
    await setSession(env, id, "telegram_time", {});
    await send(env, msg.chat.id, "1/5. Как давно вы пользуетесь Telegram?");
    return;
  }

  const session = await getSession(env, id);
  if (!session) return;
  const data = JSON.parse(session.data) as Record<string,string>;

  if (session.step === "telegram_time") {
    data.telegram_time = text;
    await setSession(env, id, "age", data);
    await send(env, msg.chat.id, "2/5. Сколько вам лет?");
  } else if (session.step === "age") {
    if (text.length > 20) { await send(env, msg.chat.id, "Укажите возраст числом."); return; }
    data.age = text;
    await setSession(env, id, "contact", data);
    await send(env, msg.chat.id, "3/5. Укажите ваш Telegram username (например, @username).");
  } else if (session.step === "contact") {
    data.contact = text;
    await setSession(env, id, "reason", data);
    await send(env, msg.chat.id, "4/5. Почему вы хотите стать администратором?");
  } else if (session.step === "reason") {
    if (text.length < 3) { await send(env, msg.chat.id, "Напишите немного подробнее."); return; }
    data.reason = text;
    await setSession(env, id, "availability", data);
    await send(env, msg.chat.id, "5/5. Готовы ли вы регулярно уделять время чату и следить за порядком?");
  } else if (session.step === "availability") {
    const owner = await ownerId(env);
    if (!owner) {
      await clearSession(env, id);
      await send(env, msg.chat.id, "Приём заявок пока не настроен. Владелец должен сначала открыть бота и нажать /start.", { reply_markup: menu });
      return;
    }
    data.availability = text;
    const result = await env.DB.prepare(
      "INSERT INTO applications(user_id,username,telegram_time,age,contact,reason,availability) VALUES(?,?,?,?,?,?,?)"
    ).bind(String(id), msg.from.username || "", data.telegram_time, data.age, data.contact, data.reason, data.availability).run();
    const appId = result.meta.last_row_id;
    const sender = msg.from.username ? "@" + msg.from.username : "не указан";
    const applicationText =
      `📝 Новая заявка №${appId}\n\nОт: ${sender}\nTelegram ID: ${id}\n1. В Telegram: ${data.telegram_time}\n2. Возраст: ${data.age}\n3. Контакт: ${data.contact}\n4. Почему хочет стать администратором: ${data.reason}\n5. Готовность уделять время: ${data.availability}`;
    await send(env, owner, applicationText, {
      reply_markup: { inline_keyboard: [[
        { text: "✅ Принять", callback_data: `app:accept:${appId}` },
        { text: "❌ Отклонить", callback_data: `app:reject:${appId}` },
      ]] },
    });
    await clearSession(env, id);
    await send(env, msg.chat.id, "Заявка отправлена владельцу. Повторно подать заявку можно будет после решения.", { reply_markup: menu });
  }
}

async function handleCallback(env: Env, cb: NonNullable<Update["callback_query"]>) {
  const owner = await ownerId(env);
  if (!owner || String(cb.from.id) !== owner) {
    await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: "Эта кнопка доступна только владельцу.", show_alert: true });
    return;
  }
  const parts = (cb.data || "").split(":");
  const action = parts[1];
  const appId = Number(parts[2]);
  if (!Number.isInteger(appId) || !["accept", "reject"].includes(action)) {
    await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: "Неизвестное действие.", show_alert: true });
    return;
  }
  const row = await env.DB.prepare("SELECT user_id,status FROM applications WHERE id=?").bind(appId)
    .first<{user_id:string;status:string}>();
  if (!row || row.status !== "pending") {
    await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: "Заявка уже обработана или не найдена.", show_alert: true });
    return;
  }
  const status = action === "accept" ? "accepted" : "rejected";
  await env.DB.prepare("UPDATE applications SET status=? WHERE id=? AND status='pending'").bind(status, appId).run();
  const decision = action === "accept" ? "принята" : "отклонена";
  await send(env, row.user_id, `По вашей заявке №${appId} принято решение: ${decision}.`);
  if (cb.message) {
    await tg(env, "editMessageReplyMarkup", { chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
  }
  await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: `Заявка ${decision}.` });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "tw1ndy-admin-bot" });
    }
    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("Not found", { status: 404 });
    }
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }
    try {
      const update = await request.json() as Update;
      if (update.message) await handleMessage(env, update.message);
      if (update.callback_query) await handleCallback(env, update.callback_query);
      return new Response("ok");
    } catch (error) {
      console.error("Webhook error", error);
      return new Response("Internal error", { status: 500 });
    }
  },
};
