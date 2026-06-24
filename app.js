const { App } = require('@slack/bolt');

// ── Setup ─────────────────────────────────────────────────────────────────────
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

// List of TA team Slack User IDs (set in environment variables)
const TA_USER_IDS = process.env.TA_USER_IDS
  ? process.env.TA_USER_IDS.split(',').map(id => id.trim())
  : [];

// ── Watch ANY channel the bot is in for TA messages ──────────────────────────
app.message(async ({ message, client }) => {

  // ✋ Ignore bot messages
  if (message.bot_id || message.subtype) return;

  // ✋ Ignore if sender is not from the TA team
  if (!TA_USER_IDS.includes(message.user)) return;

  // ✋ Ignore if no HM is mentioned (no @someone in the message)
  const mentionMatch = message.text && message.text.match(/<@([A-Z0-9]+)>/);
  if (!mentionMatch) return;

  const hmUserId  = mentionMatch[1];
  const taUserId  = message.user;

  try {
    // Get TA's real name to personalise the HM's message
    const taInfo = await client.users.info({ user: taUserId });
    const taName = taInfo.user.real_name || taInfo.user.name || 'TA Team';

    // Try to pull candidate name from message (looks for "for [Name]")
    const candidateMatch = message.text.match(/\bfor\s+([A-Z][a-zA-Z\s]+?)(?:\s*$|[.,])/);
    const candidateName  = candidateMatch ? candidateMatch[1].trim() : 'the candidate';

    // Open a DM between the bot and the HM
    const dmChannel = await client.conversations.open({ users: hmUserId });
    const channelId = dmChannel.channel.id;

    // Schedule a nudge DM to the HM exactly 24 hours from now
    // (Slack holds this timer — no database needed!)
    const nudgeTime = Math.floor(Date.now() / 1000) + 24 * 60 * 60;

    const scheduled = await client.chat.scheduleMessage({
      channel: channelId,
      post_at: nudgeTime,
      text: `⏰ *Friendly reminder!*\n\n*${taName}* from the TA team is still waiting for your feedback on *${candidateName}*'s CV.\n\nPlease share your thoughts when you get a chance! 🙏`,
    });

    // Pack all info into the button so we can cancel the nudge if HM responds
    const buttonPayload = JSON.stringify({
      scheduled_message_id: scheduled.scheduled_message_id,
      hm_channel_id:        channelId,
      candidate_name:       candidateName,
      ta_user_id:           taUserId,
      ta_name:              taName,
    });

    // Send the HM a DM immediately with a "Feedback Given" button
    await client.chat.postMessage({
      channel: channelId,
      text: `👋 Hi! *${taName}* from the TA team has shared *${candidateName}*'s CV with you for review.\n\nPlease share your feedback within *24 hours*. Once done, just tap the button below so we know! ✅`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `👋 Hi! *${taName}* from the TA team has shared *${candidateName}*'s CV with you for review.\n\nPlease share your feedback within *24 hours*. Once done, tap the button below so we know!`,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: '✅  Feedback Given' },
              style: 'primary',
              action_id: 'feedback_given',
              value: buttonPayload,
            },
          ],
        },
      ],
    });

    console.log(`[Bot] Tracked CV for "${candidateName}" — HM: ${hmUserId}`);

  } catch (err) {
    console.error('[Bot] Error handling CV message:', err);
  }
});

// ── Handle "Feedback Given" Button Click ──────────────────────────────────────
app.action('feedback_given', async ({ ack, body, client, action }) => {
  await ack(); // Acknowledge button click immediately

  const { scheduled_message_id, hm_channel_id, candidate_name, ta_user_id, ta_name } =
    JSON.parse(action.value);

  // Cancel the scheduled nudge — HM already responded!
  try {
    await client.chat.deleteScheduledMessage({
      channel: hm_channel_id,
      scheduled_message_id: scheduled_message_id,
    });
  } catch (err) {
    // This is fine — nudge may have already fired (past 24hrs)
    console.log('[Bot] Scheduled message already sent or not found — OK.');
  }

  // Update the bot's DM to HM to confirm
  await client.chat.update({
    channel: body.container.channel_id,
    ts: body.container.message_ts,
    text: `✅ Got it! Feedback marked as given for *${candidate_name}*. Thanks!`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `✅ Got it! Feedback marked as given for *${candidate_name}*. Thanks!`,
        },
      },
    ],
  });

  // Notify the TA that feedback has been given
  try {
    const taDm = await client.conversations.open({ users: ta_user_id });
    await client.chat.postMessage({
      channel: taDm.channel.id,
      text: `🎉 Great news! The Hiring Manager has given feedback on *${candidate_name}*'s CV!`,
    });
  } catch (err) {
    console.error('[Bot] Could not notify TA:', err);
  }

  console.log(`[Bot] Feedback received for "${candidate_name}" — nudge cancelled.`);
});

// ── Start ─────────────────────────────────────────────────────────────────────
(async () => {
  await app.start();
  console.log('⚡️ CV Nudge Bot is running!');
})();
