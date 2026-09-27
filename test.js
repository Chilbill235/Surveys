const crypto = require('crypto');

const secret = 'tEGmITfaEKW6fxMyp4X9eZSfaBgMTxrw';
const url = 'https://revu-gamma.vercel.app/api/payments/nowpayments/ipn';

// Payload matching the database record
const payload = {
  actually_paid: 10,
  order_id: '3',
  outcome_amount: 10,
  outcome_currency: 'MATIC',
  pay_amount: 10,
  pay_currency: 'MATIC',
  payment_id: 5000000000,
  payment_status: 'finished',
  price_amount: 10,
  price_currency: 'USD'
};

const rawBody = JSON.stringify(payload);

const signature = crypto
  .createHmac('sha512', secret)
  .update(rawBody)
  .digest('hex');

console.log('Sending Signature:', signature);

fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-nowpayments-sig': signature
  },
  body: rawBody
})
  .then(async (res) => {
    console.log('Status Code:', res.status);
    const text = await res.text();
    console.log('Response Body:', text || '(Empty Response Body)');
  })
  .catch((err) => console.error('Fetch error:', err));