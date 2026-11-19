# Telegram Admin Application Bot

Telegram bot: @tw1ndy_adminiNKChatBot

## Features
- Menu with application and owner-contact buttons
- Five-step application form
- Sends applications to the owner
- Owner-only Accept / Reject buttons
- Prevents multiple pending applications from the same Telegram account
- Stores applications and owner ID in SQLite

## Run locally
1. Install Python 3.11 or newer.
2. Install dependencies: `pip install -r requirements.txt`
3. Set the environment variable `BOT_TOKEN` to the token from BotFather.
4. Run: `python bot.py`
5. Open the bot from the owner Telegram account (@tw1ndypsyh) and press Start.

Do not put the bot token in this repository or share it in messages.

## Deploy 24/7 on Render
1. Sign in to Render and create a new **Background Worker** from this repository.
2. Build command: `pip install -r requirements.txt`
3. Start command: `python bot.py`
4. Add environment variable `BOT_TOKEN` with the token from BotFather.
5. Deploy the worker.
6. Open @tw1ndy_adminiNKChatBot from @tw1ndypsyh and press Start. This registers the owner's Telegram account for application delivery.

Important: SQLite data is stored on the worker's filesystem. For durable data across redeploys/restarts, attach a persistent disk and set `DB_PATH` to a file path on that disk. Check the current Render plan and pricing; always-on background workers may require a paid plan.
