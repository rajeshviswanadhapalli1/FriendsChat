const express = require('express');
const router = express.Router();
const User = require('../models/User');
const OTP = require('../models/OTP');
const { generateOTP } = require('../utils/otpGenerator');
const { generateAccessToken, generateRefreshToken, verifyRefreshToken } = require('../utils/jwt');
const { authenticate } = require('../middleware/auth');
const { sendOTPViaSMS, verifyOTPViaSMS } = require('../config/twilio');

// Send OTP to mobile number (via Twilio SMS)
router.post('/send-otp', async (req, res) => {
  try {
    const { mobileNumber } = req.body;

    if (!mobileNumber || !/^\d{10}$/.test(mobileNumber)) {
      return res.status(400).json({
        success: false,
        message: 'Valid 10-digit mobile number is required',
      });
    }

    // TEMPORARY: Using fixed OTP (468026) for all users
    // TODO: Uncomment Twilio code below when ready to use Twilio in production
    // BACKUP: Twilio code kept intact below for future use
    
    // Send OTP via Twilio Verify API (BACKUP - commented for now)
    // const result = await sendOTPViaSMS(mobileNumber);
    // if (result.success) {
    //   res.status(200).json({
    //     success: true,
    //     message: 'OTP sent successfully via SMS',
    //   });
    // } else {
    //   res.status(500).json({
    //     success: false,
    //     message: 'Failed to send OTP',
    //   });
    // }

    // For now, just return success (using fixed OTP: 468026)
    res.status(200).json({
      success: true,
      message: 'OTP sent successfully. Use OTP: 468026',
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

// Verify OTP and login/register (via Twilio Verify API)
router.post('/verify-otp', async (req, res) => {
  try {
    const { mobileNumber, otp } = req.body;

    if (!mobileNumber || !otp) {
      return res.status(400).json({
        success: false,
        message: 'Mobile number and OTP are required',
      });
    }

    // TEMPORARY: Fixed OTP for all users (468026)
    // TODO: Remove this and use Twilio verification in production
    const FIXED_OTP = '468026';
    let verificationResult = { success: false };

    if (otp === FIXED_OTP) {
      // Accept fixed OTP
      verificationResult = { success: true, status: 'approved' };
      console.log(`Fixed OTP accepted for mobile: ${mobileNumber}`);
    } else {
      // Fallback to Twilio Verify API (backup - keeping Twilio code intact)
      verificationResult = await verifyOTPViaSMS(mobileNumber, otp);
    }

    if (!verificationResult.success) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired OTP',
      });
    }

    // Find or create user
    let user = await User.findOne({ mobileNumber });

    if (!user) {
      // Create new user
      user = await User.create({
        mobileNumber,
        name: `User ${mobileNumber}`,
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
          age: user.age,
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

// Update username
router.put('/update-username', authenticate, async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Username is required and must be a non-empty string',
      });
    }

    if (name.trim().length > 100) {
      return res.status(400).json({
        success: false,
        message: 'Username must be less than 100 characters',
      });
    }

    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    user.name = name.trim();
    await user.save();

    res.status(200).json({
      success: true,
      message: 'Username updated successfully',
      data: {
        user: {
          _id: user._id,
          mobileNumber: user.mobileNumber,
          name: user.name,
          age: user.age,
          profilePicture: user.profilePicture,
        },
      },
    });
  } catch (error) {
    console.error('Error updating username:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating username',
      error: error.message,
    });
  }
});

// Update age
router.put('/update-age', authenticate, async (req, res) => {
  try {
    const { age } = req.body;

    if (age === undefined || age === null) {
      return res.status(400).json({
        success: false,
        message: 'Age is required',
      });
    }

    const ageNumber = parseInt(age, 10);

    if (isNaN(ageNumber) || ageNumber < 0 || ageNumber > 150) {
      return res.status(400).json({
        success: false,
        message: 'Age must be a valid number between 0 and 150',
      });
    }

    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    user.age = ageNumber;
    await user.save();

    res.status(200).json({
      success: true,
      message: 'Age updated successfully',
      data: {
        user: {
          _id: user._id,
          mobileNumber: user.mobileNumber,
          name: user.name,
          age: user.age,
          profilePicture: user.profilePicture,
        },
      },
    });
  } catch (error) {
    console.error('Error updating age:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating age',
      error: error.message,
    });
  }
});

module.exports = router;

