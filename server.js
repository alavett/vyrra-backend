import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
dotenv.config();

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Supabase — service role key so webhook can bypass RLS
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

// Webhook MUST use raw body — register before express.json()
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// =============================================
// HEALTH CHECK
// =============================================
app.get('/health', (_, res) => res.json({ status: 'ok', app: 'Vyrra Fitness' }));

// =============================================
// CREATE CHECKOUT SESSION — 7-day free trial
// Body: { userId, email }
// =============================================
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { userId, email } = req.body;

    // Check if user already has a Stripe customer ID in our DB
    const { data: existing } = await supabase
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', userId)
      .single();

    let customerId = existing?.stripe_customer_id;

    // Create Stripe customer if needed, store userId in metadata
    if (!customerId) {
      const customer = await stripe.customers.create({
        email,
        metadata: { supabase_user_id: userId }
      });
      customerId = customer.id;
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{
        price: process.env.STRIPE_PRICE_ID,
        quantity: 1,
      }],
      subscription_data: {
        trial_period_days: 7,
        metadata: { supabase_user_id: userId },
      },
      success_url: `${process.env.FRONTEND_URL}?activated=true`,
      cancel_url: `${process.env.FRONTEND_URL}?canceled=true`,
      allow_promotion_codes: true,
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// VERIFY SESSION (used after redirect back)
// =============================================
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

// =============================================
// CHECK SUBSCRIPTION BY EMAIL
// =============================================
app.post('/check-subscription', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.json({ active: false });
    const customers = await stripe.customers.list({ email, limit: 1 });
    if (!customers.data.length) return res.json({ active: false });
    const customerId = customers.data[0].id;
    const subs = await stripe.subscriptions.list({ customer: customerId, limit: 1 });
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

// =============================================
// CUSTOMER PORTAL (manage/cancel subscription)
// =============================================
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

// =============================================
// WEBHOOK — writes subscription status to Supabase
// =============================================
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {

      // Trial started — write to subscriptions table
      case 'checkout.session.completed': {
        const session = event.data.object;
        const customerId = session.customer;
        const subscriptionId = session.subscription;
        const userId = await getUserIdByCustomer(customerId);
        if (!userId) break;

        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        await supabase.from('subscriptions').upsert({
          user_id: userId,
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
          status: sub.status,
          trial_end: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
          current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
        }, { onConflict: 'user_id' });

        console.log(`✅ Trial started for user ${userId}`);
        break;
      }

      // Status changed (trial → active, payment failed, etc.)
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const userId = await getUserIdByCustomer(sub.customer);
        if (!userId) break;

        await supabase.from('subscriptions').upsert({
          user_id: userId,
          stripe_customer_id: sub.customer,
          stripe_subscription_id: sub.id,
          status: sub.status,
          trial_end: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
          current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
        }, { onConflict: 'user_id' });

        console.log(`✅ Subscription updated: ${sub.status} for user ${userId}`);
        break;
      }

      // Canceled
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const userId = await getUserIdByCustomer(sub.customer);
        if (!userId) break;

        await supabase.from('subscriptions')
          .update({ status: 'canceled' })
          .eq('user_id', userId);

        console.log(`❌ Subscription canceled for user ${userId}`);
        break;
      }

      case 'customer.subscription.trial_will_end':
        console.log('⚠️ Trial ending soon:', event.data.object.id);
        break;

      case 'invoice.payment_failed':
        console.log('💳 Payment failed:', event.data.object.customer);
        break;

      case 'invoice.payment_succeeded':
        console.log('💰 Payment succeeded:', event.data.object.amount_paid / 100);
        break;
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Helper — get Supabase user ID from Stripe customer metadata
async function getUserIdByCustomer(customerId) {
  try {
    const customer = await stripe.customers.retrieve(customerId);
    // First try metadata
    if (customer.metadata && customer.metadata.supabase_user_id) {
      return customer.metadata.supabase_user_id;
    }
    // Fallback: look up by email using Supabase admin
    if (customer.email) {
      const { data: userData } = await supabase.auth.admin.getUserByEmail(customer.email);
      if (userData && userData.user && userData.user.id) {
        // Update customer metadata for next time
        await stripe.customers.update(customerId, {
          metadata: { supabase_user_id: userData.user.id }
        });
        return userData.user.id;
      }
    }
    return null;
  } catch (err) {
    console.error('getUserIdByCustomer error:', err.message);
    return null;
  }
}

// =============================================
// START SERVER + KEEP RENDER ALIVE
// =============================================
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