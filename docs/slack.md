# Slack

The office can be reached from Slack without exposing your computer to the internet: it opens the connection to Slack itself (Socket Mode).

1. At [api.slack.com/apps](https://api.slack.com/apps) choose **Create New App → From a manifest**, pick your workspace, and paste:

   ```yaml
   display_information:
     name: Deskforce
   features:
     bot_user:
       display_name: Deskforce
       always_online: true
     app_home:
       messages_tab_enabled: true
       messages_tab_read_only_enabled: false
   oauth_config:
     scopes:
       bot:
         - chat:write
         - im:history
         - app_mentions:read
   settings:
     event_subscriptions:
       bot_events:
         - message.im
         - app_mention
     socket_mode_enabled: true
   ```

2. Under **Basic Information → App-Level Tokens**, create a token with the `connections:write` scope. It starts with `xapp-`.
3. Under **Install App**, install it to the workspace and copy the **Bot User OAuth Token**. It starts with `xoxb-`.
4. In the office, open Settings → Slack and paste both tokens. The status line shows "Connected".
5. Send the app a direct message. It answers with your Slack user ID; add that ID to the allowed users in Settings. From then on it takes your instructions.

Only the listed users can give instructions; everyone else is told so and nothing happens. In a channel, mention the app (`@Deskforce status`) after inviting it.

What you can say is free text: "build me a landing page for the bakery", "how are things?", "approve the plan", "tell them to use blue instead", "cancel that". The employee who answers works through the same actions as the buttons in the app, and the office posts to your conversation when a plan or a question is waiting, a report is ready, or a task failed.

The same conversation is available to scripts on this computer:

```bash
curl -X POST http://localhost:3000/api/chat -H 'Content-Type: application/json' -d '{"text":"how are things?"}'
```

Chatting uses the answering employee's model and counts towards the monthly spending.
