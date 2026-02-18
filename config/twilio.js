const twilio = require('twilio');

let twilioClient = null;

const getTwilioClient = () => {
  if (!twilioClient) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (!accountSid || !authToken) {
      throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set in environment');
    }

    twilioClient = twilio(accountSid, authToken);
  }

  return twilioClient;
};

const sendOTPViaSMS = async (mobileNumber, otp) => {
  try {
    const client = getTwilioClient();
    const verifySid = process.env.TWILIO_VERIFY_SERVICE_SID;

    if (!verifySid) {
      throw new Error('TWILIO_VERIFY_SERVICE_SID must be set in environment');
    }

    // Using Twilio Verify API (recommended for OTP)
    // This sends OTP and manages expiration automatically
    const verification = await client.verify.v2
      .services(verifySid)
      .verifications.create({
        to: `+91${mobileNumber}`, // Change country code as needed
        channel: 'sms',
      });

    return {
      success: true,
      status: verification.status,
      sid: verification.sid,
    };
  } catch (error) {
    console.error('Twilio send OTP error:', error);
    throw error;
  }
};

const verifyOTPViaSMS = async (mobileNumber, otp) => {
  try {
    const client = getTwilioClient();
    const verifySid = process.env.TWILIO_VERIFY_SERVICE_SID;

    if (!verifySid) {
      throw new Error('TWILIO_VERIFY_SERVICE_SID must be set in environment');
    }

    // Verify OTP using Twilio Verify API
    const verificationCheck = await client.verify.v2
      .services(verifySid)
      .verificationChecks.create({
        to: `+91${mobileNumber}`, // Change country code as needed
        code: otp,
      });

    return {
      success: verificationCheck.status === 'approved',
      status: verificationCheck.status,
    };
  } catch (error) {
    console.error('Twilio verify OTP error:', error);
    return {
      success: false,
      status: 'failed',
      error: error.message,
    };
  }
};

// Alternative: Send custom SMS (without Twilio Verify)
const sendCustomOTPSMS = async (mobileNumber, otp) => {
  try {
    const client = getTwilioClient();
    const fromNumber = process.env.TWILIO_PHONE_NUMBER; // Your Twilio phone number

    if (!fromNumber) {
      throw new Error('TWILIO_PHONE_NUMBER must be set in environment');
    }

    const message = await client.messages.create({
      body: `Your OTP is: ${otp}. Valid for 10 minutes.`,
      from: fromNumber,
      to: `+91${mobileNumber}`, // Change country code as needed
    });

    return {
      success: true,
      sid: message.sid,
      status: message.status,
    };
  } catch (error) {
    console.error('Twilio send custom SMS error:', error);
    throw error;
  }
};

module.exports = {
  getTwilioClient,
  sendOTPViaSMS,
  verifyOTPViaSMS,
  sendCustomOTPSMS,
};
