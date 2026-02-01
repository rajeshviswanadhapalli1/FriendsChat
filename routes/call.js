const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { generateRtcToken } = require('../utils/agoraToken');

/**
 * GET /api/call/config
 * Returns Agora App ID and optional temp token (for dev). Use in frontend agora config.
 */
router.get('/config', authenticate, (req, res) => {
  try {
    const appId = process.env.AGORA_APP_ID || '';
    const token = process.env.AGORA_TEMP_TOKEN || null;
    res.status(200).json({
      success: true,
      data: {
        appId,
        token,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/call/token
 * Query: channelName (required), uid (required, 1 to 2^32-1)
 * Returns Agora RTC token for react-native-agora joinChannel.
 */
router.get('/token', authenticate, (req, res) => {
  try {
    const { channelName, uid } = req.query;

    if (!channelName || !uid) {
      return res.status(400).json({
        success: false,
        message: 'channelName and uid are required',
      });
    }

    const uidNum = parseInt(uid, 10);
    if (isNaN(uidNum) || uidNum < 1 || uidNum > 4294967295) {
      return res.status(400).json({
        success: false,
        message: 'uid must be a number between 1 and 4294967295',
      });
    }

    const expirationSeconds = parseInt(req.query.expiration, 10) || 3600;
    const token = generateRtcToken(channelName, uidNum, expirationSeconds);

    res.status(200).json({
      success: true,
      data: {
        token,
        channelName,
        uid: uidNum,
        appId: process.env.AGORA_APP_ID,
        expirationSeconds,
      },
    });
  } catch (error) {
    console.error('Error generating Agora token:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Error generating token',
    });
  }
});

module.exports = router;
