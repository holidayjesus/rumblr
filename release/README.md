# Rumblr Quick Start

Rumblr is a macOS-native IRC client.

## First Launch

1. Open Rumblr.
2. Open Options from the three-dot button in the channel header.
3. In Identity, set your primary nickname, fallback nickname, real name, and optional local avatar.
4. In Networks, edit or add a network. Libera.Chat is included as a starting profile.
5. Use Test Connection before saving a new server profile.
6. Connect from the Network card in the sidebar.

## Joining and Reading Channels

- Use /join #channel to join a channel.
- Use the channel list in the sidebar to switch buffers.
- Use Cmd+1 through Cmd+9 to jump to visible buffers.
- Use Cmd+[ and Cmd+] to move through buffers.
- Use /part to leave the current channel.

## Composer and Commands

The composer supports slash commands, multiline typing, history, and completion.

- Press Tab to complete commands, channel names, and nicknames.
- Press Up and Down to move through sent-message history.
- Press Shift+Enter for a new line.
- Type /help for the in-client command reference.
- Common commands: /join, /msg, /nick, /topic, /whois, /list, /me, /away, /clear, /search, /quiet, /id.

## Command Palette

Press Cmd+K to open the command palette. It can open windows, switch buffers, start commands, copy summaries, browse channels, and open settings without hunting through the UI.

## Message Hub

Open the Messages button in the top bar to view direct conversations and service buffers such as NickServ or ChanServ.

- Direct messages and service notices are grouped by sender.
- Clicking a popup or attention item opens the matching conversation.
- Service messages are kept minimal and readable so they do not flood the main channel view.

## Attention Center

Open the bell button to view unread buffers, mentions, and direct-message attention in one place.

- Read All clears unread attention across visible buffers.
- Muted buffers remain quiet until you unmute them.
- The native dock unread count follows the same unread state.

## Notifications

Open Options, then Notifications.

- Notification Mode controls what can alert you.
- Enable Notifications controls system-level alerts.
- Bottom Message Popup shows compact in-app alerts for DMs and mentions.
- Quiet Hours keeps attention available without interrupting you.

## Appearance

Rumblr ships with two supported themes:

- Rumblr Carbon: the default dark interface.
- Aqua Social: a clean light interface.

Older experimental theme IDs now return to Rumblr Carbon automatically.

## Tips

- Use the Channel Browser to search large IRC network channel lists.
- Use the Network Editor NickServ helper to add identify commands safely.
- Use /quiet to hide or show join, part, quit, and mode noise.
- Use the local avatar setting to customize your own profile on this device.

## Troubleshooting

- If a connection hangs, use Test Connection in the Network Editor and verify host, port, and SSL/TLS.
- If your nickname is registered, use /id <password> or add a NickServ identify command in the network profile.
- If messages seem noisy, lower Notification Mode or enable Quiet Hours.
