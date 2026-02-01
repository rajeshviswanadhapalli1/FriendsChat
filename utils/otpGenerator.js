// Simple OTP generator (6 digits)
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// Alternative: Using otp-generator package if installed
// const otpGenerator = require('otp-generator');
// const generateOTP = () => {
//   return otpGenerator.generate(6, { 
//     upperCaseAlphabets: false, 
//     lowerCaseAlphabets: false, 
//     specialChars: false 
//   });
// };

module.exports = { generateOTP };

