# LinkedIn Poster (GitHub Actions)

Every day at 08:00 UAE time this picks one of your GitHub repos, writes a LinkedIn post
with Groq, renders a code-snippet image, and sends both to your Telegram bot.

## Setup (about 10 minutes)

1. **Create a new GitHub repo** (private is recommended) and upload every file in this
   folder, including the hidden `.github` folder. Easiest: unzip, then drag the contents
   into the repo's "Add file > Upload files" page.
2. **Add secrets**: repo > Settings > Secrets and variables > Actions > New repository secret.

   | Secret name          | What it is                                                        |
   |----------------------|-------------------------------------------------------------------|
   | GROQ_API_KEY         | Your Groq API key                                                 |
   | TELEGRAM_BOT_TOKEN   | Token from @BotFather                                             |
   | TELEGRAM_CHAT_ID     | Your chat id (you already have this one)                          |
   | HCTI_USER_ID         | hcti.io User ID                                                   |
   | HCTI_API_KEY         | hcti.io API key                                                   |
   | GH_PAT (optional)    | NEW GitHub token, only needed to read your PRIVATE repos          |

   Use a brand new GitHub token. The old one was exposed in your n8n file and must be revoked.
3. Open your bot in Telegram and press **Start** once (bots cannot message you before that).
4. **Test it**: repo > Actions > "Daily LinkedIn Post" > Run workflow. Check Telegram.
5. Done. It now runs by itself every day.

## Notes
- **Time**: cron is in UTC. `0 4 * * *` = 08:00 UAE. Change it in `.github/workflows/daily.yml`.
- **Delays**: GitHub may start scheduled runs a few minutes late.
- **History** is stored in `history.json` and committed after each run, so the same idea is
  not repeated. The daily commit also keeps the repo active (GitHub pauses schedules in
  public repos with 60 days of no activity).
- **Your voice**: paste 3-5 of your real posts into `voice_examples.txt`.
- **Test locally without sending**: `GROQ_API_KEY=... node src/main.js` with `DRY_RUN=1`.
- If the image step fails, you still get the post text, and the error shows in the Actions log.
