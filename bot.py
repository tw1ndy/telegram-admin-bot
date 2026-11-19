import asyncio
import logging
import os
import sqlite3
from pathlib import Path

from aiogram import Bot, Dispatcher, F
from aiogram.filters import CommandStart, Command
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import (
    Message, CallbackQuery, ReplyKeyboardMarkup, KeyboardButton,
    InlineKeyboardMarkup, InlineKeyboardButton
)

BOT_TOKEN = os.getenv("BOT_TOKEN")
OWNER_USERNAME = "tw1ndypsyh"
DB_PATH = Path(os.getenv("DB_PATH", "applications.sqlite3"))

if not BOT_TOKEN:
    raise RuntimeError("Set BOT_TOKEN in the hosting service environment variables.")

logging.basicConfig(level=logging.INFO)
bot = Bot(token=BOT_TOKEN)
dp = Dispatcher()


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS applications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                username TEXT,
                telegram_time TEXT NOT NULL,
                age TEXT NOT NULL,
                contact TEXT NOT NULL,
                reason TEXT NOT NULL,
                availability TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        """)


def get_owner_id():
    with db() as conn:
        row = conn.execute(
            "SELECT value FROM settings WHERE key = 'owner_id'"
        ).fetchone()
        return int(row["value"]) if row else None


def set_owner_id(user_id: int):
    with db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO settings(key, value) VALUES('owner_id', ?)",
            (str(user_id),)
        )


def has_pending(user_id: int) -> bool:
    with db() as conn:
        row = conn.execute(
            "SELECT id FROM applications WHERE user_id = ? AND status = 'pending'",
            (user_id,)
        ).fetchone()
        return row is not None


class Application(StatesGroup):
    telegram_time = State()
    age = State()
    contact = State()
    reason = State()
    availability = State()


main_menu = ReplyKeyboardMarkup(
    keyboard=[
        [KeyboardButton(text="📝 Подать заявку на администрацию")],
        [KeyboardButton(text="✉️ Связаться с владельцем")],
    ],
    resize_keyboard=True
)


def review_keyboard(app_id: int):
    return InlineKeyboardMarkup(inline_keyboard=[
        [
            InlineKeyboardButton(text="✅ Принять", callback_data=f"app:accept:{app_id}"),
            InlineKeyboardButton(text="❌ Отклонить", callback_data=f"app:reject:{app_id}"),
        ]
    ])


@dp.message(CommandStart())
async def start(message: Message):
    username = (message.from_user.username or "").lower()
    if username == OWNER_USERNAME.lower():
        set_owner_id(message.from_user.id)
        await message.answer(
            "Вы зарегистрированы как владелец бота. Новые заявки будут приходить сюда.",
            reply_markup=main_menu
        )
        return

    await message.answer(
        "Привет! Здесь можно подать заявку в администрацию.",
        reply_markup=main_menu
    )


@dp.message(Command("id"))
async def show_id(message: Message):
    await message.answer(f"Ваш Telegram ID: {message.from_user.id}")


@dp.message(F.text == "✉️ Связаться с владельцем")
async def contact_owner(message: Message):
    await message.answer("Связаться с владельцем: https://t.me/tw1ndypsyh")


@dp.message(F.text == "📝 Подать заявку на администрацию")
async def begin_application(message: Message, state: FSMContext):
    if has_pending(message.from_user.id):
        await message.answer("У вас уже есть заявка на рассмотрении.")
        return
    await state.set_state(Application.telegram_time)
    await message.answer("1/5. Как давно вы пользуетесь Telegram?")


@dp.message(Application.telegram_time)
async def answer_telegram_time(message: Message, state: FSMContext):
    answer = (message.text or "").strip()
    if not answer:
        await message.answer("Напишите ответ текстом.")
        return
    await state.update_data(telegram_time=answer)
    await state.set_state(Application.age)
    await message.answer("2/5. Сколько вам лет?")


@dp.message(Application.age)
async def answer_age(message: Message, state: FSMContext):
    answer = (message.text or "").strip()
    if not answer or len(answer) > 20:
        await message.answer("Укажите возраст числом.")
        return
    await state.update_data(age=answer)
    await state.set_state(Application.contact)
    await message.answer("3/5. Укажите ваш Telegram username (например, @username).")


@dp.message(Application.contact)
async def answer_contact(message: Message, state: FSMContext):
    answer = (message.text or "").strip()
    if not answer:
        await message.answer("Укажите username текстом.")
        return
    await state.update_data(contact=answer)
    await state.set_state(Application.reason)
    await message.answer("4/5. Почему вы хотите стать администратором?")


@dp.message(Application.reason)
async def answer_reason(message: Message, state: FSMContext):
    answer = (message.text or "").strip()
    if len(answer) < 3:
        await message.answer("Напишите немного подробнее.")
        return
    await state.update_data(reason=answer)
    await state.set_state(Application.availability)
    await message.answer("5/5. Готовы ли вы регулярно уделять время чату и следить за порядком?")


@dp.message(Application.availability)
async def answer_availability(message: Message, state: FSMContext):
    availability = (message.text or "").strip()
    if not availability:
        await message.answer("Напишите ответ текстом.")
        return

    owner_id = get_owner_id()
    if not owner_id:
        await state.clear()
        await message.answer(
            "Приём заявок пока не настроен. Владелец должен сначала открыть бота и нажать /start.",
            reply_markup=main_menu
        )
        return

    data = await state.get_data()
    with db() as conn:
        cur = conn.execute(
            """INSERT INTO applications
            (user_id, username, telegram_time, age, contact, reason, availability)
            VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                message.from_user.id,
                message.from_user.username or "",
                data["telegram_time"],
                data["age"],
                data["contact"],
                data["reason"],
                availability,
            )
        )
        app_id = cur.lastrowid

    sender = f"@{message.from_user.username}" if message.from_user.username else "не указан"
    text = (
        f"📝 Новая заявка №{app_id}\n\n"
        f"От: {sender}\n"
        f"Telegram ID: {message.from_user.id}\n"
        f"1. В Telegram: {data['telegram_time']}\n"
        f"2. Возраст: {data['age']}\n"
        f"3. Контакт: {data['contact']}\n"
        f"4. Почему хочет стать администратором: {data['reason']}\n"
        f"5. Готовность уделять время: {availability}"
    )

    try:
        await bot.send_message(owner_id, text, reply_markup=review_keyboard(app_id))
    except Exception:
        logging.exception("Could not send application to owner")
        with db() as conn:
            conn.execute("UPDATE applications SET status = 'delivery_error' WHERE id = ?", (app_id,))
        await message.answer(
            "Не удалось доставить заявку владельцу. Попробуйте позже.",
            reply_markup=main_menu
        )
    else:
        await message.answer(
            "Заявка отправлена владельцу. Повторно подать заявку можно будет после решения.",
            reply_markup=main_menu
        )
    await state.clear()


@dp.callback_query(F.data.startswith("app:"))
async def process_application(callback: CallbackQuery):
    owner_id = get_owner_id()
    if not owner_id or callback.from_user.id != owner_id:
        await callback.answer("Эта кнопка доступна только владельцу.", show_alert=True)
        return

    _, action, app_id_text = callback.data.split(":")
    app_id = int(app_id_text)
    new_status = "accepted" if action == "accept" else "rejected" if action == "reject" else None
    if not new_status:
        await callback.answer("Неизвестное действие.", show_alert=True)
        return

    with db() as conn:
        row = conn.execute(
            "SELECT user_id, status FROM applications WHERE id = ?", (app_id,)
        ).fetchone()
        if not row or row["status"] != "pending":
            await callback.answer("Заявка уже обработана или не найдена.", show_alert=True)
            return
        conn.execute(
            "UPDATE applications SET status = ? WHERE id = ?", (new_status, app_id)
        )

    decision = "принята" if new_status == "accepted" else "отклонена"
    try:
        await bot.send_message(row["user_id"], f"По вашей заявке №{app_id} принято решение: {decision}.")
    except Exception:
        logging.exception("Could not notify applicant")
    await callback.message.edit_reply_markup(reply_markup=None)
    await callback.answer(f"Заявка {decision}.")


async def main():
    init_db()
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
