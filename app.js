const { App, LogLevel } = require('@slack/bolt');

// ── Setup ─────────────────────────────────────────────────────────────────────
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  logLevel: LogLevel.DEBUG, // 👈 you can change to LogLevel.INFO (or remove this line) once you're done testing
});

// List of TA team Slack User IDs (set in environment variables)
const TA_USER_IDS = process.env.TA_USER_IDS
  ? process.env.TA_USER_IDS.split(',').map(id => id.trim())
  : [];

console.log('👥 TA User IDs loaded:', TA_USER_IDS);

// ── Helper: start (or RESTART) a nudge cycle for the HM ───────────────────────
// This sends the HM a DM with a "Feedback Given" button AND schedules a 24h nudge.
// We made it a reusable function so we can call it the first time a CV is shared,
// AND again later if the TA says feedback wasn't really received.
async function startNudgeCycle({ client, channelId, candidateName, taName, taUserId, introText }) {

  // Schedule a nudge DM to the HM exactly 24 hours from now
  const nudgeTime = Math.floor(Date.now() / 1000) + 24 * 60 * 60;

  const scheduled = await client.chat.scheduleMessage({
    channel: channelId,
    post_at: nudgeTime,
    text: `⏰ *Friendly reminder!*\n\n*${taName}* from the TA team is still waiting for your feedback on *${candidateName}*'s CV.\n\nPlease share your thoughts when you get a chance! 🙏`,
  });

  console.log('⏰ Nudge scheduled for 24hrs later, ID:', scheduled.scheduled_message_id);

  // Pack all info into the button so we can cancel the nudge if HM responds
  const buttonPayload = JSON.stringify({
    scheduled_message_id: scheduled.scheduled_message_id,
    hm_channel_id:        channelId,
    candidate_name:       candidateName,
    ta_user_id:           taUserId,
    ta_name:              taName,
  });

  // The intro line. Uses a custom one if provided (e.g. the "re-flag" message),
  // otherwise the normal first-time message.
  const intro = introText
    || `👋 Hi! *${taName}* from the TA team has shared *${candidateName}*'s CV with you for review.\n\nPlease share your feedback within *24 hours*. Once done, just tap the button below so we know! ✅`;

  // Send the HM a DM with a "Feedback Given" button
  await client.chat.postMessage({
    channel: channelId,
    text: intro,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: intro },
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

  console.log('✅ DM sent to HM successfully!');
}

// ── Watch ANY channel the bot is in for TA messages ──────────────────────────
app.message(async ({ message, client }) => {

  console.log('📨 Message received from user:', message.user, '| text:', message.text);

  // ✋ Ignore bot messages
  if (message.bot_id || message.subtype) {
    console.log('⛔ Ignored: bot message or subtype');
    return;
  }

  // ✋ Ignore if sender is not from the TA team
  if (!TA_USER_IDS.includes(message.user)) {
    console.log(`⛔ Ignored: user ${message.user} not in TA list [${TA_USER_IDS.join(', ')}]`);
    return;
  }

  // ✋ Ignore if no HM is mentioned (no @someone in the message)
  const mentionMatch = message.text && message.text.match(/<@([A-Z0-9]+)>/);
  if (!mentionMatch) {
    console.log('⛔ Ignored: no @mention found in message');
    return;
  }

  console.log('✅ Valid TA message! HM user ID:', mentionMatch[1]);

  const hmUserId  = mentionMatch[1];
  const taUserId  = message.user;

  try {
    // Get TA's real name to personalise the HM's message
    const taInfo = await client.users.info({ user: taUserId });
    const taName = taInfo.user.real_name || taInfo.user.name || 'TA Team';

    // Try to pull candidate name from message (looks for "for [Name]")
    const candidateMatch = message.text.match(/\bfor\s+([A-Z][a-zA-Z\s]+?)(?:\s*$|[.,])/);
    const candidateName  = candidateMatch ? candidateMatch[1].trim() : 'the candidate';

    console.log('👤 Candidate name detected:', candidateName);

    // Open a DM between the bot and the HM
    const dmChannel = await client.conversations.open({ users: hmUserId });
    const channelId = dmChannel.channel.id;

    console.log('💬 Opened DM with HM, channel:', channelId);

    // Start the nudge cycle (sends button + schedules 24h reminder)
    await startNudgeCycle({ client, channelId, candidateName, taName, taUserId });

  } catch (err) {
    console.error('❌ Error handling CV message:', err);
  }
});

// ── Handle "Feedback Given" Button Click (from the HM) ────────────────────────
app.action('feedback_given', async ({ ack, body, client, action }) => {
  await ack();

  const { scheduled_message_id, hm_channel_id, candidate_name, ta_user_id, ta_name } =
    JSON.parse(action.value);

  // Cancel the scheduled nudge
  try {
    await client.chat.deleteScheduledMessage({
      channel: hm_channel_id,
      scheduled_message_id: scheduled_message_id,
    });
    console.log('🗑️ Scheduled nudge cancelled');
  } catch (err) {
    console.log('⚠️ Could not cancel scheduled message (may have already sent):', err.message);
  }

  // Update the HM's DM to confirm
  await client.chat.update({
    channel: body.container.channel_id,
    ts: body.container.message_ts,
    text: `✅ Got it! Feedback marked as given for *${candidate_name}*. Thanks!`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `✅ Got it! Feedback marked as given for *${candidate_name}*. Thanks!` },
      },
    ],
  });

  // 🔎 NEW: Instead of blindly trusting the click, ask the TA to confirm.
  const taCheckPayload = JSON.stringify({
    candidate_name,
    hm_channel_id,
    ta_name,
    ta_user_id,
  });

  try {
    const taDm = await client.conversations.open({ users: ta_user_id });
    await client.chat.postMessage({
      channel: taDm.channel.id,
      text: `🤔 The Hiring Manager just marked feedback as *given* for *${candidate_name}*'s CV. Did you actually receive it?`,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `🤔 The Hiring Manager just marked feedback as *given* for *${candidate_name}*'s CV.\n\nDid you actually receive it?` },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: '✅  Yes, got it' },
              style: 'primary',
              action_id: 'ta_confirmed',
              value: taCheckPayload,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: '❌  No, not yet' },
              style: 'danger',
              action_id: 'ta_denied',
              value: taCheckPayload,
            },
          ],
        },
      ],
    });
  } catch (err) {
    console.error('❌ Could not ask TA to confirm:', err);
  }

  console.log(`✅ Feedback marked given for "${candidate_name}" — awaiting TA confirmation`);
});

// ── TA clicks "Yes, got it" → all done ────────────────────────────────────────
app.action('ta_confirmed', async ({ ack, body, client, action }) => {
  await ack();

  const { candidate_name } = JSON.parse(action.value);

  await client.chat.update({
    channel: body.container.channel_id,
    ts: body.container.message_ts,
    text: `🎉 Great! Feedback on *${candidate_name}*'s CV is confirmed. All done!`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `🎉 Great! Feedback on *${candidate_name}*'s CV is confirmed. All done!` },
      },
    ],
  });

  console.log(`✅ TA confirmed feedback for "${candidate_name}"`);
});

// ── TA clicks "No, not yet" → RE-FLAG the HM and restart the cycle ─────────────
app.action('ta_denied', async ({ ack, body, client, action }) => {
  await ack();

  const { candidate_name, hm_channel_id, ta_name, ta_user_id } = JSON.parse(action.value);

  // Update the TA's message so they know we're acting on it
  await client.chat.update({
    channel: body.container.channel_id,
    ts: body.container.message_ts,
    text: `🚩 Thanks for flagging. I'll nudge the Hiring Manager again about *${candidate_name}*'s CV.`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `🚩 Thanks for flagging. I'll nudge the Hiring Manager again about *${candidate_name}*'s CV.` },
      },
    ],
  });

  // Re-open the loop: send the HM a fresh reminder + button and schedule a NEW nudge
  try {
    const reflagText = `🚩 *Quick correction!*\n\n*${ta_name}* from the TA team hasn't received your feedback on *${candidate_name}*'s CV yet. Please share it, then tap the button below once it's *truly* done. 🙏`;

    await startNudgeCycle({
      client,
      channelId:     hm_channel_id,
      candidateName: candidate_name,
      taName:        ta_name,
      taUserId:      ta_user_id,
      introText:     reflagText,
    });
  } catch (err) {
    console.error('❌ Could not re-nudge HM:', err);
  }

  console.log(`🚩 TA denied feedback for "${candidate_name}" — HM re-nudged`);
});

// ── Start ─────────────────────────────────────────────────────────────────────
(async () => {
  await app.start();
  console.log('⚡️ CV Nudge Bot is running!');
})();
