const { RtcTokenBuilder, RtcRole } = require('agora-token');

/**
 * Generate Agora RTC token for voice/video calls.
 * Used with react-native-agora: joinChannel(token, channelName, uid, ...)
 *
 * @param {string} channelName - Agora channel name (e.g. callId)
 * @param {number} uid - Agora uid (32-bit unsigned int, 1 to 2^32-1). Must match client joinChannel uid.
 * @param {number} expirationSeconds - Token validity in seconds from now (default 3600 = 1 hour)
 * @returns {string} RTC token
 */
function generateRtcToken(channelName, uid, expirationSeconds = 3600) {
  const appId = process.env.AGORA_APP_ID;
  const appCertificate = process.env.AGORA_APP_CERTIFICATE;

  if (!appId || !appCertificate) {
    throw new Error('AGORA_APP_ID and AGORA_APP_CERTIFICATE must be set in environment');
  }

  return RtcTokenBuilder.buildTokenWithUid(
    appId,
    appCertificate,
    channelName,
    Number(uid),
    RtcRole.PUBLISHER,
    expirationSeconds,
    expirationSeconds
  );
}

module.exports = { generateRtcToken };
