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

Action types currently supported:
- `overlay.alert`
- `overlay.emit`
- `sound.play`
- `obs.scene`
- `obs.source`
- `obs.mute`
- `obs.media`
<!-- - `chat.say` -->
- `delay`
