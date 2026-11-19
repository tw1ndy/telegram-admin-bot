interface Env {
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  OWNER_USERNAME: string;
  DB: D1Database;
}
type TgUser = { id:number; username?:string; first_name?:string };
type TgPhoto = { file_id:string };
type TgMessage = { message_id:number; from?:TgUser; chat:{id:number}; text?:string; photo?:TgPhoto[] };
type Callback = { id:string; from:TgUser; data?:string; message?:{chat:{id:number};message_id:number} };
type Update = { message?:TgMessage; callback_query?:Callback };
type Session = { step:string; data:Record<string,string> };

const OWNER_FALLBACK = "tw1ndypsyh";
const PRICES:Record<string,number> = {w1:150,w2:200,m1:350,m3:600};
const mainMenu = {
  keyboard:[
    [{text:"🛒 Купить префикс"},{text:"⏳ Продлить префикс"}],
    [{text:"📦 Мои заказы"},{text:"🏷 Мои префиксы"}],
    [{text:"🧾 История покупок"},{text:"⚠️ Подать жалобу"}],
    [{text:"📢 Размещение рекламы"},{text:"🤝 Сотрудничество"}],
    [{text:"📝 Подать заявку на администрацию"}]
  ], resize_keyboard:true
};
const adminMenu = { keyboard:[
  [{text:"📥 Заказы на проверке"},{text:"🔎 Найти заказ"}],
  [{text:"💳 Реквизиты оплаты"},{text:"⚠️ Жалобы"}],
  [{text:"⬅️ Главное меню"}]
], resize_keyboard:true };

async function tg(env:Env, method:string, body:Record<string,unknown>) {
  const r=await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)
  });
  const result=await r.json() as {ok:boolean;description?:string};
  if(!result.ok) throw new Error(result.description || "Telegram API error");
  return result;
}
async function send(env:Env,chat_id:number|string,text:string,extra:Record<string,unknown>={}) {
  return tg(env,"sendMessage",{chat_id,text,...extra});
}
async function ownerId(env:Env) {
  const r=await env.DB.prepare("SELECT value FROM settings WHERE key='owner_id'").first<{value:string}>();
  return r?.value || null;
}
async function isOwner(env:Env,id:number) { const o=await ownerId(env); return !!o && o===String(id); }
async function saveOwner(env:Env,id:number) {
  await env.DB.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('owner_id',?)").bind(String(id)).run();
}
async function setting(env:Env,key:string) {
  const r=await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(key).first<{value:string}>();
  return r?.value || "";
}
async function setSetting(env:Env,key:string,value:string) {
  await env.DB.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)").bind(key,value).run();
}
async function setSession(env:Env,id:number,step:string,data:Record<string,string>={}) {
  await env.DB.prepare("INSERT OR REPLACE INTO sessions(user_id,step,data) VALUES(?,?,?)")
    .bind(String(id),step,JSON.stringify(data)).run();
}
async function getSession(env:Env,id:number):Promise<Session|null> {
  const r=await env.DB.prepare("SELECT step,data FROM sessions WHERE user_id=?").bind(String(id))
    .first<{step:string;data:string}>();
  return r ? {step:r.step,data:JSON.parse(r.data) as Record<string,string>} : null;
}
async function clearSession(env:Env,id:number) {
  await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(String(id)).run();
}
function userTag(u:TgUser) { return u.username ? "@"+u.username : (u.first_name || "без имени"); }
function priceFor(term:string,months:number) { return months>=6 ? 1000 : PRICES[term] || 0; }
function addMonths(date:Date,months:number) {
  const d=new Date(date); const day=d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth()+months);
  const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();
  d.setUTCDate(Math.min(day,last)); return d;
}
function fmt(value:string|null) {
  if(!value) return "—";
  return new Date(value).toLocaleString("ru-RU",{timeZone:"Europe/Moscow"});
}
async function newPublicId(table:"store_orders"|"complaints") {
  for(let i=0;i<30;i++) {
    const n=String(Math.floor(100000+Math.random()*900000));
    const exists=await (globalThis as unknown as {__db?:D1Database}).__db?.prepare("SELECT 1").first();
    void exists;
    return n;
  }
  throw new Error("Could not generate public ID");
}
async function uniqueOrderId(env:Env):Promise<string> {
  for(let i=0;i<50;i++) {
    const n=String(Math.floor(100000+Math.random()*900000));
    const row=await env.DB.prepare("SELECT 1 FROM store_orders WHERE public_id=? UNION SELECT 1 FROM complaints WHERE public_id=?")
      .bind(n,n).first();
    if(!row) return n;
  }
  throw new Error("Не удалось создать номер заявки");
}
async function paymentText(env:Env) {
  const parts=[await setting(env,"payment_text"),await setting(env,"payment_phone"),await setting(env,"payment_card")].filter(Boolean);
  return parts.join("\n");
}
function termKeyboard(prefix="term") {
  return {inline_keyboard:[
    [{text:"1 неделя — 150 ₽",callback_data:prefix+":w1"},{text:"2 недели — 200 ₽",callback_data:prefix+":w2"}],
    [{text:"1 месяц — 350 ₽",callback_data:prefix+":m1"},{text:"3 месяца — 600 ₽",callback_data:prefix+":m3"}],
    [{text:"От 6 месяцев — 1000 ₽",callback_data:prefix+":custom"}]
  ]};
}
async function createOrder(env:Env,user:TgUser,chatId:number,prefix:string,term:string,months:number,days:number,kind:"purchase"|"renewal",related:number|null) {
  const pay=await paymentText(env);
  if(!pay) { await send(env,chatId,"Оплата пока не настроена. Владелец ещё не добавил реквизиты."); return; }
  const amount=priceFor(term,months);
  const durationLabel=term==="w1"?"1 неделя":term==="w2"?"2 недели":months+" мес.";
  const durationDays=days || Math.round(months*30.4375);
  const id=await uniqueOrderId(env);
  const result=await env.DB.prepare(`INSERT INTO store_orders(public_id,user_id,username,first_name,kind,prefix,months,duration_label,duration_days,amount_rub,status,related_order_id)
    VALUES(?,?,?,?,?,?,?,?,?,?, 'awaiting_payment',?)`)
    .bind(id,String(user.id),user.username||"",user.first_name||"",kind,prefix,months,durationLabel,durationDays,amount,related).run();
  const orderRow=await env.DB.prepare("SELECT id FROM store_orders WHERE public_id=?").bind(id).first<{id:number}>();
  const orderDbId=orderRow?.id || Number(result.meta.last_row_id);
  const same=await env.DB.prepare("SELECT COUNT(*) AS n FROM store_orders WHERE prefix=? AND status='active' AND (expires_at IS NULL OR expires_at>?)")
    .bind(prefix,new Date().toISOString()).first<{n:number}>();
  const warning=(same?.n||0)>0 ? "\n⚠️ Такой префикс уже встречается среди активных. Вы всё равно можете продолжить оформление." : "";
  await send(env,chatId,`Заказ №${id} создан.\nПрефикс: ${prefix}\nСрок: ${durationLabel}\nСтоимость: ${amount} ₽${warning}\n\nРеквизиты для оплаты:\n${pay}\n\nПосле перевода нажмите «Я оплатил».`,{
    reply_markup:{inline_keyboard:[[{text:"✅ Я оплатил",callback_data:`paid:${orderDbId}`}]]}
  });
  const owner=await ownerId(env);
  if(owner) await send(env,owner,`🛒 Новый заказ №${id}\nПокупатель: ${userTag(user)} (ID ${user.id})\nПрефикс: ${prefix}\nСрок: ${months} мес.\nСумма: ${amount} ₽\nСтатус: ожидает оплаты`);
}
async function orderDetails(env:Env,row:Record<string,unknown>) {
  return `Заказ №${row.public_id}\nПокупатель: ${row.username ? "@"+row.username : row.first_name || "—"}\nTelegram ID: ${row.user_id}\nПрефикс: ${row.prefix}\nСрок: ${row.duration_label || (row.months+" мес.")}\nСумма: ${row.amount_rub} ₽\nСоздан: ${fmt(String(row.created_at||""))}\nСтатус: ${row.status}\nОплата подтверждена: ${fmt(row.paid_at ? String(row.paid_at):null)}\nНачало: ${fmt(row.starts_at ? String(row.starts_at):null)}\nОкончание: ${fmt(row.expires_at ? String(row.expires_at):null)}`;
}
async function handleMessage(env:Env,msg:TgMessage) {
  if(!msg.from) return;
  const u=msg.from,id=u.id,chat=msg.chat.id,text=(msg.text||"").trim();
  const owner=await isOwner(env,id);
  if(text==="/start") {
    if((u.username||"").toLowerCase()===(env.OWNER_USERNAME||OWNER_FALLBACK).replace(/^@/,"").toLowerCase()) {
      await saveOwner(env,id);
      await send(env,chat,"Панель владельца доступна. Старые заявки администрации сохранены.",{reply_markup:adminMenu});
    } else await send(env,chat,"Добро пожаловать! Выберите нужный раздел.",{reply_markup:mainMenu});
    return;
  }
  if(text==="/admin" && owner) { await send(env,chat,"Панель владельца:",{reply_markup:adminMenu}); return; }
  if(text==="/id") { await send(env,chat,`Ваш Telegram ID: ${id}`); return; }
  if(text==="⬅️ Главное меню") { await send(env,chat,"Главное меню:",{reply_markup:mainMenu}); return; }
  if(text==="🛒 Купить префикс") { await setSession(env,id,"buy_prefix"); await send(env,chat,"Введите желаемый префикс:"); return; }
  if(text==="⏳ Продлить префикс") {
    const rows=await env.DB.prepare("SELECT id,public_id,prefix,expires_at FROM store_orders WHERE user_id=? AND status='active' ORDER BY expires_at DESC")
      .bind(String(id)).all<{id:number;public_id:string;prefix:string;expires_at:string}>();
    if(!rows.results.length) { await send(env,chat,"У вас пока нет активных префиксов."); return; }
    await send(env,chat,"Выберите префикс для продления:",{reply_markup:{inline_keyboard:rows.results.map(r=>[{text:`${r.prefix} (до ${fmt(r.expires_at)})`,callback_data:`renew:${r.id}`}])}});
    return;
  }
  if(text==="📦 Мои заказы" || text==="🧾 История покупок") {
    const rows=await env.DB.prepare("SELECT public_id,prefix,months,duration_label,amount_rub,status,created_at FROM store_orders WHERE user_id=? ORDER BY created_at DESC LIMIT 15")
      .bind(String(id)).all<{public_id:string;prefix:string;months:number;duration_label:string;amount_rub:number;status:string;created_at:string}>();
    await send(env,chat,rows.results.length ? rows.results.map(r=>`№${r.public_id} · ${r.prefix} · ${r.duration_label || (r.months+" мес.")} · ${r.amount_rub} ₽ · ${r.status} · ${fmt(r.created_at)}`).join("\n") : "Заказов пока нет.");
    return;
  }
  if(text==="🏷 Мои префиксы") {
    const rows=await env.DB.prepare("SELECT public_id,prefix,expires_at FROM store_orders WHERE user_id=? AND status='active' ORDER BY expires_at DESC")
      .bind(String(id)).all<{public_id:string;prefix:string;expires_at:string}>();
    await send(env,chat,rows.results.length ? rows.results.map(r=>`${r.prefix} · заказ №${r.public_id} · до ${fmt(r.expires_at)}`).join("\n") : "Активных префиксов нет.");
    return;
  }
  if(text==="📢 Размещение рекламы") { await send(env,chat,"Чтобы обсудить размещение рекламы, напишите владельцу: https://t.me/tw1ndypsyh"); return; }
  if(text==="🤝 Сотрудничество") { await send(env,chat,"По вопросам сотрудничества напишите владельцу: https://t.me/tw1ndypsyh"); return; }
  if(text==="⚠️ Подать жалобу") { await setSession(env,id,"complaint_target"); await send(env,chat,"Укажите username пользователя, на которого подаёте жалобу:"); return; }
  if(text==="📝 Подать заявку на администрацию") {
    const pending=await env.DB.prepare("SELECT id FROM applications WHERE user_id=? AND status='pending' LIMIT 1").bind(String(id)).first();
    if(pending) { await send(env,chat,"У вас уже есть заявка на рассмотрении."); return; }
    await setSession(env,id,"telegram_time",{}); await send(env,chat,"1/5. Как давно вы пользуетесь Telegram?"); return;
  }
  if(owner && text==="📥 Заказы на проверке") {
    const rows=await env.DB.prepare("SELECT id,public_id,prefix,amount_rub,username FROM store_orders WHERE status='payment_check' ORDER BY created_at ASC LIMIT 20")
      .all<{id:number;public_id:string;prefix:string;amount_rub:number;username:string}>();
    if(!rows.results.length) { await send(env,chat,"Заказов на проверке нет."); return; }
    for(const r of rows.results) await send(env,chat,`Заказ №${r.public_id}\nПокупатель: @${r.username||"—"}\nПрефикс: ${r.prefix}\nСумма: ${r.amount_rub} ₽`,{reply_markup:{inline_keyboard:[[{text:"✅ Подтвердить оплату",callback_data:`approve:${r.id}`},{text:"❌ Отклонить",callback_data:`reject:${r.id}`}]]}});
    return;
  }
  if(owner && text==="🔎 Найти заказ") { await setSession(env,id,"admin_search"); await send(env,chat,"Введите шестизначный номер заказа:"); return; }
  if(owner && text==="💳 Реквизиты оплаты") {
    const p=await paymentText(env);
    await setSession(env,id,"payment_edit");
    await send(env,chat,`Текущие реквизиты:\n${p||"не заданы"}\n\nОтправьте новые реквизиты одним сообщением. Можно указать телефон, карту и пояснение. Для очистки отправьте: очистить`);
    return;
  }
  if(owner && text==="⚠️ Жалобы") {
    const rows=await env.DB.prepare("SELECT public_id,target_username,reason,details,username,created_at FROM complaints WHERE status='new' ORDER BY created_at DESC LIMIT 10")
      .all<{public_id:string;target_username:string;reason:string;details:string;username:string;created_at:string}>();
    await send(env,chat,rows.results.length?rows.results.map(r=>`Жалоба №${r.public_id}\nНа: ${r.target_username}\nОт: @${r.username||"—"}\nПричина: ${r.reason}\nОписание: ${r.details}\nДата: ${fmt(r.created_at)}`).join("\n\n"):"Новых жалоб нет.");
    return;
  }
  const s=await getSession(env,id); if(!s) return;
  if(s.step==="buy_prefix") {
    if(text.length<1||text.length>32) { await send(env,chat,"Префикс должен содержать от 1 до 32 символов."); return; }
    s.data.prefix=text; await setSession(env,id,"buy_term",s.data);
    await send(env,chat,"Выберите срок:",{reply_markup:termKeyboard("buy")}); return;
  }
  if(s.step==="custom_months") {
    const months=Number(text);
    if(!Number.isInteger(months)||months<6||months>120) { await send(env,chat,"Введите число месяцев от 6 до 120."); return; }
    const prefix=s.data.prefix,kind=s.data.kind||"purchase",related=s.data.related?Number(s.data.related):null;
    await clearSession(env,id); await createOrder(env,u,chat,prefix,s.data.term||"custom",months,months*30,kind,related); return;
  }
  if(s.step==="complaint_target") { s.data.target=text; await setSession(env,id,"complaint_reason",s.data); await send(env,chat,"Укажите причину жалобы:"); return; }
  if(s.step==="complaint_reason") { s.data.reason=text; await setSession(env,id,"complaint_details",s.data); await send(env,chat,"Опишите ситуацию подробнее. Если есть скриншот, отправьте его следующим сообщением; если нет — напишите «нет»."); return; }
  if(s.step==="complaint_details") {
    const id6=await uniqueOrderId(env);
    const photo=msg.photo?.[msg.photo.length-1]?.file_id || null;
    const details=text || (photo ? "Приложен скриншот." : "");
    await env.DB.prepare("INSERT INTO complaints(public_id,user_id,username,target_username,reason,details,photo_file_id) VALUES(?,?,?,?,?,?,?)")
      .bind(id6,String(id),u.username||"",s.data.target,s.data.reason,details,photo).run();
    await clearSession(env,id);
    await send(env,chat,`Жалоба №${id6} отправлена владельцу.`,{reply_markup:mainMenu});
    const o=await ownerId(env);
    if(o) {
      await send(env,o,`⚠️ Новая жалоба №${id6}\nОт: ${userTag(u)}\nНа: ${s.data.target}\nПричина: ${s.data.reason}\nОписание: ${details}`);
      if(photo) await tg(env,"sendPhoto",{chat_id:o,photo,caption:`Скриншот к жалобе №${id6}`});
    }
    return;
  }
  if(s.step==="payment_edit" && owner) {
    await setSetting(env,"payment_text",text.toLowerCase()==="очистить"?"":text);
    await setSetting(env,"payment_phone",""); await setSetting(env,"payment_card","");
    await clearSession(env,id); await send(env,chat,"Реквизиты сохранены.",{reply_markup:adminMenu}); return;
  }
  if(s.step==="admin_search" && owner) {
    if(!/^\d{6}$/.test(text)) { await send(env,chat,"Нужен шестизначный номер."); return; }
    const row=await env.DB.prepare("SELECT * FROM store_orders WHERE public_id=?").bind(text).first<Record<string,unknown>>();
    await clearSession(env,id);
    await send(env,chat,row?await orderDetails(env,row):"Заказ с таким номером не найден.",{reply_markup:adminMenu}); return;
  }
  if(s.step==="telegram_time") {
    s.data.telegram_time=text; await setSession(env,id,"age",s.data); await send(env,chat,"2/5. Сколько вам лет?"); return;
  }
  if(s.step==="age") { s.data.age=text; await setSession(env,id,"contact",s.data); await send(env,chat,"3/5. Укажите Telegram username."); return; }
  if(s.step==="contact") { s.data.contact=text; await setSession(env,id,"reason",s.data); await send(env,chat,"4/5. Почему хотите стать администратором?"); return; }
  if(s.step==="reason") { s.data.reason=text; await setSession(env,id,"availability",s.data); await send(env,chat,"5/5. Готовы регулярно уделять время чату?"); return; }
  if(s.step==="availability") {
    const o=await ownerId(env);
    if(!o) { await clearSession(env,id); await send(env,chat,"Приём заявок не настроен.",{reply_markup:mainMenu}); return; }
    const pending=await env.DB.prepare("SELECT id FROM applications WHERE user_id=? AND status='pending' LIMIT 1").bind(String(id)).first();
    if(pending) { await clearSession(env,id); await send(env,chat,"У вас уже есть заявка на рассмотрении.",{reply_markup:mainMenu}); return; }
    const r=await env.DB.prepare("INSERT INTO applications(user_id,username,telegram_time,age,contact,reason,availability) VALUES(?,?,?,?,?,?,?)")
      .bind(String(id),u.username||"",s.data.telegram_time,s.data.age,s.data.contact,s.data.reason,text).run();
    const appId=r.meta.last_row_id;
    await send(env,o,`📝 Новая заявка №${appId}\nОт: ${userTag(u)}\nID: ${id}\nTelegram: ${s.data.telegram_time}\nВозраст: ${s.data.age}\nКонтакт: ${s.data.contact}\nПричина: ${s.data.reason}\nГотовность: ${text}`,{reply_markup:{inline_keyboard:[[{text:"✅ Принять",callback_data:`app:accept:${appId}`},{text:"❌ Отклонить",callback_data:`app:reject:${appId}`}]]}});
    await clearSession(env,id); await send(env,chat,"Заявка отправлена владельцу.",{reply_markup:mainMenu}); return;
  }
}
async function handleCallback(env:Env,cb:Callback) {
  const data=cb.data||"",parts=data.split(":");
  if(data.startsWith("buy:")||data.startsWith("renewterm:")) {
    const isRenew=data.startsWith("renewterm:"),v=parts[1];
    const s=await getSession(env,cb.from.id);
    if(!s) { await tg(env,"answerCallbackQuery",{callback_query_id:cb.id,text:"Сессия устарела.",show_alert:true}); return; }
    if(v==="custom") { await setSession(env,cb.from.id,"custom_months",{...s.data,kind:isRenew?"renewal":"purchase"}); await send(env,cb.from.id,"Введите срок в месяцах (от 6 до 120)."); }
    else {
      const months=v==="m1"?1:v==="m3"?3:0,days=v==="w1"?7:v==="w2"?14:0,kind=isRenew?"renewal":"purchase";
      const related=s.data.related?Number(s.data.related):null;
      await clearSession(env,cb.from.id);
      await createOrder(env,cb.from,cb.from.id,s.data.prefix,v,months,days,kind,related);
    }
    await tg(env,"answerCallbackQuery",{callback_query_id:cb.id}); return;
  }
  if(data.startsWith("renew:")) {
    const orderId=Number(parts[1]);
    const row=await env.DB.prepare("SELECT id,prefix,user_id FROM store_orders WHERE id=? AND user_id=? AND status='active'")
      .bind(orderId,String(cb.from.id)).first<{id:number;prefix:string;user_id:string}>();
    if(!row) { await tg(env,"answerCallbackQuery",{callback_query_id:cb.id,text:"Префикс не найден.",show_alert:true}); return; }
    await setSession(env,cb.from.id,"buy_term",{prefix:row.prefix,related:String(row.id)});
    await send(env,cb.from.id,"Выберите срок продления:",{reply_markup:termKeyboard("renewterm")});
    await tg(env,"answerCallbackQuery",{callback_query_id:cb.id}); return;
  }
  if(data.startsWith("paid:")) {
    const id=Number(parts[1]);
    const r=await env.DB.prepare("UPDATE store_orders SET status='payment_check' WHERE id=? AND user_id=? AND status='awaiting_payment'")
      .bind(id,String(cb.from.id)).run();
    const row=await env.DB.prepare("SELECT public_id,prefix,amount_rub FROM store_orders WHERE id=?").bind(id)
      .first<{public_id:string;prefix:string;amount_rub:number}>();
    if(row && r.meta.changes) {
      const o=await ownerId(env); if(o) await send(env,o,`💰 Покупатель отметил оплату\nЗаказ №${row.public_id}\nПрефикс: ${row.prefix}\nСумма: ${row.amount_rub} ₽`,{reply_markup:{inline_keyboard:[[{text:"✅ Подтвердить оплату",callback_data:`approve:${id}`},{text:"❌ Отклонить",callback_data:`reject:${id}`}]]}});
      await send(env,cb.from.id,"Отметка об оплате отправлена владельцу. Ожидайте проверки.");
    }
    await tg(env,"answerCallbackQuery",{callback_query_id:cb.id,text:"Отправлено владельцу."}); return;
  }
  if(data.startsWith("approve:")||data.startsWith("reject:")) {
    if(!(await isOwner(env,cb.from.id))) { await tg(env,"answerCallbackQuery",{callback_query_id:cb.id,text:"Только владелец.",show_alert:true}); return; }
    const id=Number(parts[1]);
    const row=await env.DB.prepare("SELECT * FROM store_orders WHERE id=? AND status='payment_check'").bind(id).first<Record<string,unknown>>();
    if(!row) { await tg(env,"answerCallbackQuery",{callback_query_id:cb.id,text:"Заказ уже обработан.",show_alert:true}); return; }
    if(parts[0]==="reject") {
      await env.DB.prepare("UPDATE store_orders SET status='awaiting_payment' WHERE id=?").bind(id).run();
      await send(env,String(row.user_id),`Оплата по заказу №${row.public_id} не подтверждена. Проверьте перевод и при необходимости нажмите «Я оплатил» повторно.`);
    } else {
      const now=new Date(),base=row.related_order_id?await env.DB.prepare("SELECT expires_at FROM store_orders WHERE id=? AND user_id=? AND status='active'")
        .bind(Number(row.related_order_id),String(row.user_id)).first<{expires_at:string}>():null;
      const activeExpiry=base?.expires_at?new Date(base.expires_at):null;
      const start=activeExpiry && activeExpiry>now?activeExpiry:now;
      const expiry=Number(row.months)>0?addMonths(start,Number(row.months)):new Date(start.getTime()+Number(row.duration_days)*86400000);
      await env.DB.prepare("UPDATE store_orders SET status='active',paid_at=?,starts_at=?,expires_at=?,reminder_before_sent=0,reminder_after_sent=0 WHERE id=?")
        .bind(now.toISOString(),start.toISOString(),expiry.toISOString(),id).run();
      await send(env,String(row.user_id),`✅ Оплата заказа №${row.public_id} подтверждена.\nПрефикс: ${row.prefix}\nНачало срока: ${fmt(start.toISOString())}\nОкончание: ${fmt(expiry.toISOString())}\n\nВладелец назначит префикс вручную.`);
      await send(env,cb.from.id,`Заказ №${row.public_id} активирован. Не забудьте вручную назначить префикс ${row.prefix}.`);
    }
    if(cb.message) await tg(env,"editMessageReplyMarkup",{chat_id:cb.message.chat.id,message_id:cb.message.message_id,reply_markup:{inline_keyboard:[]}});
    await tg(env,"answerCallbackQuery",{callback_query_id:cb.id,text:parts[0]==="approve"?"Оплата подтверждена.":"Оплата отклонена."}); return;
  }
  if(data.startsWith("app:")) {
    if(!(await isOwner(env,cb.from.id))) { await tg(env,"answerCallbackQuery",{callback_query_id:cb.id,text:"Только владелец.",show_alert:true}); return; }
    const appId=Number(parts[2]),status=parts[1]==="accept"?"accepted":parts[1]==="reject"?"rejected":"";
    if(!status) return;
    const row=await env.DB.prepare("SELECT user_id,status FROM applications WHERE id=?").bind(appId).first<{user_id:string;status:string}>();
    if(!row||row.status!=="pending") { await tg(env,"answerCallbackQuery",{callback_query_id:cb.id,text:"Заявка уже обработана."}); return; }
    await env.DB.prepare("UPDATE applications SET status=? WHERE id=? AND status='pending'").bind(status,appId).run();
    await send(env,row.user_id,`По вашей заявке №${appId} принято решение: ${status==="accepted"?"принята":"отклонена"}.`);
    if(cb.message) await tg(env,"editMessageReplyMarkup",{chat_id:cb.message.chat.id,message_id:cb.message.message_id,reply_markup:{inline_keyboard:[]}});
    await tg(env,"answerCallbackQuery",{callback_query_id:cb.id,text:"Готово."});
  }
}
async function scheduled(env:Env) {
  const now=new Date(),soon=new Date(now.getTime()+5*60*1000);
  const due=await env.DB.prepare("SELECT id,public_id,user_id,prefix,expires_at FROM store_orders WHERE status='active' AND expires_at>? AND expires_at<=? AND reminder_before_sent=0")
    .bind(now.toISOString(),soon.toISOString()).all<{id:number;public_id:string;user_id:string;prefix:string;expires_at:string}>();
  const owner=await ownerId(env);
  for(const r of due.results) {
    await send(env,r.user_id,`⏳ До окончания префикса ${r.prefix} (заказ №${r.public_id}) осталось около 5 минут.`);
    if(owner) await send(env,owner,`⏳ Через 5 минут истекает префикс ${r.prefix}, заказ №${r.public_id}. Уведомление покупателю отправлено.`);
    await env.DB.prepare("UPDATE store_orders SET reminder_before_sent=1 WHERE id=?").bind(r.id).run();
  }
  const expired=await env.DB.prepare("SELECT id,public_id,user_id,prefix FROM store_orders WHERE status='active' AND expires_at<=? AND reminder_after_sent=0")
    .bind(new Date(now.getTime()-5*60*1000).toISOString()).all<{id:number;public_id:string;user_id:string;prefix:string}>();
  for(const r of expired.results) {
    if(owner) await send(env,owner,`⚠️ Срок префикса ${r.prefix} истёк более 5 минут назад (заказ №${r.public_id}). Удалите префикс вручную.`);
    await env.DB.prepare("UPDATE store_orders SET status='expired',reminder_after_sent=1 WHERE id=?").bind(r.id).run();
  }
}
export default {
  async fetch(request:Request,env:Env):Promise<Response> {
    const url=new URL(request.url);
    if(request.method==="GET"&&url.pathname==="/health") return Response.json({ok:true,service:"tw1ndy-admin-bot"});
    if(request.method==="POST"&&url.pathname==="/setup-webhook") {
      if(request.headers.get("Authorization")!==`Bearer ${env.WEBHOOK_SECRET}`) return new Response("Unauthorized",{status:401});
      const r=await tg(env,"setWebhook",{url:"https://tw1ndy-admin-bot.tw1ndy228.workers.dev/webhook",secret_token:env.WEBHOOK_SECRET,allowed_updates:["message","callback_query"]});
      return Response.json({ok:true,webhook:r.ok});
    }
    if(request.method!=="POST"||url.pathname!=="/webhook") return new Response("Not found",{status:404});
    if(request.headers.get("X-Telegram-Bot-Api-Secret-Token")!==env.WEBHOOK_SECRET) return new Response("Unauthorized",{status:401});
    try {
      const update=await request.json() as Update;
      if(update.message) await handleMessage(env,update.message);
      if(update.callback_query) await handleCallback(env,update.callback_query);
      return new Response("ok");
    } catch(e) { console.error("Webhook error",e); return new Response("Internal error",{status:500}); }
  },
  async scheduled(_event:ScheduledEvent,env:Env,ctx:ExecutionContext) { ctx.waitUntil(scheduled(env)); }
};
