const crypto = require('crypto');

// Generate secure random strings for JWT secrets
const generateSecret = (length = 64) => {
  return crypto.randomBytes(length).toString('hex');
};

console.log('='.repeat(60));
console.log('JWT Secret Keys Generated');
console.log('='.repeat(60));
console.log('\nCopy these to your .env file:\n');
console.log(`JWT_SECRET=${generateSecret()}`);
console.log(`JWT_REFRESH_SECRET=${generateSecret()}`);
console.log('\n' + '='.repeat(60));
console.log('⚠️  Keep these secrets secure and never commit them to version control!');
console.log('='.repeat(60));

