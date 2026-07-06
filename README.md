<p align="center">
<img src="https://viperverse.tv/assets/img/viper_os_mk5_v2.png" />
</p>

# // VipOS MK V | Chat Bot + Overlay Platform
- Run `npm start` for production
- Run `npm run dev` for development

## Local URLs
- Control panel: `http://localhost:5000/control`
- Alerts overlay, including sound alerts: `http://localhost:5000/overlay/alerts`
- Stream border overlay: `http://localhost:5000/overlay/stream-border`

## Chat Commands
Copy `config/commands.example.json` to `config/commands.json` and edit the commands/actions for your stream.
The commands file is watched and reloaded while the app is running.

Chat uses Twitch EventSub WebSockets for inbound messages and the Twitch Send Chat Message API for bot replies. Authorize the bot account with:

- `user:read:chat`
- `user:write:chat`

Set `TWITCH_BOT_ACCESS_TOKEN` and `TWITCH_BOT_REFRESH_TOKEN` in `.env`. Refreshed token data is written to `config/twitch-token.json`, which should stay out of git.

## Channel Point Rewards
Channel point custom rewards and automatic reward redemptions require the broadcaster account to authorize one of:

- `channel:read:redemptions`
- `channel:manage:redemptions`

Set `TWITCH_BROADCASTER_ACCESS_TOKEN` and `TWITCH_BROADCASTER_REFRESH_TOKEN` in `.env`, or leave `CHAT_ENABLE_REDEMPTIONS=false` for chat-only mode. Refreshed broadcaster token data is written to `config/twitch-broadcaster-token.json`.

Suggested future-friendly broadcaster scopes:

```text
bits:read channel:read:redemptions channel:manage:redemptions channel:read:polls channel:manage:polls channel:read:predictions channel:manage:predictions channel:read:goals channel:read:hype_train channel:read:subscriptions channel:read:vips channel:read:ads channel:read:charity moderator:read:followers moderator:read:chatters
```

`config/commands.json` may be either the original command array or an object with:

- `commands`
- `redemptions`
- `redemptionUpdates`
- `automaticRedemptions`
- `rewardEvents`
- `chatEntries`
- `follows`
- `raids`

Reward action templates can use values like `{displayName}`, `{message}`, `{reward.title}`, `{reward.id}`, `{reward.cost}`, `{redemption.input}`, and `{automaticReward.type}`.
`sound.pickRandom` adds the picked file to the action context, so later actions can use `{sfx.src}`, `{sfx.filename}`, `{sfx.name}`, and `{sfx.text}` when the `contextKey` is `sfx`.
`context.pickRandom` picks one item from the active pool in `config/greetings.json` by default and stores it at `contextKey`, so a later action can use it in templates like `{greeting}`. It can also pick from an inline `items` list, a custom `file`, or a fixed `pool`/`theme`.

For normal channel point usage, use `redemptions`; Twitch calls this event `redemption.add` because a viewer has added a new redemption. `redemptionUpdates`, `automaticRedemptions`, and `rewardEvents` are optional advanced handler groups, and the service only subscribes to those extra EventSub topics when handlers are configured for them at startup.

Chat entry, follow, and raid interactions are configured with `chatEntries`, `follows`, and `raids`. Chat entry handlers fire once per bot session when the first chat message seen from a moderator or VIP arrives; Twitch chat messages do not expose silent joins. Follow handlers require the broadcaster token to include `moderator:read:followers`; raid handlers do not require an extra Twitch scope. The service only subscribes to follow and raid EventSub topics when handlers are configured at startup.

Chat entry templates can use `{displayName}`, `{username}`, `{entry.role}`, and `{entry.roles}`. Follow templates can use `{displayName}`, `{username}`, `{follow.followedAt}`, and broadcaster fields like `{broadcasterDisplayName}`. Raid templates can use `{displayName}`, `{username}`, `{raid.viewers}`, `{raid.fromBroadcasterName}`, and `{raid.toBroadcasterName}`.

Redemption handlers can be catch-all, or they can include a `match` object:

```json
{
  "redemptions": [
    {
      "name": "hydrate",
      "match": {
        "rewardTitle": "Hydrate"
      },
      "actions": [
        { "type": "overlay.alert", "message": "{displayName} redeemed {reward.title}" }
      ]
    },
    {
      "name": "song-request",
      "match": {
        "rewardId": "replace_with_twitch_reward_id",
        "inputContains": "http"
      },
      "actions": [
        { "type": "overlay.alert", "message": "{displayName} requested: {redemption.input}" }
      ]
    }
  ]
}
```

Supported `match` fields include `event`, `rewardId`, `rewardTitle`, `rewardType`, `status`, `userId`, `username`, `displayName`, `roles`, `inputContains`, and `inputMatches`.
Raid handlers also support `minViewers` and `maxViewers`.

Use `status` only when you intentionally want to separate queued/manual reward states like `unfulfilled`, `fulfilled`, or `canceled`.

Action types currently supported:
- `overlay.alert`
- `overlay.emit`
- `context.pickRandom`
- `sound.play`
- `sound.pickRandom`
- `obs.scene`
- `obs.source`
- `obs.mute`
- `obs.media`
- `chat.say`
- `delay`
- `log`

`sound.pickRandom` chooses from top-level `.mp3`, `.ogg`, and `.wav` files in `public/assets/sounds`; subdirectories are ignored. Edit `config/sfx-text.json` to control the overlay text for each filename.
Edit `config/greetings.json` to control the themed text pools used by `context.pickRandom`. The control panel can switch the active greeting theme, which is saved in `config/greetings-settings.json`.
