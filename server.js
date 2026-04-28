import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:5173',
  'http://localhost:4173',
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.some(o => origin.startsWith(o))) cb(null, true);
    else cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

app.get('/health', (_, res) => res.json({ status: 'ok', app: 'Vyrra Fitness' }));

// CREATE CHECKOUT SESSION — 7-day free trial
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { email } = req.body;
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: email || undefined,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Vyrra Fitness',
            description: '7-day free trial, then $25/month — workouts, nutrition, challenges & more',
          },
          unit_amount: 2500,
          recurring: { interval: 'month' },
        },
        quantity: 1,
      }],
      success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/`,
      subscription_data: {
        trial_period_days: 7,
        metadata: { app: 'vyrra-fitness' },
      },
    });
    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// VERIFY SESSION
app.get('/verify-session/:sessionId', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.sessionId, {
      expand: ['subscription', 'customer'],
    });
    const isTrialing = session.subscription?.status === 'trialing';
    const isPaid = session.payment_status === 'paid';
    if (isPaid || isTrialing) {
      res.json({
        success: true,
        email: session.customer_details?.email,
        customerId: session.customer,
        subscriptionId: session.subscription?.id,
        status: session.subscription?.status,
        trialing: isTrialing,
        trialEnd: session.subscription?.trial_end,
      });
    } else {
      res.json({ success: false });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CHECK SUBSCRIPTION
app.post('/check-subscription', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.json({ active: false });
    const customers = await stripe.customers.list({ email, limit: 1 });
    if (!customers.data.length) return res.json({ active: false });
    const customerId = customers.data[0].id;
    const subs = await stripe.subscriptions.list({
      customer: customerId,
      limit: 1,
    });
    const sub = subs.data[0];
    const isActive = sub && (sub.status === 'active' || sub.status === 'trialing');
    res.json({
      active: isActive,
      customerId,
      subscriptionId: sub?.id,
      trialing: sub?.status === 'trialing',
      trialEnd: sub?.trial_end,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CUSTOMER PORTAL
app.post('/create-portal-session', async (req, res) => {
  try {
    const { customerId } = req.body;
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: process.env.FRONTEND_URL,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// WEBHOOK
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  switch (event.type) {
    case 'customer.subscription.trial_will_end':
      console.log('⚠️ Trial ending soon:', event.data.object.id);
      break;
    case 'customer.subscription.created':
      console.log('✅ New subscription:', event.data.object.id);
      break;
    case 'customer.subscription.deleted':
      console.log('❌ Subscription cancelled:', event.data.object.id);
      break;
    case 'invoice.payment_failed':
      console.log('💳 Payment failed:', event.data.object.customer);
      break;
    case 'invoice.payment_succeeded':
      console.log('💰 Payment succeeded:', event.data.object.amount_paid / 100);
      break;
  }
  res.json({ received: true });
});

// START + KEEP ALIVE
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🏋️ Vyrra backend running on port ${PORT}`);
  if (process.env.NODE_ENV === 'production' && process.env.RENDER_EXTERNAL_URL) {
    const PING_URL = `${process.env.RENDER_EXTERNAL_URL}/health`;
    setInterval(async () => {
      try { await fetch(PING_URL); } catch {}
    }, 14 * 60 * 1000);
  }
});
