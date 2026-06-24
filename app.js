const { App, LogLevel } = require('@slack/bolt');

// ── Setup ─────────────────────────────────────────────────────────────────────
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  logLevel: LogLevel.DEBUG, // 👈 change to LogLevel.INFO (or remove) once you're done testing
});

// ⏱️ Timing settings — change these to whatever your team wants
const NUDGE_AFTER_HOURS    = 24; // remind the HM after this long
const ESCALATE_AFTER_HOURS = 48; // tell the TA if the HM STILL hasn't acted

// List of TA team Slack User IDs (set in environment variables)
const TA_USER_IDS = process.env.TA_USER_IDS
  ? process.env.TA_USER_IDS.split(',').map(id => id.trim())
  : [];

console.log('👥 TA User IDs loaded:', TA_USER_IDS);

// Remember which messages we've already acted on, so a post AND its later edit
// don't both trigger the bot. (This resets if the bot restarts — that's fine.)
const handledMessages = new Set();

// ── Helper: start (or RESTART) a nudge cycle for the HM ───────────────────────
// Sends the HM a button, schedules a reminder to the HM, AND schedules an
// escalation to the TA in case the HM never engages. All of these get cancelled
// the moment the HM taps "Feedback Given". originalLink points back to the TA's
// original message so the HM can jump straight to the CV.
async function startNudgeCycle({ client, channelId, candidateName, taName, taUserId, originalLink, introText }) {

  const now = Math.floor(Date.now() / 1000);
  const scheduledMessages = []; // we collect {channel, id} so we can cancel them later

  // A clickable link back to the original message (blank if we couldn't get one)
  const linkLine = originalLink ? `\n\n📄 <${originalLink}|View the original message & CV>` : '';

  // 1) Remind the HM after NUDGE_AFTER_HOURS
  const nudge = await client.chat.scheduleMessage({
    channel: channelId,
    post_at: now + NUDGE_AFTER_HOURS * 60 * 60,
    text: `⏰ *Friendly reminder!*\n\n*${taName}* from the TA team is still waiting for your feedback on *${candidateName}*'s CV.\n\nPlease share your thoughts when you get a chance! 🙏${linkLine}`,
  });
  scheduledMessages.push({ channel: channelId, id: nudge.scheduled_message_id });
  console.log('⏰ HM reminder scheduled, ID:', nudge.scheduled_message_id);

  // 2) Escalate to the TA after ESCALATE_AFTER_HOURS if the HM still hasn't acted
  try {
    const taDm = await client.conversations.open({ users: taUserId });
    const escalation = await client.chat.scheduleMessage({
      channel: taDm.channel.id,
      post_at: now + ESCALATE_AFTER_HOURS * 60 * 60,
      text: `🚨 *Heads up!*\n\nThe Hiring Manager still hasn't acted on *${candidateName}*'s CV after ${ESCALATE_AFTER_HOURS} hours. You may want to follow up with them directly.${linkLine}`,
    });
    scheduledMessages.push({ channel: taDm.channel.id, id: escalation.scheduled_message_id });
    console.log('🚨 TA escalation scheduled, ID:', escalation.scheduled_message_id);
  } catch (err) {
    console.error('⚠️ Could not schedule TA escalation:', err.message);
  }

  // Pack everything we need (to cancel + confirm later) into the button
  const buttonPayload = JSON.stringify({
    scheduled_messages: scheduledMessages,
    hm_channel_id:      channelId,
    candidate_name:     candidateName,
    ta_user_id:         taUserId,
    ta_name:            taName,
    original_link:      originalLink,
  });

  // The intro line (custom one for re-flags, otherwise the normal first-time one)
  const baseIntro = introText
    || `👋 Hi! *${taName}* from the TA team has shared *${candidateName}*'s CV with you for review.\n\nPlease share your feedback within *${NUDGE_AFTER_HOURS} hours*. Once done, just tap the button below so we know! ✅`;
  const intro = baseIntro + linkLine;

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

  // Grab the channel the message was posted in BEFORE we unwrap edits
  const sourceChannel = message.channel;

  // If this is an EDITED message, the new text lives in message.message — unwrap it
  if (message.subtype === 'message_changed') {
    message = message.message;
  }

  console.log('📨 Message received from user:', message.user, '| text:', message.text);

  // ✋ Ignore real bot messages and any subtype we don't handle
  if (message.bot_id || message.subtype) {
    console.log('⛔ Ignored: bot message or unsupported subtype');
    return;
  }

  // ✋ Don't act on the same message twice (e.g. a post AND its later edit)
  if (handledMessages.has(message.ts)) {
    console.log('⛔ Ignored: already handled this message');
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

  // Remember this message so a later edit of it won't trigger the bot again
  handledMessages.add(message.ts);

  const hmUserId  = mentionMatch[1];
  const taUserId  = message.user;

  try {
    // Get a permalink back to the TA's original message (so the HM can find the CV)
    let originalLink = null;
    try {
      const perma = await client.chat.getPermalink({ channel: sourceChannel, message_ts: message.ts });
      originalLink = perma.permalink;
      console.log('🔗 Original message link:', originalLink);
    } catch (err) {
      console.log('⚠️ Could not get permalink:', err.message);
    }

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

    // Start the nudge cycle (button + HM reminder + TA escalation)
    await startNudgeCycle({ client, channelId, candidateName, taName, taUserId, originalLink });

  } catch (err) {
    console.error('❌ Error handling CV message:', err);
  }
});

// ── Handle "Feedback Given" Button Click (from the HM) ────────────────────────
app.action('feedback_given', async ({ ack, body, client, action }) => {
  await ack();

  const { scheduled_messages, hm_channel_id, candidate_name, ta_user_id, ta_name, original_link } =
    JSON.parse(action.value);

  // Cancel ALL scheduled messages (HM reminder + TA escalation)
  for (const m of scheduled_messages || []) {
    try {
      await client.chat.deleteScheduledMessage({ channel: m.channel, scheduled_message_id: m.id });
      console.log('🗑️ Cancelled scheduled message:', m.id);
    } catch (err) {
      console.log('⚠️ Could not cancel', m.id, '(may have already sent):', err.message);
    }
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

  // Ask the TA to confirm they ACTUALLY received the feedback
  const taCheckPayload = JSON.stringify({
    candidate_name,
    hm_channel_id,
    ta_name,
    ta_user_id,
    original_link,
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

  const { candidate_name, hm_channel_id, ta_name, ta_user_id, original_link } = JSON.parse(action.value);

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

  // Re-open the loop: fresh reminder + button + NEW reminder/escalation schedule
  try {
    const reflagText = `🚩 *Quick correction!*\n\n*${ta_name}* from the TA team hasn't received your feedback on *${candidate_name}*'s CV yet. Please share it, then tap the button below once it's *truly* done. 🙏`;

    await startNudgeCycle({
      client,
      channelId:     hm_channel_id,
      candidateName: candidate_name,
      taName:        ta_name,
      taUserId:      ta_user_id,
      originalLink:  original_link,
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
