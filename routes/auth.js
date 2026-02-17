const express = require('express');
const router = express.Router();
const User = require('../models/User');
const OTP = require('../models/OTP');
const { generateOTP } = require('../utils/otpGenerator');
const { generateAccessToken, generateRefreshToken, verifyRefreshToken } = require('../utils/jwt');
const { authenticate } = require('../middleware/auth');

// Static OTP for all users
const STATIC_OTP = '468026';

// Send OTP to mobile number (static OTP)
router.post('/send-otp', async (req, res) => {
  try {
    const { mobileNumber } = req.body;

    if (!mobileNumber || !/^\d{10}$/.test(mobileNumber)) {
      return res.status(400).json({
        success: false,
        message: 'Valid 10-digit mobile number is required',
      });
    }

    // Return success with static OTP (for development/testing)
    console.log(`OTP for ${mobileNumber}: ${STATIC_OTP}`);
    
    res.status(200).json({
      success: true,
      message: 'OTP sent successfully',
    });
  } catch (error) {
    console.error('Error sending OTP:', error);
    res.status(500).json({
      success: false,
      message: 'Error sending OTP',
      error: error.message,
    });
  }
});

// Verify OTP and login/register (static OTP)
router.post('/verify-otp', async (req, res) => {
  try {
    const { mobileNumber, otp } = req.body;

    if (!mobileNumber || !otp) {
      return res.status(400).json({
        success: false,
        message: 'Mobile number and OTP are required',
      });
    }

    // Verify OTP against static OTP
    if (otp !== STATIC_OTP) {
      return res.status(400).json({
        success: false,
        message: 'Invalid OTP',
      });
    }

    // Find or create user
    let user = await User.findOne({ mobileNumber });

    if (!user) {
      // Create new user
      user = await User.create({
        mobileNumber,
        name: `${mobileNumber}`,
      });
    }

    // Generate tokens
    const accessToken = generateAccessToken(user._id);
    const refreshToken = generateRefreshToken(user._id);

    // Save refresh token to user
    user.refreshToken = refreshToken;
    await user.save();

    res.status(200).json({
      success: true,
      message: user.isNew ? 'User registered and logged in' : 'Login successful',
      data: {
        user: {
          _id: user._id,
          mobileNumber: user.mobileNumber,
          name: user.name,
          profilePicture: user.profilePicture,
        },
        accessToken,
        refreshToken,
      },
    });
  } catch (error) {
    console.error('Error verifying OTP:', error);
    res.status(500).json({
      success: false,
      message: 'Error verifying OTP',
      error: error.message,
    });
  }
});

// Refresh access token
router.post('/refresh-token', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({
        success: false,
        message: 'Refresh token is required',
      });
    }

    const decoded = verifyRefreshToken(refreshToken);

    if (!decoded) {
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired refresh token',
      });
    }

    const user = await User.findById(decoded.userId);

    if (!user || user.refreshToken !== refreshToken) {
      return res.status(401).json({
        success: false,
        message: 'Invalid refresh token',
      });
    }

    // Generate new access token
    const newAccessToken = generateAccessToken(user._id);

    res.status(200).json({
      success: true,
      data: {
        accessToken: newAccessToken,
      },
    });
  } catch (error) {
    console.error('Error refreshing token:', error);
    res.status(500).json({
      success: false,
      message: 'Error refreshing token',
      error: error.message,
    });
  }
});

// Logout
router.post('/logout', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.userId);

    if (user) {
      user.refreshToken = null;
      await user.save();
    }

    res.status(200).json({
      success: true,
      message: 'Logout successful',
    });
  } catch (error) {
    console.error('Error logging out:', error);
    res.status(500).json({
      success: false,
      message: 'Error logging out',
      error: error.message,
    });
  }
});

// Save FCM token for push notifications
router.post('/fcm-token', authenticate, async (req, res) => {
  try {
    const { fcmToken } = req.body;

    if (!fcmToken || typeof fcmToken !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'fcmToken is required and must be a string',
      });
    }

    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    user.fcmToken = fcmToken.trim() || null;
    await user.save();

    console.log('FCM: token saved', {
      userId: String(req.userId),
      tokenPrefix: user.fcmToken ? user.fcmToken.slice(0, 16) + '...' : null,
    });

    res.status(200).json({
      success: true,
      message: 'FCM token saved successfully',
    });
  } catch (error) {
    console.error('Error saving FCM token:', error);
    res.status(500).json({
      success: false,
      message: 'Error saving FCM token',
      error: error.message,
    });
  }
});

// Get current user profile
router.get('/me', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-refreshToken');

    res.status(200).json({
      success: true,
      data: {
        user,
      },
    });
  } catch (error) {
    console.error('Error fetching user profile:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching user profile',
      error: error.message,
    });
  }
});

module.exports = router;

