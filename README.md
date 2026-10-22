# LinkedIn Post Automation

Every morning this picks one of my GitHub repos, writes a LinkedIn post about it with an LLM,
renders a syntax-highlighted code image, and sends both to my Telegram bot for review.

## How it works
1. Fetches my repos and chooses the one I've posted about least recently
2. Generates a post idea and the post itself with Groq (gpt-oss-120b)
3. Picks a real code snippet from the repo and renders it as an image
4. Sends the image and text to Telegram
5. Saves history so ideas are never repeated

## Tech
Node.js, GitHub Actions (scheduled), Groq API, Telegram Bot API, hcti.io
