# Gotogram

![Test](https://github.com/jehy/gotogram/workflows/Test/badge.svg)
[![Known Vulnerabilities](https://snyk.io/test/github/jehy/gotogram/badge.svg)](https://snyk.io/test/github/jehy/gotogram)

Simple app to sync messages from gotify to telegram

## Install with docker compose

```yml
version: '3.9'

services:
  gotogram:
    image: ghcr.io/jehy/gotogram/gotogram:latest
    environment:
      GOTIFY_WS_URL: wss://gotify.yourdomain.com/stream
      GOTIFY_TOKEN: XXXXX
      TELEGRAM_BOT_TOKEN: XXX:YYY
      TELEGRAM_CHAT_ID: xxx
```

Set `TELEGRAM_BOT_TOKEN` value to token from [@BotFather](https://t.me/BotFather)

## FAQ

Why not gotify plugin?
* I don't like the idea of recompiling plugun every time I update gotify
* Sometimes you need to put telegram client on another server from gotify
* I like putting different tasks on different docker containers
* Separate container should work fine without updates as long as gotify does not change it's websocket API

## See also

* https://github.com/anhbh310/gotify2telegram - seems abandoned, and I could not managed forks to work
* https://github.com/0xpetersatoshi/gotify-to-telegram - seems abandoned